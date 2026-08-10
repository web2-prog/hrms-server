/**
 * Migrates holidays_saturday / holidays_festival / holidays_vacation
 * into a single `holidays` collection with a `type` field, then drops the old collections.
 */
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import Holiday from '../models/Holiday.js';
import { seedHolidays2026 } from './seed.js';

dotenv.config();

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  const bar = new cliProgress.SingleBar({
    format: 'Migrate holidays |{bar}| {percentage}% | {value}/{total} | {step}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
  });
  const steps = ['read_old', 'write_unified', 'seed_2026', 'drop_old'];
  bar.start(steps.length, 0, { step: 'start' });

  const oldNames = ['holidays_saturday', 'holidays_festival', 'holidays_vacation'];
  const existing = await db.listCollections().toArray();
  const existingNames = new Set(existing.map((c) => c.name));

  const migrated = [];
  for (const name of oldNames) {
    if (!existingNames.has(name)) continue;
    const rows = await db.collection(name).find({}).toArray();
    for (const r of rows) {
      if (name === 'holidays_saturday') {
        migrated.push({
          type: 'Saturday',
          name: 'Alternate Saturday',
          date: r.date,
          month: r.month,
          year: r.year,
        });
      } else if (name === 'holidays_festival') {
        const d = r.date ? new Date(r.date + 'T00:00:00') : null;
        migrated.push({
          type: 'Festival',
          name: r.name,
          date: r.date,
          day: r.day || '',
          month: d ? d.getMonth() + 1 : null,
          year: r.year,
        });
      } else {
        migrated.push({
          type: 'Vacation',
          name: r.name,
          start_date: r.start_date,
          end_date: r.end_date,
          year: r.year,
        });
      }
    }
  }
  bar.increment({ step: 'read_old' });

  await Holiday.deleteMany({});
  if (migrated.length) {
    // Prefer official 2026 seed over partial old rows for that year
    const non2026 = migrated.filter((m) => m.year !== 2026);
    if (non2026.length) await Holiday.insertMany(non2026);
  }
  bar.increment({ step: 'write_unified' });

  const counts = await seedHolidays2026();
  bar.increment({ step: 'seed_2026' });

  for (const name of oldNames) {
    if (existingNames.has(name)) await db.dropCollection(name);
  }
  bar.increment({ step: 'drop_old' });
  bar.stop();

  const total = await Holiday.countDocuments();
  console.log(`\nUnified holidays collection ready (${total} docs).`);
  console.log(
    `2026: ${counts.saturdays} Saturdays, ${counts.festivals} festivals, ${counts.vacations} vacation(s)`
  );
  console.log('Dropped old collections: holidays_saturday, holidays_festival, holidays_vacation');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
