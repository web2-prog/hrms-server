import Attendance from '../models/Attendance.js';
import OvertimeRequest from '../models/OvertimeRequest.js';
import Employee from '../models/Employee.js';
import Department from '../models/Department.js';
import { resolveEffectiveShift } from '../services/shift.js';
import { lateCheckInPenalty, minutesBetween } from '../utils/helpers.js';
import { earlyMinutesForRequest, loadApprovedEarlyCheckouts } from './earlyCheckout.js';

function departmentRefId(dept) {
  if (!dept) return null;
  if (typeof dept === 'object') {
    const id = dept._id ?? dept.id;
    return id ? String(id) : null;
  }
  return String(dept);
}

function departmentRefName(dept) {
  if (dept && typeof dept === 'object' && dept.name) return dept.name;
  return '—';
}

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

function emptyEmpAgg(emp) {
  return {
    employee_id: emp._id,
    name: emp.name,
    code: emp.employee_id,
    department: departmentRefName(emp.department_id),
    department_id: departmentRefId(emp.department_id),
    attendance_days: 0,
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

function rollupByDepartment(byEmployee) {
  const deptMap = new Map();
  for (const e of byEmployee) {
    const key = e.department_id ? String(e.department_id) : '__none__';
    let d = deptMap.get(key);
    if (!d) {
      d = {
        department_id: e.department_id || null,
        department: e.department_id ? e.department : 'No department',
        employee_count: 0,
        attendance_days: 0,
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
      deptMap.set(key, d);
    }
    d.employee_count += 1;
    d.attendance_days += e.attendance_days || 0;
    d.total_working_hours = round2(d.total_working_hours + (e.total_working_hours || 0));
    d.early_checkout_minutes += e.early_checkout_minutes || 0;
    d.early_checkout_count += e.early_checkout_count || 0;
    d.late_checkin_count += e.late_checkin_count || 0;
    d.late_checkin_minutes += e.late_checkin_minutes || 0;
    d.penalty_minutes += e.penalty_minutes || 0;
    d.low_time_hours = round2(d.low_time_hours + (e.low_time_hours || 0));
    d.low_time_count += e.low_time_count || 0;
    d.overtime_all_hours = round2(d.overtime_all_hours + (e.overtime_all_hours || 0));
    d.overtime_general_hours = round2(d.overtime_general_hours + (e.overtime_general_hours || 0));
    d.overtime_management_hours = round2(d.overtime_management_hours + (e.overtime_management_hours || 0));
    d.overtime_pending_hours = round2(d.overtime_pending_hours + (e.overtime_pending_hours || 0));
    d.attendance_ot_hours = round2(d.attendance_ot_hours + (e.attendance_ot_hours || 0));
  }
  return [...deptMap.values()].sort((a, b) => a.department.localeCompare(b.department));
}

/**
 * Org analytics for a calendar year (optionally filtered by month/dept/employee).
 * Monthly series always covers Jan–Dec for the year+dept scope.
 * `totals` / `by_employee` / `by_department` respect the optional month filter.
 * Late / early / penalty are derived from check times vs effective shift.
 */
export async function buildYearAnalytics({ year, month, department_id, employee_id }) {
  const empFilter = { role: 'employee', status: 'active' };
  if (department_id) empFilter.department_id = department_id;
  if (employee_id) empFilter._id = employee_id;

  const filterMonth = month != null && month !== '' ? Number(month) : null;
  const scopedMonth =
    filterMonth != null && Number.isFinite(filterMonth) && filterMonth >= 1 && filterMonth <= 12
      ? filterMonth
      : null;

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
      year: Number(year),
      month: scopedMonth,
      months,
      totals: sumMonths(months),
      employee_count: 0,
      by_employee: [],
      by_department: [],
    };
  }

  // Always load the full year for the monthly chart; employee/dept rollups
  // only include rows in the selected month when month is set.
  // Early checkout KPIs use approved EarlyCheckoutRequest records only —
  // not every attendance checkout before shift end.
  const [attendance, overtime, earlyCheckouts] = await Promise.all([
    Attendance.find({
      employee_id: { $in: empIds },
      date: { $regex: `^${year}` },
    })
      .select('employee_id date check_in check_out working_hours status surplus_shortfall penalty_waived penalty_minutes_override auto_checkout')
      .lean(),
    OvertimeRequest.find({
      employee_id: { $in: empIds },
      date: { $regex: `^${year}` },
    })
      .select('employee_id date hours status ot_type')
      .lean(),
    loadApprovedEarlyCheckouts({ employeeIds: empIds, datePrefix: String(year) }),
  ]);

  const empAgg = new Map();
  for (const emp of employees) {
    empAgg.set(String(emp._id), emptyEmpAgg(emp));
  }

  for (const row of attendance) {
    const m = Number(String(row.date).slice(5, 7));
    if (m < 1 || m > 12) continue;
    const bucket = months[m - 1];
    const eid = String(row.employee_id);
    const inScope = !scopedMonth || m === scopedMonth;
    const empRow = inScope ? empAgg.get(eid) : null;
    const shift = shiftByEmp.get(eid);
    if (!shift) continue;

    // Only days with a real check-in count as tracked attendance.
    const tracked = !!(row.check_in && String(row.check_in).trim());
    const worked = Number(row.working_hours || 0);
    if (tracked) {
      bucket.total_working_hours = round2(bucket.total_working_hours + worked);
      if (empRow) {
        empRow.total_working_hours = round2(empRow.total_working_hours + worked);
        empRow.attendance_days += 1;
      }
    } else {
      continue;
    }

    if (row.check_in && shift.shift_start) {
      const lateMins = minutesBetween(shift.shift_start, row.check_in);
      const penalty = lateCheckInPenalty(
        row.check_in,
        shift.shift_start,
        !!row.penalty_waived,
        shift.late_buffer_minutes,
        row.penalty_minutes_override
      );
      if (penalty.late) {
        bucket.late_checkin_count += 1;
        bucket.late_checkin_minutes += lateMins;
        if (penalty.penalty_minutes) {
          bucket.penalty_minutes += penalty.penalty_minutes;
        }
        if (empRow) {
          empRow.late_checkin_count += 1;
          empRow.late_checkin_minutes += lateMins;
          if (penalty.penalty_minutes) {
            empRow.penalty_minutes += penalty.penalty_minutes;
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

    // Auto-checkout days (session left open until 11:55 PM) do not earn OT —
    // same rule as monthlyHours.js and the Overtime page. Exclude them here so
    // the Analytics totals match the Performance/Overtime numbers.
    if ((row.status === 'Extra' || shortfall > 0) && !row.auto_checkout) {
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

  for (const req of earlyCheckouts) {
    const m = Number(String(req.date).slice(5, 7));
    if (m < 1 || m > 12) continue;
    const bucket = months[m - 1];
    const eid = String(req.employee_id);
    const inScope = !scopedMonth || m === scopedMonth;
    const empRow = inScope ? empAgg.get(eid) : null;
    const shift = shiftByEmp.get(eid);
    if (!shift?.shift_end) continue;
    const earlyMins = earlyMinutesForRequest(req.requested_time, shift.shift_end);
    if (earlyMins <= 0) continue;
    bucket.early_checkout_minutes += earlyMins;
    bucket.early_checkout_count += 1;
    if (empRow) {
      empRow.early_checkout_minutes += earlyMins;
      empRow.early_checkout_count += 1;
    }
  }

  for (const ot of overtime) {
    const m = Number(String(ot.date).slice(5, 7));
    if (m < 1 || m > 12) continue;
    const bucket = months[m - 1];
    const eid = String(ot.employee_id);
    const inScope = !scopedMonth || m === scopedMonth;
    const empRow = inScope ? empAgg.get(eid) : null;
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

  const by_department = rollupByDepartment(by_employee);
  const totals = scopedMonth ? { ...months[scopedMonth - 1] } : sumMonths(months);
  if (totals.month != null) delete totals.month;
  if (totals.label != null) delete totals.label;

  return {
    year: Number(year),
    month: scopedMonth,
    months,
    totals,
    employee_count: employees.length,
    by_employee,
    by_department,
  };
}

/**
 * Per-department attendance aggregates for a calendar year (optionally a month),
 * grouped from the same per-employee metrics as buildYearAnalytics.
 * Only active employee-role members are counted.
 * Every department is returned (even with zero attendance) so UI lookups never miss.
 */
export async function buildDepartmentAnalytics({ year, month }) {
  const [org, departments] = await Promise.all([
    buildYearAnalytics({ year, month }),
    Department.find({}).select('_id name').sort({ name: 1 }).lean(),
  ]);

  const deptMap = new Map();
  for (const dept of departments) {
    const key = String(dept._id);
    deptMap.set(key, {
      department_id: key,
      department: dept.name,
      employee_count: 0,
      attendance_days: 0,
      total_working_hours: 0,
      late_checkin_count: 0,
      early_checkout_count: 0,
      penalty_minutes: 0,
    });
  }

  for (const e of org.by_employee) {
    const key = e.department_id ? String(e.department_id) : null;
    if (!key) continue;
    let d = deptMap.get(key);
    if (!d) {
      d = {
        department_id: key,
        department: e.department,
        employee_count: 0,
        attendance_days: 0,
        total_working_hours: 0,
        late_checkin_count: 0,
        early_checkout_count: 0,
        penalty_minutes: 0,
      };
      deptMap.set(key, d);
    }
    d.employee_count += 1;
    d.attendance_days += e.attendance_days;
    d.total_working_hours = round2(d.total_working_hours + e.total_working_hours);
    d.late_checkin_count += e.late_checkin_count;
    d.early_checkout_count += e.early_checkout_count;
    d.penalty_minutes += e.penalty_minutes;
  }

  return {
    year: Number(org.year),
    month: org.month ?? null,
    departments: [...deptMap.values()].sort((a, b) => a.department.localeCompare(b.department)),
  };
}
