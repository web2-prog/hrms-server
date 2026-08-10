/**
 * Set all departments to company standard 8h 15m (8.25) daily working hours.
 */
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';
import { connectDB } from '../config/db.js';
import Department from '../models/Department.js';

dotenv.config();

async function main() {
  await connectDB();
  const depts = await Department.find({});
  const bar = new cliProgress.SingleBar({
    format: 'Update depts |{bar}| {percentage}% | {value}/{total}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
  });
  bar.start(depts.length || 1, 0);
  for (const d of depts) {
    d.working_hours_per_day = 8.25;
    await d.save();
    bar.increment();
  }
  if (!depts.length) bar.update(1);
  bar.stop();
  console.log(`\nUpdated ${depts.length} department(s) to 8.25h/day (8h 15m).`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
