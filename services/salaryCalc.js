import SystemSettings from '../models/SystemSettings.js';
import MonthlySummary from '../models/MonthlySummary.js';
import Employee from '../models/Employee.js';
import Leave from '../models/Leave.js';
import Attendance from '../models/Attendance.js';
import { recalculateMonthlySummary } from './monthlyHours.js';
import {
  getSalaryDeductionBond,
  resolveMonthlySalary,
  resolveSalaryDeductionPercent,
} from './salarySchedule.js';
import { getWorkingDaysInMonth } from './workingDays.js';
import { getEffectiveShiftForEmployee } from './shift.js';
import { datesInRange, minutesBetween } from '../utils/helpers.js';

export const SALARY_COMPANIES = {
  kriraai: {
    key: 'kriraai',
    companyName: 'KriraAI Pvt. Ltd.',
    companyAddress:
      'C2-1310, Pragati IT Park, opp. AR Mall, Mota Varachha Road, Uttran, Surat',
  },
  ondial: {
    key: 'ondial',
    companyName: 'Ondial Pvt. Ltd.',
    companyAddress:
      'C2-1310, Pragati IT Park, opp. AR Mall, Mota Varachha Road, Uttran, Surat',
  },
};

export async function getSettings() {
  let s = await SystemSettings.findOne({ key: 'global' });
  if (!s) s = await SystemSettings.create({ key: 'global' });
  return s;
}

function daysInMonth(month, year) {
  return new Date(year, month, 0).getDate();
}

