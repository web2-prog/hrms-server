/**
 * Import all employees from backend/exports/all_employees_profiles_*.txt
 * (extracted from the PDF export). Creates departments, roles, profile/bank/bond.
 *
 * Note: Many source rows share kriraaiinfotech@gmail.com — login emails are
 * made unique from the name (original kept in profile_details.personal_email).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';
import { connectDB } from '../config/db.js';
import Department from '../models/Department.js';
import Employee from '../models/Employee.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_DIR = path.join(__dirname, '../exports');

const DEPT_DEFAULTS = {
  AI: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:00' },
  Web: { working_hours_per_day: 8.25, shift_start: '09:15', shift_end: '17:30' },
  SEO: { working_hours_per_day: 8.25, shift_start: '10:00', shift_end: '18:30' },
  Sales: { working_hours_per_day: 8.25, shift_start: '09:00', shift_end: '18:00' },
  'Marketing & Sales': { working_hours_per_day: 8.25, shift_start: '09:00', shift_end: '18:00' },
  HR: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:30' },
  Admin: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:30' },
  Engineering: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:30' },
  Design: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:30' },
  IT: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:30' },
  CEO: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:30' },
};

function blank(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s || s === '—' || s === '-' || s === '–') return '';
  return s;
}

function parseDate(raw) {
  const s = blank(raw);
  if (!s) return null;
  // Store as UTC midnight so calendar day does not shift in IST
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, mo, d] = s.split('-').map(Number);
    if (y < 2000) return null;
    return new Date(Date.UTC(y, mo - 1, d));
  }
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (y < 2000) return null;
    return new Date(Date.UTC(y, mo - 1, d));
  }
  return null;
}

function normalizePhone(raw) {
  const s = blank(raw);
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim();
}

const SHARED_LOGIN_EMAILS = new Set(['kriraaiinfotech@gmail.com']);

function normalizeDept(name) {
  const n = blank(name);
  if (!n) return 'IT';
  const key = n.toLowerCase();
  if (key === 'web' || key === 'web ') return 'Web';
  if (key === 'seo') return 'SEO';
  if (key === 'ai') return 'AI';
  if (key === 'hr') return 'HR';
  if (key === 'it') return 'IT';
  if (key === 'design') return 'Design';
  if (key === 'sales executive' || key === 'sales') return 'Sales';
  if (key === 'marketing & sales') return 'Marketing & Sales';
  if (key === 'admin') return 'Admin';
  if (key === 'engineering') return 'Engineering';
  if (key === 'ceo') return 'CEO';
  return n;
}

function normalizeRole(role) {
  const r = blank(role).toLowerCase();
  if (r === 'admin') return 'admin';
  if (r === 'hr') return 'hr';
  return 'employee';
}

function slugName(name) {
  return blank(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 40) || 'user';
}

function fieldAfter(lines, i, label) {
  const line = lines[i];
  if (!line.startsWith(label)) return null;
  return blank(line.slice(label.length));
}

function findExportText() {
  const files = fs
    .readdirSync(EXPORTS_DIR)
    .filter((f) => f.startsWith('all_employees_profiles') && f.endsWith('.txt'))
    .sort()
    .reverse();
  if (!files.length) {
    throw new Error(`No all_employees_profiles*.txt in ${EXPORTS_DIR}. Extract PDF first.`);
  }
  return path.join(EXPORTS_DIR, files[0]);
}

export function parseEmployeesFromText(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = null;

  const startRe = /^(\d+)\.\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('Employee Index')) {
      // skip index section until first detail "1. Name" after page break with User ID
      continue;
    }
    if (line.startsWith('User ID:')) {
      // ensure we have a current block; if not, look back for "N. Name"
      if (!cur) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          const m = lines[j].match(startRe);
          if (m && Number(m[1]) >= 1 && Number(m[1]) <= 200) {
            cur = { index: Number(m[1]), heading: m[2].trim(), lines: [] };
            break;
          }
        }
      }
      if (cur) cur.userId = blank(line.slice('User ID:'.length));
      continue;
    }

    const m = line.match(startRe);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 200 && lines[i + 1]?.startsWith('User ID:')) {
      if (cur) blocks.push(cur);
      cur = { index: Number(m[1]), heading: m[2].trim(), lines: [] };
      continue;
    }

    if (cur) cur.lines.push(line);
  }
  if (cur) blocks.push(cur);

  // Deduplicate by index (keep last complete)
  const byIndex = new Map();
  for (const b of blocks) byIndex.set(b.index, b);

  const employees = [];
  for (const b of [...byIndex.values()].sort((a, c) => a.index - c.index)) {
    const L = b.lines;
    const get = (label) => {
      for (let i = 0; i < L.length; i++) {
        const v = fieldAfter(L, i, label);
        if (v !== null) return v;
      }
      return '';
    };

    let bondStart = '';
    let bondEnd = '';
    let bondType = '';
    let bondMonths = '';
    for (let i = 0; i < L.length; i++) {
      if (L[i].startsWith('startDate:')) bondStart = blank(L[i].slice('startDate:'.length));
      if (L[i].startsWith('endDate:')) bondEnd = blank(L[i].slice('endDate:'.length));
      if (L[i].startsWith('type:') && !bondType) bondType = blank(L[i].slice('type:'.length));
      if (L[i].startsWith('periodMonths:')) bondMonths = blank(L[i].slice('periodMonths:'.length));
    }

    const name = get('Name ') || b.heading;
    const emailRaw = get('Email ').toLowerCase();
    const role = normalizeRole(get('Role '));
    const department = normalizeDept(get('Department '));
    const status = blank(get('Status ')).toLowerCase() === 'inactive' ? 'inactive' : 'active';
    const joining = parseDate(get('Joining Date '));
    const ctc = Number(blank(get('Package (CTC) ')).replace(/,/g, '')) || 0;
    const phone = normalizePhone(get('Mobile Number ')) || normalizePhone(get('Phone '));
    const guardianName = get('Guardian Name ');
    const guardianMobile = normalizePhone(get('Guardian Mobile '));
    const aadhaar = blank(get('Aadhaar Number ')).replace(/\s+/g, '');
    let emergency = '';
    if (guardianName && guardianMobile) emergency = `${guardianName} (${guardianMobile})`;
    else emergency = guardianName || guardianMobile;

    const bank_name = get('Bank Name ');
    const account_holder_name = get('Account Holder ');
    const account_number = get('Account Number ');
    const ifsc_code = get('IFSC Code ');

    const checkIn = get('Default Check-In ');
    const checkOut = get('Default Check-Out ');

    let bond_start_date = parseDate(bondStart);
    let bond_end_date = parseDate(bondEnd);
    if (!bond_end_date && bond_start_date && bondMonths) {
      const end = new Date(bond_start_date);
      end.setUTCMonth(end.getUTCMonth() + Number(bondMonths));
      bond_end_date = end;
    }

    employees.push({
      index: b.index,
      legacy_user_id: b.userId || '',
      name,
      email_raw: emailRaw,
      role,
      department,
      status,
      joining_date: joining,
      base_salary: ctc > 0 ? Math.round(ctc / 12) : 0,
      ctc,
      phone,
      aadhaar_number: aadhaar,
      emergency_contact: emergency,
      bank_details: {
        bank_name,
        account_holder_name,
        account_number,
        ifsc_code,
        tax_id: '',
      },
      bond_details: {
        bond_start_date,
        bond_end_date,
        bond_amount: 0,
        bond_status: bond_start_date ? 'Active' : '',
        bond_type: bondType || '',
      },
      custom_shift_start: checkIn || null,
      custom_shift_end: checkOut || null,
      custom_working_hours_per_day: null,
    });
  }

  return employees;
}

function assignUniqueEmails(employees) {
  const used = new Set();
  for (const e of employees) {
    let email = e.email_raw;
    const shared = !email || email === 'kriraaiinfotech@gmail.com';
    if (shared) {
      email = `${slugName(e.name)}@krira.ai`;
    }
    let base = email;
    let n = 2;
    while (used.has(email)) {
      const [local, domain] = base.split('@');
      email = `${local}${n}@${domain || 'krira.ai'}`;
      n += 1;
    }
    used.add(email);
    e.email = email;
    // Shared company mailbox is not a personal email
    if (
      e.email_raw &&
      !SHARED_LOGIN_EMAILS.has(e.email_raw) &&
      e.email_raw !== email
    ) {
      e.personal_email = e.email_raw;
    } else {
      e.personal_email = '';
    }
  }
}

function defaultPassword(role) {
  return 'hrms@123';
}

/** Placeholder / QA accounts from the legacy export — do not import. */
export function isTestEmployee(e) {
  const name = blank(e.name).toLowerCase();
  const email = blank(e.email || e.email_raw).toLowerCase();
  const testNames = new Set([
    'test',
    'het',
    'jamin',
    'john',
    'priti',
    'rahul',
    'raj',
    'rajkumar',
    'ujaval',
    'vandit',
    'charlie dev',
    'secondary admin',
    'test admin',
    'kaushik vaghasiya2',
  ]);
  if (testNames.has(name)) return true;
  if (name === 'admin' && e.status === 'inactive') return true;
  if (name === 'hr' && e.status === 'inactive') return true;
  if (email.includes('@example.com') || email.includes('@test.com')) return true;
  if (/^test\d*@/.test(email)) return true;
  return false;
}

