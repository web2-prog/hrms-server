import SalarySlip from '../models/SalarySlip.js';
import Employee from '../models/Employee.js';
import AuditLog from '../models/AuditLog.js';
import { calculateSalaryDraft, SALARY_COMPANIES, mergeSalaryDraft, toPersistedSlipFields, applySalaryAdjustments, pickSalaryOverrides, computeSlipNetPay } from '../services/salaryCalc.js';
import { buildPayslipForm } from '../services/payslipForm.js';
import { parseListQuery, listResponse } from '../utils/helpers.js';
import { applyEmployeeListScope } from '../utils/employeeScope.js';
import { renderSalarySlipPdf, buildSalarySlipPdfBuffer } from '../services/salarySlipPdf.js';
import { sendSalarySlipEmail } from '../services/emailService.js';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

async function populateSlip(id) {
  return SalarySlip.findById(id).populate({
    path: 'employee_id',
    populate: { path: 'department_id' },
  });
}

function buildSlipPdfFilename(slip, payslip) {
  const monthLabel = MONTH_NAMES[slip.month - 1] || slip.month;
  const safeName = (payslip.empName || 'Employee').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, ' ');
  const companyPrefix = payslip.companyKey === 'ondial' ? 'Ondial' : 'KriraAI';
  return `SALARYSLIP ${companyPrefix} ${safeName} ${monthLabel} ${slip.year}.pdf`;
}