function formatPayDate(month, year) {
  const last = daysInMonth(month, year);
  return `${String(last).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

const STRING_OVERRIDE_FIELDS = new Set(['pay_date', 'pf_no', 'uan']);

/** Money / display fields HR/Admin may override on a draft slip. */
export const SALARY_OVERRIDE_FIELDS = [
  'base_salary',
  'overtime_amount',
  'overtime_hours',
  'deduction_amount',
  'leave_deduction_amount',
  'early_checkout_deduction_amount',
  'bond_security_deduction',
  'bond_security_percent',
  'tds',
  'paid_days',
  'leave_days',
  'lop_days',
  'pay_date',
  'pf_no',
  'uan',
];

export function sanitizeLineItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      label: String(item?.label || '').trim().slice(0, 80),
      amount: round2(item?.amount),
    }))
    .filter((item) => item.label && item.amount !== 0);
}

export function pickSalaryOverrides(source = {}) {
  const overrides = {};
  for (const key of SALARY_OVERRIDE_FIELDS) {
    if (source[key] === undefined || source[key] === null) continue;
    if (STRING_OVERRIDE_FIELDS.has(key)) {
      const value = String(source[key]).trim();
      if (!value) continue;
      overrides[key] = value;
      continue;
    }
    if (source[key] === '') continue;
    const num = Number(source[key]);
    if (!Number.isFinite(num)) continue;
    overrides[key] = round2(num);
  }
  return overrides;
}

export function customLinesTotal(items) {
  return round2((items || []).reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
}

export function computeSlipNetPay(parts) {
  return round2(
    (Number(parts.base_salary) || 0) +
      (Number(parts.overtime_amount) || 0) +
      customLinesTotal(parts.custom_earnings) -
      (Number(parts.deduction_amount) || 0) -
      (Number(parts.leave_deduction_amount) || 0) -
      (Number(parts.early_checkout_deduction_amount) || 0) -
      (Number(parts.bond_security_deduction) || 0) -
      (Number(parts.tds) || 0) -
      customLinesTotal(parts.custom_deductions)
  );
}

export function applySalaryAdjustments(draft, overrides = {}, extras = {}) {
  const next = { ...draft };
  const applied = pickSalaryOverrides(overrides);
  for (const [key, value] of Object.entries(applied)) {
    next[key] = value;
  }
  next.custom_earnings = sanitizeLineItems(
    extras.custom_earnings !== undefined ? extras.custom_earnings : draft.custom_earnings
  );
  next.custom_deductions = sanitizeLineItems(
    extras.custom_deductions !== undefined ? extras.custom_deductions : draft.custom_deductions
  );
  next.net_pay = computeSlipNetPay(next);
  return { values: next, overrides: applied };
}

/** Re-apply stored HR overrides + custom lines on top of a fresh auto-calc. */
export function mergeSalaryDraft(draft, existing, body = {}) {
  const overrides = {
    ...(existing?.overrides && typeof existing.overrides === 'object' ? existing.overrides : {}),
    ...pickSalaryOverrides(body),
  };
  return applySalaryAdjustments(draft, overrides, {
    custom_earnings: body.custom_earnings ?? existing?.custom_earnings,
    custom_deductions: body.custom_deductions ?? existing?.custom_deductions,
  });
}

export function toPersistedSlipFields(values) {
  const { pending_hours, carried_forward_hours, needs_shortfall_decision, ...slipFields } = values;
  if (!slipFields.shortfall_action) delete slipFields.shortfall_action;
  return { slipFields, pending_hours, carried_forward_hours, needs_shortfall_decision };
}

/**
 * Unpaid / LOP leave days in month from Approved leaves.
 * Half-day unpaid = 0.5 when reason or day_type mentions Half.
 */
async function computeLopDays(employeeId, month, year) {
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const monthStart = `${monthPrefix}-01`;
  const monthEnd = `${monthPrefix}-${String(daysInMonth(month, year)).padStart(2, '0')}`;

  const leaves = await Leave.find({
    employee_id: employeeId,
    status: 'Approved',
    from_date: { $lte: monthEnd },
    to_date: { $gte: monthStart },
  }).lean();

  // Only working days are paid, so only they can be deducted as LOP.
  // Weekends/holidays inside an unpaid leave must not be charged (they are
  // non-working days the employee is not paid for anyway).
  const { working_dates } = await getWorkingDaysInMonth(year, month);
  const workingSet = new Set(working_dates);

  let lop = 0;
  for (const lv of leaves) {
    const reason = String(lv.reason || '');
    const dayType = String(lv.day_type || '');
    const isUnpaid = /unpaid|loss\s*of\s*pay|\blop\b/i.test(reason) || /unpaid|lop/i.test(dayType);
    if (!isUnpaid) continue;
    const isHalf = /half/i.test(reason) || /half/i.test(dayType);
    for (const d of datesInRange(lv.from_date, lv.to_date)) {
      if (!workingSet.has(d)) continue; // month-scoped + working day only
      lop += isHalf ? 0.5 : 1;
    }
  }
  return round2(lop);
}

/**
 * Early-checkout stats for the month:
 * - minutes: every minute checked out before shift end (the early-checkout line)
 * - shortfall_hours: the portion of those early departures that already lowered the
 *   month's counted hours (days where actual < daily threshold). The monthly
 *   shortfall already contains these hours, so they must not be deducted twice.
 */
async function computeEarlyCheckoutStats(employeeId, month, year) {
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const shift = await getEffectiveShiftForEmployee(employeeId);
  const shiftEnd = shift?.shift_end || '17:30';
  const threshold = shift?.working_hours_per_day ?? 8.25;

  const rows = await Attendance.find({
    employee_id: employeeId,
    date: { $regex: `^${monthPrefix}` },
    check_out: { $ne: null },
  })
    .select('check_out working_hours')
    .lean();

  let mins = 0;
  let shortfallHours = 0;
  for (const row of rows) {
    const early = minutesBetween(row.check_out, shiftEnd);
    if (early > 0) mins += early;
    const actual = Number(row.working_hours) || 0;
    if (row.check_out && actual < threshold) shortfallHours += threshold - actual;
  }
  return { minutes: round2(mins), shortfall_hours: round2(shortfallHours) };
}

export async function calculateSalaryDraft(employeeId, month, year, options = {}) {
  const employee = await Employee.findById(employeeId);
  if (!employee) throw new Error('Employee not found');

  let summary = await MonthlySummary.findOne({ employee_id: employeeId, month, year });
  if (!summary) summary = await recalculateMonthlySummary(employeeId, month, year);

  const settings = await getSettings();
  const base = resolveMonthlySalary(employee, month, year);
  const target = summary?.monthly_target_hours || 0;
  const counted = summary?.monthly_counted_hours || 0;
  // Salary pays only approved Management OT — not attendance Extra / General OT
  const overtime = Number(summary?.management_ot_hours || 0);
  const rawShortfall = Math.max(0, target - counted);
  const shortfallAction = summary?.shortfall_action || null;
  const needsShortfallDecision = rawShortfall > 0.01 && !shortfallAction;

  // Deduct only when admin/HR chose salary deduction; undecided / carry_forward → no pay cut on draft
  const shortfall = shortfallAction === 'deduct' ? rawShortfall : 0;

  const hourly = target > 0 ? base / target : 0;
  const deduction_rate = hourly * (settings.deduction_multiplier || 1);
  const overtime_rate = hourly * (settings.overtime_multiplier || 1.5);

  const { working_days } = await getWorkingDaysInMonth(year, month);
  const lop_days = await computeLopDays(employeeId, month, year);
  const leave_days = round2(summary?.approved_leave_days_in_month || 0);
  const paid_days = Math.max(0, round2(working_days - lop_days));
  const early_checkout_stats = await computeEarlyCheckoutStats(employeeId, month, year);
  const early_checkout_minutes = early_checkout_stats.minutes;

  // Per-day rate for unpaid leave; per-hour rate for early checkout (same multiplier family as shortfall)
  const daily_rate = working_days > 0 ? base / working_days : 0;
  const leave_deduction_amount = lop_days * daily_rate;
  const early_checkout_hours = early_checkout_minutes / 60;
  const early_checkout_deduction_amount = early_checkout_hours * deduction_rate;

  // Shortfall hours deduction (Performance → Salary Deduction). The monthly
  // shortfall already includes the hours lost to early checkout, so exclude
  // those here — they are charged on the early-checkout line above. Each
  // unworked hour is deducted exactly once.
  const shortfall_deductible = Math.max(0, round2(shortfall - early_checkout_stats.shortfall_hours));
  const deduction_amount = shortfall_deductible * deduction_rate;
  const overtime_amount = overtime * overtime_rate;

  // Bond proof: salary_deduction (default 15%) held from monthly base while proof is Held
  const salaryBond = getSalaryDeductionBond(employee);
  const bond_security_percent = resolveSalaryDeductionPercent(salaryBond);
  const bond_security_deduction = bond_security_percent > 0 ? (base * bond_security_percent) / 100 : 0;

  const tds = Number(options.tds) || 0;
  const custom_earnings = sanitizeLineItems(options.custom_earnings);
  const custom_deductions = sanitizeLineItems(options.custom_deductions);
  const net_pay = computeSlipNetPay({
    base_salary: base,
    overtime_amount,
    deduction_amount,
    leave_deduction_amount,
    early_checkout_deduction_amount,
    bond_security_deduction,
    tds,
    custom_earnings,
    custom_deductions,
  });

  const companyKey = options.company_key === 'ondial' ? 'ondial' : 'kriraai';
  const company = SALARY_COMPANIES[companyKey];

  return {
    employee_id: employeeId,
    month,
    year,
    base_salary: base,
    monthly_target_hours: target,
    monthly_counted_hours: counted,
    overtime_hours: overtime,
    shortfall_hours: shortfall_deductible,
    shortfall_action: shortfallAction || undefined,
    needs_shortfall_decision: needsShortfallDecision,
    pending_hours: round2(rawShortfall),
    carried_forward_hours: round2(summary?.carried_forward_hours || 0),
    deduction_amount: round2(deduction_amount),
    leave_deduction_amount: round2(leave_deduction_amount),
    early_checkout_minutes: round2(early_checkout_minutes),
    early_checkout_deduction_amount: round2(early_checkout_deduction_amount),
    overtime_amount: round2(overtime_amount),
    bond_security_deduction: round2(bond_security_deduction),
    bond_security_percent,
    tds: round2(tds),
    custom_earnings,
    custom_deductions,
    net_pay: round2(net_pay),
    paid_days,
    leave_days,
    lop_days,
    working_days,
    pay_date: options.pay_date || formatPayDate(month, year),
    company_key: company.key,
    company_name: company.companyName,
    company_address: company.companyAddress,
    pf_no: options.pf_no || 'NA',
    uan: options.uan || 'NA',
  };
}
