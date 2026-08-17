import dotenv from 'dotenv';
import cliProgress from 'cli-progress';
import { connectDB } from '../config/db.js';
import Department from '../models/Department.js';
import Employee from '../models/Employee.js';
import SystemSettings from '../models/SystemSettings.js';
import Holiday from '../models/Holiday.js';

dotenv.config();

const depts = [
  { name: 'AI', working_hours_per_day: 8.25, shift_start: '08:45', shift_end: '17:30', late_buffer_minutes: 20, status: 'active' },
  { name: 'Web', working_hours_per_day: 8.25, shift_start: '08:45', shift_end: '17:30', late_buffer_minutes: 20, status: 'active' },
  { name: 'SEO', working_hours_per_day: 8.25, shift_start: '08:45', shift_end: '17:30', late_buffer_minutes: 20, status: 'active' },
  { name: 'Sales', working_hours_per_day: 8.25, shift_start: '08:45', shift_end: '17:30', late_buffer_minutes: 20, status: 'active' },
];

/** Official 2026 Alternate Saturday Off dates */
const SATURDAYS_2026 = [
  '2026-03-21', '2026-03-28',
  '2026-04-11', '2026-04-25',
  '2026-05-09', '2026-05-23',
  '2026-06-13', '2026-06-27',
  '2026-07-11', '2026-07-25',
  '2026-08-01', '2026-08-15',
  '2026-09-05', '2026-09-19',
  '2026-10-10', '2026-10-24',
  '2026-11-07', '2026-11-14',
  '2026-12-12', '2026-12-26',
];

/** Official 2026 Festival & National Holidays */
const FESTIVALS_2026 = [
  { name: 'Uttarayan', date: '2026-01-14', day: 'Wednesday' },
  { name: 'Vasi Uttarayan', date: '2026-01-15', day: 'Thursday' },
  { name: 'Republic Day', date: '2026-01-26', day: 'Monday' },
  { name: 'Holi (Holika Dahan)', date: '2026-03-03', day: 'Tuesday' },
  { name: 'Dhuleti', date: '2026-03-04', day: 'Wednesday' },
  { name: 'Rakshabandhan', date: '2026-08-28', day: 'Friday' },
  { name: 'Janmashtami', date: '2026-09-04', day: 'Friday' },
  { name: 'Ganesh Visarjan', date: '2026-09-25', day: 'Friday' },
];

/** Official 2026 vacations */
const VACATIONS_2026 = [
  { name: 'Diwali Vacation', start_date: '2026-11-07', end_date: '2026-11-15', year: 2026 },
];

export async function seedHolidays2026() {
  await Holiday.deleteMany({ year: 2026 });

  const docs = [];
  for (const date of SATURDAYS_2026) {
    const d = new Date(date + 'T00:00:00');
    docs.push({
      type: 'Saturday',
      name: 'Alternate Saturday',
      date,
      month: d.getMonth() + 1,
      year: 2026,
    });
  }
  for (const f of FESTIVALS_2026) {
    const d = new Date(f.date + 'T00:00:00');
    docs.push({
      type: 'Festival',
      name: f.name,
      date: f.date,
      day: f.day,
      month: d.getMonth() + 1,
      year: 2026,
    });
  }
  for (const v of VACATIONS_2026) {
    docs.push({
      type: 'Vacation',
      name: v.name,
      start_date: v.start_date,
      end_date: v.end_date,
      year: v.year,
    });
  }

  if (docs.length) await Holiday.insertMany(docs);

  return {
    saturdays: SATURDAYS_2026.length,
    festivals: FESTIVALS_2026.length,
    vacations: VACATIONS_2026.length,
  };
}

async function seed() {
  await connectDB();
  const steps = ['settings', 'departments', 'users', 'holidays_2026'];
  const bar = new cliProgress.SingleBar({
    format: 'Seeding |{bar}| {percentage}% | {value}/{total} | {step}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
  });
  bar.start(steps.length, 0, { step: 'start' });

  await SystemSettings.findOneAndUpdate({ key: 'global' }, { overtime_multiplier: 1.5, deduction_multiplier: 1 }, { upsert: true });
  bar.increment({ step: 'settings' });

  const deptDocs = {};
  for (const d of depts) {
    deptDocs[d.name] = await Department.findOneAndUpdate({ name: d.name }, d, { upsert: true, new: true });
  }
  bar.increment({ step: 'departments' });

  const users = [
    { name: 'System Admin', email: 'admin@hrms.local', password: 'hrms@123', role: 'admin', department_id: deptDocs.AI._id, employee_id: 'EMP-2026-0001', base_salary: 80000, joining_date: new Date('2026-01-01') },
    { name: 'HR Manager', email: 'hr@hrms.local', password: 'hrms@123', role: 'hr', department_id: deptDocs.Web._id, employee_id: 'EMP-2026-0002', base_salary: 60000, joining_date: new Date('2026-01-01') },
    { name: 'Demo Employee', email: 'employee@hrms.local', password: 'hrms@123', role: 'employee', department_id: deptDocs.Web._id, employee_id: 'EMP-2026-0003', base_salary: 40000, joining_date: new Date('2026-01-15') },
  ];

  for (const u of users) {
    const existing = await Employee.findOne({ email: u.email }).select('+password');
    if (existing) {
      existing.name = u.name;
      existing.role = u.role;
      existing.department_id = u.department_id;
      existing.base_salary = u.base_salary;
      existing.status = 'active';
      existing.password = u.password;
      await existing.save();
    } else {
      await Employee.create(u);
    }
  }
  bar.increment({ step: 'users' });

  const counts = await seedHolidays2026();
  bar.increment({ step: 'holidays_2026' });

  bar.stop();
  console.log('\nSeed complete. Logins:');
  console.log('  admin@hrms.local / hrms@123');
  console.log('  hr@hrms.local / hrms@123');
  console.log('  employee@hrms.local / hrms@123');
  console.log(`\n2026 holidays: ${counts.saturdays} alternate Saturdays, ${counts.festivals} festivals, ${counts.vacations} vacation(s)`);
  process.exit(0);
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('seed.js') || process.argv[1].endsWith('seed'));

if (isDirectRun) {
  seed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