function resolveEmployeeEmail(employee) {
  if (!employee) return '';
  const official = String(employee.email || '').trim();
  if (official) return official;
  return String(employee.profile_details?.personal_email || '').trim();
}

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const filter = {};
    if (req.query.month) filter.month = Number(req.query.month);
    if (req.query.year) filter.year = Number(req.query.year);
    if (req.query.payment_status) filter.payment_status = req.query.payment_status;
    if (req.query.company_key === 'ondial' || req.query.company_key === 'kriraai') {
      filter.company_key = req.query.company_key;
    }
    await applyEmployeeListScope(req, filter, { search });
    // Employees only see slips that HR/Admin has emailed to them.
    if (req.user.role === 'employee') {
      filter.sent_on = { $ne: null };
    }
    const [data, total] = await Promise.all([
      SalarySlip.find(filter)
        .populate({ path: 'employee_id', populate: { path: 'department_id' } })
        .sort({ year: -1, month: -1 })
        .skip(skip)
        .limit(limit),
      SalarySlip.countDocuments(filter),
    ]);
    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function getOne(req, res) {
  try {
    const slip = await populateSlip(req.params.id);
    if (!slip) return res.status(404).json({ message: 'Not found' });
    if (req.user.role === 'employee') {
      if (String(req.user._id) !== String(slip.employee_id._id)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
      if (!slip.sent_on) {
        return res.status(403).json({
          message: 'This salary slip is not available yet. You can view it after HR/Admin sends it.',
        });
      }
    }
    const payslip = await buildPayslipForm(slip.toObject());
    res.json({ ...slip.toObject(), payslip });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

function formatPendingHours(hours) {
  const n = Number(hours) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

function finalizeBlockedMessage(draft, month, year) {
  const hours = formatPendingHours(draft.pending_hours);
  const period = month && year ? ` for ${month}/${year}` : '';
  return (
    `Cannot finalize yet: ${hours} hour(s) are still pending${period}. ` +
    `Open Performance and choose either "Salary Deduction" or "Carry Forward" for those hours, then try Finalize again.`
  );
}

function shortfallNote(draft, adjustment_note) {
  if (adjustment_note) return adjustment_note;
  if (draft.needs_shortfall_decision && draft.pending_hours > 0) {
    return (
      `${formatPendingHours(draft.pending_hours)}h pending — ` +
      `choose Salary Deduction or Carry Forward on Performance before finalizing.`
    );
  }
  if (draft.shortfall_action === 'carry_forward' && draft.pending_hours > 0) {
    return `${formatPendingHours(draft.pending_hours)}h pending carried forward to next month (no salary deduction).`;
  }
  if (draft.shortfall_action === 'deduct' && draft.shortfall_hours > 0) {
    return `Salary deduction for ${formatPendingHours(draft.shortfall_hours)}h shortfall.`;
  }
  return '';
}

async function upsertDraftFromCalc(employeeId, month, year, body, userId, existing) {
  const draft = await calculateSalaryDraft(employeeId, month, year, {
    company_key: body.company_key,
    pay_date: body.pay_date,
    tds: body.tds,
    pf_no: body.pf_no,
    uan: body.uan,
  });
  const { values, overrides } = mergeSalaryDraft(draft, existing, body);
  const { slipFields } = toPersistedSlipFields(values);
  const note = shortfallNote(draft, body.adjustment_note || existing?.adjustment_note);
  return SalarySlip.findOneAndUpdate(
    { employee_id: employeeId, month, year },
    {
      ...slipFields,
      overrides,
      custom_earnings: values.custom_earnings,
      custom_deductions: values.custom_deductions,
      status: 'Draft',
      payment_status: existing?.payment_status || 'Pending',
      adjustment_note: note,
      generated_by: userId,
      generated_on: new Date(),
    },
    { upsert: true, new: true }
  );
}

export async function generate(req, res) {
  try {
    const { employee_id, month, year } = req.body;
    if (!employee_id || !month || !year) return res.status(400).json({ message: 'employee_id, month, year required' });
    if (Number(year) < 2026) return res.status(400).json({ message: 'Year must be 2026 or later' });

    const existing = await SalarySlip.findOne({ employee_id, month, year });
    if (existing && existing.status === 'Finalized') {
      return res.status(400).json({ message: 'Finalized slip exists; reverse/reissue required' });
    }

    const slip = await upsertDraftFromCalc(
      employee_id,
      Number(month),
      Number(year),
      req.body,
      req.user._id,
      existing
    );
    const populated = await populateSlip(slip._id);
    const payslip = await buildPayslipForm(populated.toObject());
    res.status(201).json({ ...populated.toObject(), payslip });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function generateBulk(req, res) {
  try {
    const { department_id, month, year, company_key } = req.body;
    const filter = { role: 'employee', status: 'active' };
    if (department_id) filter.department_id = department_id;
    const emps = await Employee.find(filter).select('_id');
    const results = [];
    const skipped = [];
    for (const e of emps) {
      try {
        const existing = await SalarySlip.findOne({ employee_id: e._id, month, year });
        if (existing?.status === 'Finalized') {
          skipped.push({ employee_id: e._id, reason: 'Finalized' });
          continue;
        }
        const slip = await upsertDraftFromCalc(
          e._id,
          Number(month),
          Number(year),
          { company_key },
          req.user._id,
          existing
        );
        results.push(slip);
      } catch (err) {
        skipped.push({ employee_id: e._id, reason: err.message });
      }
    }
    await AuditLog.create({
      action: 'bulk_salary_generate',
      performed_by: req.user._id,
      details: { month, year, department_id, count: results.length, skipped: skipped.length },
    });
    res.json({ generated: results.length, skipped, data: results });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function finalize(req, res) {
  try {
    const slip = await SalarySlip.findById(req.params.id);
    if (!slip) return res.status(404).json({ message: 'Not found' });
    if (slip.status === 'Finalized') return res.status(400).json({ message: 'Already finalized' });

    // Re-check month-end shortfall decision before locking pay
    const draft = await calculateSalaryDraft(slip.employee_id, slip.month, slip.year, {
      company_key: slip.company_key,
      pay_date: slip.pay_date,
      tds: slip.tds,
      pf_no: slip.pf_no,
      uan: slip.uan,
    });
    if (draft.needs_shortfall_decision) {
      return res.status(400).json({
        message: finalizeBlockedMessage(draft, slip.month, slip.year),
        code: 'PENDING_SHORTFALL_DECISION',
        pending_hours: draft.pending_hours,
        month: slip.month,
        year: slip.year,
      });
    }

    // Refresh auto amounts, then re-apply HR/Admin overrides + custom lines
    const { values, overrides } = mergeSalaryDraft(draft, slip, {
      pay_date: slip.pay_date,
      tds: slip.tds,
      pf_no: slip.pf_no,
      uan: slip.uan,
    });
    const { slipFields } = toPersistedSlipFields(values);
    Object.assign(slip, slipFields);
    slip.overrides = overrides;
    slip.custom_earnings = values.custom_earnings;
    slip.custom_deductions = values.custom_deductions;
    if (!draft.shortfall_action) slip.shortfall_action = undefined;

    if (req.body.adjustment_note) slip.adjustment_note = req.body.adjustment_note;
    else if (draft.shortfall_action === 'carry_forward' && draft.pending_hours > 0) {
      slip.adjustment_note = `${draft.pending_hours}h pending carried forward to next month (no salary deduction).`;
    } else if (draft.shortfall_action === 'deduct' && draft.shortfall_hours > 0) {
      slip.adjustment_note = `Salary deduction for ${draft.shortfall_hours}h shortfall.`;
    }
    if (req.body.net_pay != null) slip.net_pay = Number(req.body.net_pay);
    else slip.net_pay = values.net_pay;
    slip.status = 'Finalized';
    slip.finalized_on = new Date();
    slip.markModified('overrides');
    slip.markModified('custom_earnings');
    slip.markModified('custom_deductions');
    await slip.save();
    await AuditLog.create({
      action: 'salary_finalize',
      performed_by: req.user._id,
      target_employee_id: slip.employee_id,
      details: { slip_id: slip._id, month: slip.month, year: slip.year },
    });
    res.json(slip);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function reverse(req, res) {
  try {
    const slip = await SalarySlip.findById(req.params.id);
    if (!slip) return res.status(404).json({ message: 'Not found' });
    if (slip.payment_status === 'Paid') {
      slip.payment_status = 'Pending';
      slip.paid_date = null;
      slip.payment_reference = '';
    }
    slip.status = 'Draft';
    slip.finalized_on = null;
    await slip.save();
    await AuditLog.create({
      action: 'salary_reverse',
      performed_by: req.user._id,
      target_employee_id: slip.employee_id,
      details: { slip_id: slip._id, reason: req.body.reason || '' },
    });
    res.json(slip);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function updatePayment(req, res) {
  try {
    const slip = await SalarySlip.findById(req.params.id);
    if (!slip) return res.status(404).json({ message: 'Not found' });
    if (slip.status !== 'Finalized') return res.status(400).json({ message: 'Finalize first' });
    const { payment_status, paid_date, payment_reference } = req.body;
    if (payment_status) slip.payment_status = payment_status;
    if (paid_date !== undefined) slip.paid_date = paid_date ? new Date(paid_date) : null;
    if (payment_reference !== undefined) slip.payment_reference = payment_reference;
    await slip.save();
    res.json(slip);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

/** Update payslip company branding (KriraAI / Ondial) on salary format */
export async function updateCompany(req, res) {
  try {
    const slip = await SalarySlip.findById(req.params.id);
    if (!slip) return res.status(404).json({ message: 'Not found' });
    const companyKey = req.body.company_key === 'ondial' ? 'ondial' : 'kriraai';
    const company = SALARY_COMPANIES[companyKey];
    slip.company_key = company.key;
    slip.company_name = company.companyName;
    slip.company_address = company.companyAddress;
    await slip.save();
    const populated = await populateSlip(slip._id);
    const payslip = await buildPayslipForm(populated.toObject());
    res.json({ ...populated.toObject(), payslip });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

/** HR/Admin set dynamic amounts, TDS/PF, paid days, and extra earning/deduction lines on a draft slip. */
export async function updateAdjustments(req, res) {
  try {
    const slip = await SalarySlip.findById(req.params.id);
    if (!slip) return res.status(404).json({ message: 'Not found' });
    if (slip.status === 'Finalized') {
      return res.status(400).json({ message: 'Reverse the slip before editing values' });
    }

    if (req.body.reset) {
      const draft = await calculateSalaryDraft(slip.employee_id, slip.month, slip.year, {
        company_key: slip.company_key,
      });
      const { slipFields } = toPersistedSlipFields(draft);
      Object.assign(slip, slipFields);
      slip.overrides = {};
      slip.custom_earnings = [];
      slip.custom_deductions = [];
      slip.adjustment_note = shortfallNote(draft, '');
      if (!draft.shortfall_action) slip.shortfall_action = undefined;
    } else {
      const nextOverrides = {
        ...(slip.overrides && typeof slip.overrides === 'object' ? slip.overrides : {}),
        ...pickSalaryOverrides(req.body),
      };
      const { values, overrides } = applySalaryAdjustments(slip.toObject(), nextOverrides, {
        custom_earnings: req.body.custom_earnings !== undefined ? req.body.custom_earnings : slip.custom_earnings,
        custom_deductions:
          req.body.custom_deductions !== undefined ? req.body.custom_deductions : slip.custom_deductions,
      });
      const { slipFields } = toPersistedSlipFields(values);
      Object.assign(slip, slipFields);
      slip.overrides = overrides;
      slip.custom_earnings = values.custom_earnings;
      slip.custom_deductions = values.custom_deductions;
      slip.net_pay = computeSlipNetPay(slip);
      if (req.body.adjustment_note !== undefined) slip.adjustment_note = String(req.body.adjustment_note);
    }

    slip.markModified('overrides');
    slip.markModified('custom_earnings');
    slip.markModified('custom_deductions');
    await slip.save();
    await AuditLog.create({
      action: 'salary_adjust',
      performed_by: req.user._id,
      target_employee_id: slip.employee_id,
      details: { slip_id: slip._id, reset: Boolean(req.body.reset) },
    });
    const populated = await populateSlip(slip._id);
    const payslip = await buildPayslipForm(populated.toObject());
    res.json({ ...populated.toObject(), payslip });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function downloadPdf(req, res) {
  try {
    const slip = await populateSlip(req.params.id);
    if (!slip) return res.status(404).json({ message: 'Not found' });
    if (req.user.role === 'employee') {
      if (String(req.user._id) !== String(slip.employee_id._id)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
      if (!slip.sent_on) {
        return res.status(403).json({
          message: 'This salary slip is not available yet. You can download it after HR/Admin sends it.',
        });
      }
    }

    const payslip = await buildPayslipForm(slip.toObject());
    const filename = buildSlipPdfFilename(slip, payslip);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    renderSalarySlipPdf(res, payslip);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

/** HR/Admin email finalized salary slip PDF to employee. */
export async function sendSlip(req, res) {
  try {
    const slip = await populateSlip(req.params.id);
    if (!slip) return res.status(404).json({ message: 'Not found' });
    if (slip.status !== 'Finalized') {
      return res.status(400).json({ message: 'Finalize the salary slip before sending' });
    }

    const employee = slip.employee_id;
    const toEmail = resolveEmployeeEmail(employee);
    if (!toEmail) {
      return res.status(400).json({ message: 'Employee has no email address on file' });
    }

    const payslip = await buildPayslipForm(slip.toObject());
    const filename = buildSlipPdfFilename(slip, payslip);
    const monthLabel = MONTH_NAMES[slip.month - 1] || String(slip.month);
    const pdfBuffer = await buildSalarySlipPdfBuffer(payslip);

    const { messageId } = await sendSalarySlipEmail({
      to: toEmail,
      employeeName: employee?.name || payslip.empName,
      monthLabel,
      year: slip.year,
      companyName: payslip.companyName,
      netPay: payslip.netPay,
      pdfBuffer,
      filename,
    });

    slip.sent_on = new Date();
    slip.sent_to = toEmail;
    slip.sent_by = req.user._id;
    await slip.save();

    await AuditLog.create({
      action: 'salary_send',
      performed_by: req.user._id,
      target_employee_id: slip.employee_id._id,
      details: { slip_id: slip._id, month: slip.month, year: slip.year, sent_to: toEmail, messageId },
    });

    res.json({
      message: `Salary slip sent to ${toEmail}`,
      sent_on: slip.sent_on,
      sent_to: slip.sent_to,
    });
  } catch (e) {
    res.status(500).json({ message: e.message || 'Failed to send salary slip email' });
  }
}
