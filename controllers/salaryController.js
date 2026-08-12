import SalarySlip from '../models/SalarySlip.js';
import Employee from '../models/Employee.js';
import AuditLog from '../models/AuditLog.js';
import { calculateSalaryDraft, SALARY_COMPANIES } from '../services/salaryCalc.js';
import { buildPayslipForm } from '../services/payslipForm.js';
import { parseListQuery, listResponse } from '../utils/helpers.js';
import { applyEmployeeListScope } from '../utils/employeeScope.js';
import { renderSalarySlipPdf } from '../services/salarySlipPdf.js';

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
    if (req.user.role === 'employee' && String(req.user._id) !== String(slip.employee_id._id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const payslip = await buildPayslipForm(slip.toObject());
    res.json({ ...slip.toObject(), payslip });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function generate(req, res) {
  try {
    const { employee_id, month, year, adjustment_note, company_key, pay_date, tds, pf_no, uan } = req.body;
    if (!employee_id || !month || !year) return res.status(400).json({ message: 'employee_id, month, year required' });
    if (Number(year) < 2026) return res.status(400).json({ message: 'Year must be 2026 or later' });

    const existing = await SalarySlip.findOne({ employee_id, month, year });
    if (existing && existing.status === 'Finalized') {
      return res.status(400).json({ message: 'Finalized slip exists; reverse/reissue required' });
    }

    const draft = await calculateSalaryDraft(employee_id, Number(month), Number(year), {
      company_key,
      pay_date,
      tds,
      pf_no,
      uan,
    });

    let note = adjustment_note || '';
    if (!note && draft.needs_shortfall_decision && draft.pending_hours > 0) {
      note = `${draft.pending_hours}h pending — decide Salary Deduction or Carry Forward on Performance before finalizing.`;
    } else if (!note && draft.shortfall_action === 'carry_forward' && draft.pending_hours > 0) {
      note = `${draft.pending_hours}h pending carried forward to next month (no salary deduction).`;
    } else if (!note && draft.shortfall_action === 'deduct' && draft.shortfall_hours > 0) {
      note = `Salary deduction for ${draft.shortfall_hours}h shortfall.`;
    }

    const { pending_hours, carried_forward_hours, needs_shortfall_decision, ...slipFields } = draft;
    if (!slipFields.shortfall_action) delete slipFields.shortfall_action;
    const slip = await SalarySlip.findOneAndUpdate(
      { employee_id, month, year },
      {
        ...slipFields,
        status: 'Draft',
        payment_status: existing?.payment_status || 'Pending',
        adjustment_note: note,
        generated_by: req.user._id,
        generated_on: new Date(),
      },
      { upsert: true, new: true }
    ).populate({ path: 'employee_id', populate: { path: 'department_id' } });

    const payslip = await buildPayslipForm(slip.toObject());
    res.status(201).json({ ...slip.toObject(), payslip });
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
        const draft = await calculateSalaryDraft(e._id, Number(month), Number(year), { company_key });
        const existing = await SalarySlip.findOne({ employee_id: e._id, month, year });
        if (existing?.status === 'Finalized') {
          skipped.push({ employee_id: e._id, reason: 'Finalized' });
          continue;
        }
        let note = '';
        if (draft.needs_shortfall_decision && draft.pending_hours > 0) {
          note = `${draft.pending_hours}h pending — decide Salary Deduction or Carry Forward on Performance before finalizing.`;
        } else if (draft.shortfall_action === 'carry_forward' && draft.pending_hours > 0) {
          note = `${draft.pending_hours}h pending carried forward to next month (no salary deduction).`;
        } else if (draft.shortfall_action === 'deduct' && draft.shortfall_hours > 0) {
          note = `Salary deduction for ${draft.shortfall_hours}h shortfall.`;
        }
        const { pending_hours, carried_forward_hours, needs_shortfall_decision, ...slipFields } = draft;
        if (!slipFields.shortfall_action) delete slipFields.shortfall_action;
        const slip = await SalarySlip.findOneAndUpdate(
          { employee_id: e._id, month, year },
          {
            ...slipFields,
            status: 'Draft',
            adjustment_note: note,
            generated_by: req.user._id,
            generated_on: new Date(),
          },
          { upsert: true, new: true }
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
        message: `Pending ${draft.pending_hours}h — choose Salary Deduction or Carry Forward on Performance before finalizing`,
      });
    }

    // Refresh amounts from latest decision / attendance before finalize
    const { pending_hours, carried_forward_hours, needs_shortfall_decision, ...slipFields } = draft;
    if (!slipFields.shortfall_action) delete slipFields.shortfall_action;
    Object.assign(slip, slipFields);
    if (!draft.shortfall_action) slip.shortfall_action = undefined;

    if (req.body.adjustment_note) slip.adjustment_note = req.body.adjustment_note;
    else if (draft.shortfall_action === 'carry_forward' && draft.pending_hours > 0) {
      slip.adjustment_note = `${draft.pending_hours}h pending carried forward to next month (no salary deduction).`;
    } else if (draft.shortfall_action === 'deduct' && draft.shortfall_hours > 0) {
      slip.adjustment_note = `Salary deduction for ${draft.shortfall_hours}h shortfall.`;
    }
    if (req.body.net_pay != null) slip.net_pay = Number(req.body.net_pay);
    slip.status = 'Finalized';
    slip.finalized_on = new Date();
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

export async function downloadPdf(req, res) {
  try {
    const slip = await populateSlip(req.params.id);
    if (!slip) return res.status(404).json({ message: 'Not found' });
    if (req.user.role === 'employee' && String(req.user._id) !== String(slip.employee_id._id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const payslip = await buildPayslipForm(slip.toObject());
    const monthLabel = MONTH_NAMES[slip.month - 1] || slip.month;
    const safeName = (payslip.empName || 'Employee').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, ' ');
    const companyPrefix = payslip.companyKey === 'ondial' ? 'Ondial' : 'KriraAI';
    const filename = `SALARYSLIP ${companyPrefix} ${safeName} ${monthLabel} ${slip.year}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    renderSalarySlipPdf(res, payslip);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
