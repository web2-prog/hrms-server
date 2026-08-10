/**
 * Remove employees who have zero check-in/check-out attendance data.
 * Also cleans related leaves, monthly summaries, salary slips, attendance placeholders, audit logs.
 *
 * Usage: node scripts/removeEmployeesWithNoAttendance.js [--dry-run]
 */
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';
import { connectDB } from '../config/db.js';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import MonthlySummary from '../models/MonthlySummary.js';
import SalarySlip from '../models/SalarySlip.js';
import AuditLog from '../models/AuditLog.js';

dotenv.config();

const dryRun = process.argv.includes('--dry-run');

async function main() {
  await connectDB();

  const employees = await Employee.find({})
    .select('_id name email employee_id role status')
    .sort({ name: 1 })
    .lean();

  const withCheckIn = await Attendance.aggregate([
    { $match: { check_in: { $ne: null } } },
    { $group: { _id: '$employee_id', days: { $sum: 1 } } },
  ]);
  const attMap = new Map(withCheckIn.map((a) => [String(a._id), a.days]));

  // Keep admin accounts even with no attendance (system access)
  const zeroAtt = employees.filter((e) => !(attMap.get(String(e._id)) || 0));
  const preservedAdmins = zeroAtt.filter((e) => e.role === 'admin');
  const toRemove = zeroAtt.filter((e) => e.role !== 'admin');
  const keep = employees.length - toRemove.length;

  console.log(`Total employees: ${employees.length}`);
  console.log(`With check-in data: ${employees.length - zeroAtt.length}`);
  console.log(`Zero attendance (all): ${zeroAtt.length}`);
  console.log(`Preserving admins: ${preservedAdmins.length}`);
  console.log(`To remove: ${toRemove.length}`);
  if (preservedAdmins.length) {
    console.log('\nPreserved (admin, no attendance):');
    for (const e of preservedAdmins) {
      console.log(`  ${e.role.padEnd(8)} ${e.employee_id}  ${e.name}  <${e.email}>`);
    }
  }
  console.log(dryRun ? '\n[DRY RUN — no deletes]\n' : '\nRemoving…\n');

  for (const e of toRemove) {
    console.log(`  ${e.role.padEnd(8)} ${e.employee_id}  ${e.name}  <${e.email}>`);
  }

  if (!toRemove.length) {
    console.log('Nothing to remove.');
    process.exit(0);
  }

  if (dryRun) {
    process.exit(0);
  }

  const ids = toRemove.map((e) => e._id);
  const steps = [
    'attendance',
    'leaves',
    'monthly_summary',
    'salary_slips',
    'audit_logs',
    'employees',
  ];
  const bar = new cliProgress.SingleBar(
    {
      format: 'Cleanup |{bar}| {percentage}% | {value}/{total} | {step}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(steps.length, 0, { step: 'start' });

  const att = await Attendance.deleteMany({ employee_id: { $in: ids } });
  bar.increment({ step: `attendance:${att.deletedCount}` });

  const leaves = await Leave.deleteMany({ employee_id: { $in: ids } });
  bar.increment({ step: `leaves:${leaves.deletedCount}` });

  const ms = await MonthlySummary.deleteMany({ employee_id: { $in: ids } });
  bar.increment({ step: `monthly_summary:${ms.deletedCount}` });

  const slips = await SalarySlip.deleteMany({ employee_id: { $in: ids } });
  bar.increment({ step: `salary_slips:${slips.deletedCount}` });

  const audits = await AuditLog.deleteMany({
    $or: [{ performed_by: { $in: ids } }, { target_employee_id: { $in: ids } }],
  });
  bar.increment({ step: `audit_logs:${audits.deletedCount}` });

  const emps = await Employee.deleteMany({ _id: { $in: ids } });
  bar.increment({ step: `employees:${emps.deletedCount}` });
  bar.stop();

  const remaining = await Employee.countDocuments();
  const remainingAtt = await Attendance.countDocuments({ check_in: { $ne: null } });

  console.log('\n--- Done ---');
  console.log(`Employees deleted:     ${emps.deletedCount}`);
  console.log(`Attendance deleted:    ${att.deletedCount}`);
  console.log(`Leaves deleted:        ${leaves.deletedCount}`);
  console.log(`Monthly summaries:     ${ms.deletedCount}`);
  console.log(`Salary slips:          ${slips.deletedCount}`);
  console.log(`Audit logs:            ${audits.deletedCount}`);
  console.log(`Employees remaining:   ${remaining}`);
  console.log(`Attendance with check-in remaining: ${remainingAtt}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