async function ensureDepartments(names) {
  const map = {};
  for (const name of names) {
    const defaults = DEPT_DEFAULTS[name] || {
      working_hours_per_day: 8.25,
      shift_start: '09:30',
      shift_end: '18:30',
    };
    map[name] = await Department.findOneAndUpdate(
      { name },
      { name, ...defaults, status: 'active' },
      { upsert: true, new: true }
    );
  }
  return map;
}

async function main() {
  const txtPath = findExportText();
  const text = fs.readFileSync(txtPath, 'utf8');
  const parsed = parseEmployeesFromText(text);
  assignUniqueEmails(parsed);
  const skipped = parsed.filter(isTestEmployee);
  const employees = parsed.filter((e) => !isTestEmployee(e));
  console.log(`Parsed ${parsed.length}, keeping ${employees.length}, skipping ${skipped.length} test accounts`);

  // Write JSON snapshot for audit (real employees only)
  const jsonPath = path.join(EXPORTS_DIR, 'employees_seed_data.json');
  fs.writeFileSync(jsonPath, JSON.stringify(employees, null, 2));

  await connectDB();

  const deptNames = [...new Set(employees.map((e) => e.department))];
  const steps = employees.length + 3;
  const bar = new cliProgress.SingleBar({
    format: 'Import employees |{bar}| {percentage}% | {value}/{total} | {step}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
  });
  bar.start(steps, 0, { step: 'departments' });

  const deptMap = await ensureDepartments(deptNames);
  bar.increment({ step: 'departments' });

  // Drop previously imported test / placeholder accounts
  const testIds = skipped.map((e) => `EMP-2026-${String(e.index).padStart(4, '0')}`);
  const testEmails = skipped.map((e) => e.email).filter(Boolean);
  const del = await Employee.deleteMany({
    $or: [
      ...(testIds.length ? [{ employee_id: { $in: testIds } }] : []),
      ...(testEmails.length ? [{ email: { $in: testEmails } }] : []),
      { name: { $in: ['test', 'het', 'jamin', 'john', 'priti', 'rahul', 'raj', 'rajkumar', 'ujaval', 'vandit', 'Charlie Dev', 'Secondary Admin', 'Test Admin', 'Kaushik Vaghasiya2'] } },
      { email: /@(example|test)\.com$/i },
      { email: /^test\d*@/i },
    ],
  });
  bar.increment({ step: `removed_test:${del.deletedCount}` });
  bar.increment({ step: 'ready' });

  let created = 0;
  let updated = 0;
  for (const e of employees) {
    const employee_id = `EMP-2026-${String(e.index).padStart(4, '0')}`;
    const payload = {
      employee_id,
      name: e.name,
      email: e.email,
      phone: e.phone,
      password: defaultPassword(e.role),
      department_id: deptMap[e.department]._id,
      role: e.role,
      joining_date: e.joining_date,
      status: e.status,
      base_salary: e.base_salary,
      custom_shift_start: e.custom_shift_start,
      custom_shift_end: e.custom_shift_end,
      custom_working_hours_per_day: e.custom_working_hours_per_day,
      profile_details: {
        address: '',
        dob: null,
        gender: '',
        emergency_contact: e.emergency_contact,
        personal_email: e.personal_email,
        aadhaar_number: e.aadhaar_number || '',
      },
      bank_details: e.bank_details,
      bond_details: {
        bond_start_date: e.bond_details.bond_start_date,
        bond_end_date: e.bond_details.bond_end_date,
        bond_amount: e.bond_details.bond_amount,
        bond_status: e.bond_details.bond_status,
      },
    };

    let existing = await Employee.findOne({ employee_id }).select('+password');
    if (!existing) existing = await Employee.findOne({ email: e.email }).select('+password');

    if (existing) {
      existing.employee_id = employee_id;
      existing.name = payload.name;
      existing.email = payload.email;
      existing.phone = payload.phone;
      existing.password = payload.password;
      existing.department_id = payload.department_id;
      existing.role = payload.role;
      existing.joining_date = payload.joining_date;
      existing.status = payload.status;
      existing.base_salary = payload.base_salary;
      existing.custom_shift_start = payload.custom_shift_start;
      existing.custom_shift_end = payload.custom_shift_end;
      existing.custom_working_hours_per_day = payload.custom_working_hours_per_day;
      existing.profile_details = payload.profile_details;
      existing.bank_details = payload.bank_details;
      existing.bond_details = payload.bond_details;
      await existing.save();
      updated += 1;
    } else {
      await Employee.create(payload);
      created += 1;
    }
    bar.increment({ step: employee_id });
  }

  bar.stop();

  const total = await Employee.countDocuments();
  const byRole = await Employee.aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }]);
  const byDept = await Employee.aggregate([
    { $lookup: { from: 'departments', localField: 'department_id', foreignField: '_id', as: 'd' } },
    { $unwind: { path: '$d', preserveNullAndEmptyArrays: true } },
    { $group: { _id: '$d.name', n: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  console.log(`\nSource: ${path.basename(txtPath)}`);
  console.log(`Parsed: ${employees.length} | Created: ${created} | Updated: ${updated} | DB total: ${total}`);
  console.log('Roles:', byRole.map((r) => `${r._id}:${r.n}`).join(', '));
  console.log('Departments:', byDept.map((d) => `${d._id || 'none'}:${d.n}`).join(', '));
  console.log('\nDefault password for all roles: hrms@123');
  console.log('Login emails are unique (name@krira.ai when source shared kriraaiinfotech@gmail.com).');
  console.log(`JSON snapshot: ${jsonPath}`);

  const samples = employees.filter((e) => e.status === 'active').slice(0, 8);
  console.log('\nSample active logins:');
  for (const s of samples) {
    console.log(`  ${s.role.padEnd(8)} ${s.email.padEnd(40)} ${s.name} (${s.department})`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
