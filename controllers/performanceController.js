import Employee from '../models/Employee.js';
import SalarySlip from '../models/SalarySlip.js';
import AuditLog from '../models/AuditLog.js';
import { parseListQuery, listResponse } from '../utils/helpers.js';
import { applyShortfallDecision, recalculateMonthlySummary } from '../services/monthlyHours.js';
import { getEffectiveShiftForEmployee } from '../services/shift.js';
import { calculateSalaryDraft, mergeSalaryDraft, toPersistedSlipFields } from '../services/salaryCalc.js';

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const now = new Date();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const year = Number(req.query.year) || now.getFullYear();

    if (month < 1 || month > 12) {
      return res.status(400).json({ message: 'Invalid month' });
    }
    if (year < 2026) {
      return res.status(400).json({ message: 'Year must be 2026 or later' });
    }

    const empFilter = { role: 'employee', status: 'active' };
    if (req.query.department_id) empFilter.department_id = req.query.department_id;
    if (req.query.employee_id) empFilter._id = req.query.employee_id;
    if (search) {
      empFilter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { employee_id: { $regex: search, $options: 'i' } },
      ];
    }

    const [employees, total] = await Promise.all([
      Employee.find(empFilter)
        .populate('department_id', 'name working_hours_per_day')
        .select('name email employee_id department_id')
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Employee.countDocuments(empFilter),
    ]);

    const data = [];
    for (const emp of employees) {
      const summary = await recalculateMonthlySummary(emp._id, month, year);
      const shift = await getEffectiveShiftForEmployee(emp._id);
      const dailyTarget = shift?.working_hours_per_day ?? emp.department_id?.working_hours_per_day ?? 8.25;

      const counted = summary?.monthly_counted_hours ?? 0;
      const generalOt = summary?.overtime_hours ?? 0;
      const attendanceOt = summary?.attendance_ot_hours ?? 0;
      const managementOt = summary?.management_ot_hours ?? 0;
      const shortfallOrSurplus = summary?.monthly_shortfall_or_surplus ?? 0;
      const workingHours = counted + attendanceOt;
      const pendingHours = summary?.pending_hours ?? Math.max(0, (summary?.monthly_target_hours ?? 0) - counted);
      const lowHours =
        summary?.low_hours != null
          ? summary.low_hours
          : shortfallOrSurplus < 0
            ? Math.abs(shortfallOrSurplus)
            : 0;
      const shortfallAction = summary?.shortfall_action || null;
      const carriedForward = summary?.carried_forward_hours ?? 0;
      const carriedToNext = summary?.carried_to_next_hours ?? 0;

      let status = 'OnTime';
      if (pendingHours > 0.01 && !shortfallAction) status = 'Pending Decision';
      else if (shortfallAction === 'carry_forward') status = 'Carry Forward';
      else if (shortfallAction === 'deduct') status = 'Deduct';
      else if (managementOt > 0.01) status = 'Management OT';
      else if (generalOt > 0.01 && lowHours <= 0.01) status = 'General OT';
      else if (lowHours > 0.01) status = 'Low';
      else if (shortfallOrSurplus > 0.01) status = 'General OT';

      data.push({
        employee_id: emp,
        month,
        year,
        working_hours: Math.round(workingHours * 100) / 100,
        monthly_hours: Math.round(counted * 100) / 100,
        monthly_target_hours: Math.round((summary?.monthly_target_hours ?? 0) * 100) / 100,
        base_monthly_target_hours: Math.round((summary?.base_monthly_target_hours ?? 0) * 100) / 100,
        carried_forward_hours: Math.round(carriedForward * 100) / 100,
        carried_to_next_hours: Math.round(carriedToNext * 100) / 100,
        pending_hours: Math.round(pendingHours * 100) / 100,
        shortfall_action: shortfallAction,
        extra_working_hours: Math.round(generalOt * 100) / 100,
        general_ot_hours: Math.round(generalOt * 100) / 100,
        attendance_ot_hours: Math.round(attendanceOt * 100) / 100,
        management_ot_hours: Math.round(managementOt * 100) / 100,
        low_working_hours: Math.round(lowHours * 100) / 100,
        monthly_shortfall_or_surplus: Math.round(shortfallOrSurplus * 100) / 100,
        working_days_in_month: summary?.working_days_in_month ?? 0,
        approved_leave_days_in_month: summary?.approved_leave_days_in_month ?? 0,
        daily_target_hours: dailyTarget,
        status,
        needs_shortfall_decision: pendingHours > 0.01 && !shortfallAction,
      });
    }

    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

/**
 * Month-end shortfall decision: deduct (generate salary) or carry_forward to next month.
 * Body: { employee_id, month, year, action: 'deduct' | 'carry_forward', company_key? }
 */
export async function decideShortfall(req, res) {
  try {
    const { employee_id, month, year, action, company_key } = req.body;
    if (!employee_id || !month || !year) {
      return res.status(400).json({ message: 'employee_id, month, year required' });
    }
    if (!['deduct', 'carry_forward'].includes(action)) {
      return res.status(400).json({ message: 'action must be deduct or carry_forward' });
    }
    if (Number(year) < 2026) {
      return res.status(400).json({ message: 'Year must be 2026 or later' });
    }

    const summary = await applyShortfallDecision(
      employee_id,
      Number(month),
      Number(year),
      action,
      req.user._id
    );

    let slip = null;
    if (action === 'deduct') {
      const existing = await SalarySlip.findOne({
        employee_id,
        month: Number(month),
        year: Number(year),
      });
      if (existing?.status === 'Finalized') {
        return res.status(400).json({
          message: 'Finalized salary slip exists; reverse it before applying deduction',
          summary,
        });
      }
      const draft = await calculateSalaryDraft(employee_id, Number(month), Number(year), { company_key });
      const { values, overrides } = mergeSalaryDraft(draft, existing, {});
      const { slipFields } = toPersistedSlipFields(values);
      slip = await SalarySlip.findOneAndUpdate(
        { employee_id, month: Number(month), year: Number(year) },
        {
          ...slipFields,
          overrides,
          custom_earnings: values.custom_earnings,
          custom_deductions: values.custom_deductions,
          status: 'Draft',
          payment_status: existing?.payment_status || 'Pending',
          adjustment_note: `Salary deduction for ${draft.shortfall_hours}h shortfall.`,
          generated_by: req.user._id,
          generated_on: new Date(),
        },
        { upsert: true, new: true }
      ).populate({ path: 'employee_id', populate: { path: 'department_id' } });
    }

    await AuditLog.create({
      action: 'shortfall_decision',
      performed_by: req.user._id,
      target_employee_id: employee_id,
      details: {
        month: Number(month),
        year: Number(year),
        action,
        pending_hours: summary.pending_hours,
        carried_to_next_hours: summary.carried_to_next_hours,
        slip_id: slip?._id,
      },
    });

    res.json({ summary, slip, action });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}
