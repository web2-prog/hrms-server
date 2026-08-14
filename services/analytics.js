import Attendance from '../models/Attendance.js';
import OvertimeRequest from '../models/OvertimeRequest.js';
import Employee from '../models/Employee.js';
import { resolveEffectiveShift } from '../services/shift.js';
import { minutesBetween, LATE_CHECKIN_PENALTY_MINUTES } from '../utils/helpers.js';

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function emptyMonth(month) {
  return {
    month,
    label: MONTH_NAMES[month - 1],
    total_working_hours: 0,
    early_checkout_minutes: 0,
    early_checkout_count: 0,
    late_checkin_count: 0,
    late_checkin_minutes: 0,
    penalty_minutes: 0,
    low_time_hours: 0,
    low_time_count: 0,
    overtime_all_hours: 0,
    overtime_general_hours: 0,
    overtime_management_hours: 0,
    overtime_pending_hours: 0,
    attendance_ot_hours: 0,
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function sumMonths(months) {
  const t = emptyMonth(0);
  delete t.month;
  delete t.label;
  for (const m of months) {
    for (const k of Object.keys(t)) {
      t[k] = round2((t[k] || 0) + (m[k] || 0));
    }
  }
  return t;
}

/**
 * Org analytics for a calendar year (optionally filtered by dept/employee).
 * Late / early / penalty are derived from check times vs effective shift
 * (no dedicated late/early request entities exist yet).
 */
export async function buildYearAnalytics({ year, department_id, employee_id }) {
  const empFilter = { role: 'employee', status: 'active' };
  if (department_id) empFilter.department_id = department_id;
  if (employee_id) empFilter._id = employee_id;

  const employees = await Employee.find(empFilter)
    .populate('department_id')
    .select('name employee_id department_id custom_shift_start custom_shift_end custom_working_hours_per_day')
    .lean();

  const empIds = employees.map((e) => e._id);
  const shiftByEmp = new Map();
  for (const emp of employees) {
    shiftByEmp.set(String(emp._id), resolveEffectiveShift(emp, emp.department_id));
  }

  const months = Array.from({ length: 12 }, (_, i) => emptyMonth(i + 1));

  if (!empIds.length) {
    return {
      year,
      months,
      totals: sumMonths(months),
      employee_count: 0,
      by_employee: [],
    };
  }

  const [attendance, overtime] = await Promise.all([
    Attendance.find({
      employee_id: { $in: empIds },
      date: { $regex: `^${year}` },
    })
      .select('employee_id date check_in check_out working_hours status surplus_shortfall penalty_waived')
      .lean(),
    OvertimeRequest.find({
      employee_id: { $in: empIds },
      date: { $regex: `^${year}` },
    })
      .select('employee_id date hours status ot_type')
      .lean(),
  ]);

  const empAgg = new Map();
  for (const emp of employees) {
    empAgg.set(String(emp._id), {
      employee_id: emp._id,
      name: emp.name,
      code: emp.employee_id,
      department: emp.department_id?.name || '—',
      total_working_hours: 0,
      early_checkout_minutes: 0,
      early_checkout_count: 0,
      late_checkin_count: 0,
      late_checkin_minutes: 0,
      penalty_minutes: 0,
      low_time_hours: 0,
      low_time_count: 0,
      overtime_all_hours: 0,
      overtime_general_hours: 0,
      overtime_management_hours: 0,
      overtime_pending_hours: 0,
      attendance_ot_hours: 0,
    });
  }

  for (const row of attendance) {
    const m = Number(String(row.date).slice(5, 7));
    if (m < 1 || m > 12) continue;
    const bucket = months[m - 1];
    const eid = String(row.employee_id);
    const empRow = empAgg.get(eid);
    const shift = shiftByEmp.get(eid);
    if (!shift) continue;

    const worked = Number(row.working_hours || 0);
    bucket.total_working_hours = round2(bucket.total_working_hours + worked);
    if (empRow) empRow.total_working_hours = round2(empRow.total_working_hours + worked);

    if (row.check_out && shift.shift_end) {
      const earlyMins = minutesBetween(row.check_out, shift.shift_end);
      if (earlyMins > 0) {
        bucket.early_checkout_minutes += earlyMins;
        bucket.early_checkout_count += 1;
        if (empRow) {
          empRow.early_checkout_minutes += earlyMins;
          empRow.early_checkout_count += 1;
        }
      }
    }

    if (row.check_in && shift.shift_start) {
      const lateMins = minutesBetween(shift.shift_start, row.check_in);
      if (lateMins > 1 / 60) {
        bucket.late_checkin_count += 1;
        bucket.late_checkin_minutes += lateMins;
        // Fixed 15-minute late check-in penalty (unless waived)
        if (!row.penalty_waived) {
          bucket.penalty_minutes += LATE_CHECKIN_PENALTY_MINUTES;
        }
        if (empRow) {
          empRow.late_checkin_count += 1;
          empRow.late_checkin_minutes += lateMins;
          if (!row.penalty_waived) {
            empRow.penalty_minutes += LATE_CHECKIN_PENALTY_MINUTES;
          }
        }
      }
    }

    const shortfall = Number(row.surplus_shortfall || 0);
    if (row.status === 'Low' || shortfall < 0) {
      const lowH = Math.abs(shortfall < 0 ? shortfall : Math.min(0, worked - (shift.working_hours_per_day || 8.25)));
      bucket.low_time_hours = round2(bucket.low_time_hours + lowH);
      bucket.low_time_count += 1;
      if (empRow) {
        empRow.low_time_hours = round2(empRow.low_time_hours + lowH);
        empRow.low_time_count += 1;
      }
    }

    if (row.status === 'Extra' || shortfall > 0) {
      const otH = shortfall > 0 ? shortfall : 0;
      bucket.attendance_ot_hours = round2(bucket.attendance_ot_hours + otH);
      bucket.overtime_general_hours = round2(bucket.overtime_general_hours + otH);
      bucket.overtime_all_hours = round2(bucket.overtime_all_hours + otH);
      if (empRow) {
        empRow.attendance_ot_hours = round2(empRow.attendance_ot_hours + otH);
        empRow.overtime_general_hours = round2(empRow.overtime_general_hours + otH);
        empRow.overtime_all_hours = round2(empRow.overtime_all_hours + otH);
      }
    }
  }

  for (const ot of overtime) {
    const m = Number(String(ot.date).slice(5, 7));
    if (m < 1 || m > 12) continue;
    const bucket = months[m - 1];
    const eid = String(ot.employee_id);
    const empRow = empAgg.get(eid);
    const hours = Number(ot.hours || 0);
    if (!hours) continue;

    if (ot.status === 'Pending') {
      bucket.overtime_pending_hours = round2(bucket.overtime_pending_hours + hours);
      if (empRow) empRow.overtime_pending_hours = round2(empRow.overtime_pending_hours + hours);
      continue;
    }

    if (ot.status !== 'Approved') continue;

    const type = ot.ot_type || 'General';
    bucket.overtime_all_hours = round2(bucket.overtime_all_hours + hours);
    if (empRow) empRow.overtime_all_hours = round2(empRow.overtime_all_hours + hours);

    if (type === 'Management') {
      bucket.overtime_management_hours = round2(bucket.overtime_management_hours + hours);
      if (empRow) empRow.overtime_management_hours = round2(empRow.overtime_management_hours + hours);
    } else {
      bucket.overtime_general_hours = round2(bucket.overtime_general_hours + hours);
      if (empRow) empRow.overtime_general_hours = round2(empRow.overtime_general_hours + hours);
    }
  }

  for (const m of months) {
    m.early_checkout_minutes = Math.round(m.early_checkout_minutes);
    m.late_checkin_minutes = Math.round(m.late_checkin_minutes);
    m.penalty_minutes = Math.round(m.penalty_minutes);
  }

  const by_employee = [...empAgg.values()]
    .map((e) => ({
      ...e,
      early_checkout_minutes: Math.round(e.early_checkout_minutes),
      late_checkin_minutes: Math.round(e.late_checkin_minutes),
      penalty_minutes: Math.round(e.penalty_minutes),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    year: Number(year),
    months,
    totals: sumMonths(months),
    employee_count: employees.length,
    by_employee,
  };
}
