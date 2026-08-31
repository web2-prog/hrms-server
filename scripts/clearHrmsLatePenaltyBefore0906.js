/**
 * Clear late-check-in penalty in legacy `hrms` for August (and optional range)
 * when check-in (Asia/Kolkata) is before 09:06:00.
 *
 * For each matching row:
 *   - lateCheckIn → false
 *   - add penaltySeconds back into totalWorkedSeconds
 *   - penaltySeconds → 0
 *   - isPenaltyDisabled → true (matches waived pattern in legacy data)
 *
 * Usage: node scripts/clearHrmsLatePenaltyBefore0906.js
 */
import dns from 'dns';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();
try {
  dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()]);
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

const TZ = 'Asia/Kolkata';
const FROM = process.env.FROM || '2026-08-01';
const TO = process.env.TO || '2026-08-31';
const CUTOFF_HMS = '09:06:00'; // first second that stays late (through 09:05:59 OK)
const NEW_LATE_PENALTY_START = '09:06'; // systemsettings.latePenaltyStartTime
const DAILY_TARGET_SECONDS = 29700; // 8h 15m — matches UI shortfall math
const DRY_RUN = process.env.DRY_RUN === '1';

function istParts(d) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hms: `${get('hour')}:${get('minute')}:${get('second')}`.replace(/^24:/, '00:'),
  };
}

function hmsToSec(hms) {
  const [h, m, s] = String(hms).split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

function parseCheckIn(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI required');

  const conn = await mongoose.createConnection(uri, { dbName: 'hrms', family: 4 }).asPromise();
  const col = conn.db.collection('attendances');
  const settings = conn.db.collection('systemsettings');
  const cutoffSec = hmsToSec(CUTOFF_HMS);

  const prevSettings = await settings.findOne({});
  console.log('Current latePenaltyStartTime:', prevSettings?.latePenaltyStartTime);
  if (!DRY_RUN) {
    await settings.updateOne(
      {},
      { $set: { latePenaltyStartTime: NEW_LATE_PENALTY_START, updatedAt: new Date() } }
    );
    console.log(`Updated latePenaltyStartTime → ${NEW_LATE_PENALTY_START}`);
  } else {
    console.log(`[DRY RUN] would set latePenaltyStartTime → ${NEW_LATE_PENALTY_START}`);
  }

  const rows = await col
    .find({
      date: { $gte: FROM, $lte: TO },
      checkIn: { $ne: null },
      penaltySeconds: { $gt: 0 },
    })
    .toArray();

  console.log(`Scanning ${rows.length} rows with penaltySeconds > 0 (${FROM}..${TO})${DRY_RUN ? ' [DRY RUN]' : ''}`);

  let cleared = 0;
  let kept = 0;
  const samples = [];

  for (const r of rows) {
    const cin = parseCheckIn(r.checkIn);
    if (!cin) {
      kept += 1;
      continue;
    }
    const { hms } = istParts(cin);
    const checkSec = hmsToSec(hms);
    if (checkSec >= cutoffSec) {
      kept += 1;
      continue;
    }

    const penalty = Number(r.penaltySeconds) || 0;
    const prevWorked = Number(r.totalWorkedSeconds) || 0;
    // Open day with zero worked: only clear penalty flags (live clock recomputes hours)
    const hasCheckout = !!r.checkOut;
    const nextWorked = hasCheckout || prevWorked > 0 ? prevWorked + penalty : prevWorked;
    const lowTimeFlag = hasCheckout ? nextWorked < DAILY_TARGET_SECONDS : !!r.lowTimeFlag;
    const extraTimeFlag = hasCheckout ? nextWorked > DAILY_TARGET_SECONDS : !!r.extraTimeFlag;

    const update = {
      penaltySeconds: 0,
      lateCheckIn: false,
      isPenaltyDisabled: true,
      totalWorkedSeconds: nextWorked,
      lowTimeFlag,
      extraTimeFlag,
      updatedAt: new Date(),
    };

    if (!DRY_RUN) {
      await col.updateOne({ _id: r._id }, { $set: update });
    }
    cleared += 1;
    if (samples.length < 20) {
      samples.push({
        date: r.date,
        userId: String(r.userId),
        checkInIST: hms,
        penaltyRemoved: penalty,
        workedBefore: Math.round(prevWorked),
        workedAfter: Math.round(nextWorked),
        lowTimeFlag,
        extraTimeFlag,
      });
    }
  }

  // Verify Khyati
  const khyati = await conn.db.collection('users').findOne({ name: /Khyati/i });
  const khRows = await col
    .find({ userId: khyati._id, date: { $gte: FROM, $lte: TO } })
    .sort({ date: -1 })
    .limit(10)
    .toArray();

  console.log('\n=== Result ===');
  console.log({ cleared, kept_late_after_cutoff: kept, dry_run: DRY_RUN });
  console.log('Samples:', JSON.stringify(samples, null, 2));

  console.log('\nKhyati after update:');
  for (const r of khRows) {
    const cin = parseCheckIn(r.checkIn);
    const hms = cin ? istParts(cin).hms : null;
    console.log({
      date: r.date,
      checkInIST: hms,
      penaltySeconds: r.penaltySeconds,
      lateCheckIn: r.lateCheckIn,
      isPenaltyDisabled: r.isPenaltyDisabled,
      totalWorkedSeconds: r.totalWorkedSeconds,
    });
  }

  await conn.close();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
