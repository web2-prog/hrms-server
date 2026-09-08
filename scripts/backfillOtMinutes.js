/**
 * Backfill overtime_requests.minutes and cover_time requested/actual minutes
 * from existing decimal hours. Safe to re-run.
 *
 * Usage: node backend/scripts/backfillOtMinutes.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import OvertimeRequest from '../models/OvertimeRequest.js';
import CoverTimeRequest from '../models/CoverTimeRequest.js';
import { hoursToMinutes } from '../utils/helpers.js';

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) {
  console.error('MONGODB_URI missing');
  process.exit(1);
}

async function main() {
  await mongoose.connect(uri);
  const ot = await OvertimeRequest.find({
    $or: [{ minutes: { $exists: false } }, { minutes: null }],
  }).select('_id hours minutes');
  let otUpdated = 0;
  for (const doc of ot) {
    doc.minutes = hoursToMinutes(doc.hours);
    await doc.save();
    otUpdated += 1;
    if (otUpdated % 50 === 0) process.stdout.write(`\rOT backfill ${otUpdated}/${ot.length}`);
  }
  if (ot.length) process.stdout.write(`\rOT backfill ${otUpdated}/${ot.length}\n`);
  else console.log('OT: nothing to backfill');

  const covers = await CoverTimeRequest.find({
    $or: [
      { requested_minutes: { $exists: false } },
      { requested_minutes: null },
      { actual_cover_minutes: { $exists: false } },
      { actual_cover_minutes: null },
    ],
  }).select('_id requested_hours actual_cover_hours requested_minutes actual_cover_minutes');
  let coverUpdated = 0;
  for (const doc of covers) {
    doc.requested_minutes = hoursToMinutes(doc.requested_hours);
    doc.actual_cover_minutes = hoursToMinutes(doc.actual_cover_hours || 0);
    await doc.save();
    coverUpdated += 1;
    if (coverUpdated % 50 === 0) process.stdout.write(`\rCover backfill ${coverUpdated}/${covers.length}`);
  }
  if (covers.length) process.stdout.write(`\rCover backfill ${coverUpdated}/${covers.length}\n`);
  else console.log('Cover: nothing to backfill');

  console.log(`Done. OT updated=${otUpdated}, Cover updated=${coverUpdated}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
