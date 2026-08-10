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

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
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

  let lop = 0;
  for (const lv of leaves) {
    const reason = String(lv.reason || '');
    const dayType = String(lv.day_type || '');
    const isUnpaid = /unpaid|loss\s*of\s*pay|\blop\b/i.test(reason) || /unpaid|lop/i.test(dayType);
    if (!isUnpaid) continue;
    const isHalf = /half/i.test(reason) || /half/i.test(dayType);
    for (const d of datesInRange(lv.from_date, lv.to_date)) {
      if (!d.startsWith(monthPrefix)) continue;
      lop += isHalf ? 0.5 : 1;
    }
  }
  return round2(lop);
}

/**
 * Total early-checkout minutes in month (check_out before effective shift_end).
 */
async function computeEarlyCheckoutMinutes(employeeId, month, year) {
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const shift = await getEffectiveShiftForEmployee(employeeId);
  const shiftEnd = shift?.shift_end || '17:30';

  const rows = await Attendance.find({
    employee_id: employeeId,
    date: { $regex: `^${monthPrefix}` },
    check_out: { $ne: null },
  })
    .select('check_out')
    .lean();

  let mins = 0;
  for (const row of rows) {
    const early = minutesBetween(row.check_out, shiftEnd);
    if (early > 0) mins += early;
  }
  return round2(mins);
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
  const paid_days = Math.max(0, round2(working_days - lop_days));
  const early_checkout_minutes = await computeEarlyCheckoutMinutes(employeeId, month, year);

  // Per-day rate for unpaid leave; per-hour rate for early checkout (same multiplier family as shortfall)
  const daily_rate = working_days > 0 ? base / working_days : 0;
  const leave_deduction_amount = lop_days * daily_rate;
  const early_checkout_hours = early_checkout_minutes / 60;
  const early_checkout_deduction_amount = early_checkout_hours * deduction_rate;

  // Shortfall hours deduction (Performance → Salary Deduction)
  const deduction_amount = shortfall * deduction_rate;
  const overtime_amount = overtime * overtime_rate;

  // Bond proof: salary_deduction (default 15%) held from monthly base while proof is Held
  const salaryBond = getSalaryDeductionBond(employee);
  const bond_security_percent = resolveSalaryDeductionPercent(salaryBond);
  const bond_security_deduction = bond_security_percent > 0 ? (base * bond_security_percent) / 100 : 0;

  const tds = Number(options.tds) || 0;
  const net_pay =
    base -
    deduction_amount -
    leave_deduction_amount -
    early_checkout_deduction_amount +
    overtime_amount -
    bond_security_deduction -
    tds;

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
    shortfall_hours: shortfall,
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
    net_pay: round2(net_pay),
    paid_days,
    lop_days,
    pay_date: options.pay_date || formatPayDate(month, year),
    company_key: company.key,
    company_name: company.companyName,
    company_address: company.companyAddress,
    pf_no: options.pf_no || 'NA',
    uan: options.uan || 'NA',
  };
}
