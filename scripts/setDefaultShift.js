import dotenv from 'dotenv';
import { connectDB } from '../config/db.js';
import Department from '../models/Department.js';
import Employee from '../models/Employee.js';

dotenv.config();

/**
 * Set the company-wide default shift for every department:
 *   - check-in   08:45
 *   - check-out  17:30
 *   - workday    8h 15m (8.25h)
 * and clear any per-employee custom shift overrides so every employee
 * actually uses the department default.
 */
const SHIFT_START = '08:45';
const SHIFT_END = '17:30';
const HOURS_PER_DAY = 8.25;

async function main() {
  await connectDB();

  const deptRes = await Department.updateMany(
    {},
    {
      $set: {
        shift_start: SHIFT_START,
        shift_end: SHIFT_END,
        working_hours_per_day: HOURS_PER_DAY,
      },
    }
  );
  console.log(
    `Departments updated: ${deptRes.modifiedCount} (matched ${deptRes.matchedCount}) → ${SHIFT_START} – ${SHIFT_END}, ${HOURS_PER_DAY}h/day`
  );

  // Remove custom shift overrides so everyone falls back to the department default.
  const empRes = await Employee.updateMany(
    {
      $or: [
        { custom_shift_start: { $ne: null } },
        { custom_shift_end: { $ne: null } },
        { custom_working_hours_per_day: { $ne: null } },
      ],
    },
    {
      $set: {
        custom_shift_start: null,
        custom_shift_end: null,
        custom_working_hours_per_day: null,
      },
    }
  );
  console.log(`Custom shift overrides cleared: ${empRes.modifiedCount} employee(s)`);

  const depts = await Department.find({}).select('name shift_start shift_end working_hours_per_day').sort({ name: 1 }).lean();
  console.log('\nNow in effect per department:');
  for (const d of depts) {
    console.log(`  ${d.name}: ${d.shift_start} – ${d.shift_end} · ${d.working_hours_per_day}h/day`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
