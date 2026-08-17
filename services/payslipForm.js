import SalarySlip from '../models/SalarySlip.js';

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function formatDoj(joiningDate) {
  if (!joiningDate) return '—';
  const d = joiningDate instanceof Date ? joiningDate : new Date(joiningDate);
  if (Number.isNaN(d.getTime())) return '—';
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}/${mon}/${year}`;
}

/**
 * Sum prior slips in same calendar year (month < current) for YTD columns.
 */
export async function computeYtdForSlip(employeeId, month, year, current) {
  const prior = await SalarySlip.find({
    employee_id: employeeId,
    year,
    month: { $lt: month },
  }).lean();

  const sum = (key) => prior.reduce((acc, s) => acc + (Number(s[key]) || 0), 0);

  const ytdByLabel = (key, currentItems) => {
    const map = {};
    for (const s of prior) {
      for (const item of s[key] || []) {
        const label = String(item.label || '').trim();
        if (!label) continue;
        map[label] = (map[label] || 0) + (Number(item.amount) || 0);
      }
    }
    return (currentItems || []).map((item) => {
      const label = String(item.label || '').trim();
      const amount = Number(item.amount) || 0;
      return { label, amount: round2(amount), ytd: round2((map[label] || 0) + amount) };
    });
  };

  return {
    ytd_basic: round2(sum('base_salary') + (Number(current.base_salary) || 0)),
    ytd_overtime: round2(sum('overtime_amount') + (Number(current.overtime_amount) || 0)),
    ytd_shortfall_deduction: round2(sum('deduction_amount') + (Number(current.deduction_amount) || 0)),
    ytd_leave_deduction: round2(
      sum('leave_deduction_amount') + (Number(current.leave_deduction_amount) || 0)
    ),
    ytd_early_checkout_deduction: round2(
      sum('early_checkout_deduction_amount') + (Number(current.early_checkout_deduction_amount) || 0)
    ),
    ytd_bond_security: round2(sum('bond_security_deduction') + (Number(current.bond_security_deduction) || 0)),
    ytd_tds: round2(sum('tds') + (Number(current.tds) || 0)),
    custom_earnings: ytdByLabel('custom_earnings', current.custom_earnings),
    custom_deductions: ytdByLabel('custom_deductions', current.custom_deductions),
  };
}

/**
 * Build Zoho-style payslip form payload from a slip (+ populated employee).
 */
export async function buildPayslipForm(slip) {
  const emp = slip.employee_id && typeof slip.employee_id === 'object' ? slip.employee_id : null;
  const empId = emp?._id || slip.employee_id;
  const ytd = await computeYtdForSlip(empId, slip.month, slip.year, slip);

  const basic = Number(slip.base_salary) || 0;
  const overtime = Number(slip.overtime_amount) || 0;
  const shortfall = Number(slip.deduction_amount) || 0;
  const leaveDeduction = Number(slip.leave_deduction_amount) || 0;
  const earlyCheckoutDeduction = Number(slip.early_checkout_deduction_amount) || 0;
  const earlyCheckoutMinutes = Number(slip.early_checkout_minutes) || 0;
  const bond = Number(slip.bond_security_deduction) || 0;
  const tds = Number(slip.tds) || 0;
  const customEarnings = ytd.custom_earnings || [];
  const customDeductions = ytd.custom_deductions || [];
  const extraEarn = round2(customEarnings.reduce((s, i) => s + (Number(i.amount) || 0), 0));
  const extraDed = round2(customDeductions.reduce((s, i) => s + (Number(i.amount) || 0), 0));
  const gross = round2(basic + overtime + extraEarn);
  const totalDeductions = round2(
    shortfall + leaveDeduction + earlyCheckoutDeduction + bond + tds + extraDed
  );
  const net = round2(gross - totalDeductions);

  const targetHours = Number(slip.monthly_target_hours) || 0;
  const countedHours = Number(slip.monthly_counted_hours) || 0;
  const overtimeHours = Number(slip.overtime_hours) || 0;
  const shortfallHours = Number(slip.shortfall_hours) || 0;
  const hourlyRate = targetHours > 0 ? round2(basic / targetHours) : 0;
  const overtimeRate =
    overtimeHours > 0 ? round2(overtime / overtimeHours) : round2(hourlyRate * 1.5);
  const shortfallRate =
    shortfallHours > 0 ? round2(shortfall / shortfallHours) : hourlyRate;

  return {
    companyKey: slip.company_key || 'kriraai',
    companyName: slip.company_name || 'KriraAI Pvt. Ltd.',
    companyAddress:
      slip.company_address ||
      'C2-1310, Pragati IT Park, opp. AR Mall, Mota Varachha Road, Uttran, Surat',
    empName: emp?.name || '',
    empNo: emp?.employee_id || '',
    designation: emp?.department_id?.name || '',
    doj: formatDoj(emp?.joining_date),
    payDate: slip.pay_date || '',
    pfNo: slip.pf_no || 'NA',
    uan: slip.uan || 'NA',
    paidDays: Number(slip.paid_days) || 0,
    leaveDays: Number(slip.leave_days) || 0,
    lopDays: Number(slip.lop_days) || 0,
    workingDays: Number(slip.working_days) || 0,
    month: slip.month,
    year: slip.year,
    basic,
    ytdBasic: ytd.ytd_basic,
    overtime,
    ytdOvertime: ytd.ytd_overtime,
    shortfallDeduction: shortfall,
    ytdShortfallDeduction: ytd.ytd_shortfall_deduction,
    leaveDeduction,
    ytdLeaveDeduction: ytd.ytd_leave_deduction,
    earlyCheckoutMinutes,
    earlyCheckoutDeduction,
    ytdEarlyCheckoutDeduction: ytd.ytd_early_checkout_deduction,
    bondSecurity: bond,
    bondSecurityPercent: Number(slip.bond_security_percent) || 0,
    ytdBondSecurity: ytd.ytd_bond_security,
    tds,
    ytdTds: ytd.ytd_tds,
    customEarnings,
    customDeductions,
    grossEarnings: gross,
    totalDeductions,
    netPay: Number(slip.net_pay) != null ? round2(slip.net_pay) : net,
    targetHours,
    countedHours,
    overtimeHours,
    shortfallHours,
    hourlyRate,
    overtimeRate,
    shortfallRate,
    hours: {
      target: targetHours,
      counted: countedHours,
      overtime: overtimeHours,
      shortfall: shortfallHours,
    },
  };
}
