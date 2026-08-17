import Employee from '../models/Employee.js';
import Department from '../models/Department.js';
import { DEFAULT_LATE_BUFFER_MINUTES, normalizeLateBufferMinutes } from '../utils/helpers.js';

export function resolveEffectiveShift(employee, department) {
  const dept = department || employee.department_id;
  const useCustom =
    employee.custom_shift_start ||
    employee.custom_shift_end ||
    employee.custom_working_hours_per_day != null;

  return {
    shift_start: useCustom && employee.custom_shift_start ? employee.custom_shift_start : dept?.shift_start || '09:30',
    shift_end: useCustom && employee.custom_shift_end ? employee.custom_shift_end : dept?.shift_end || '17:30',
    // Company standard daily hours: 8h 15m (8.25) unless employee has a custom override
    working_hours_per_day:
      useCustom && employee.custom_working_hours_per_day != null
        ? employee.custom_working_hours_per_day
        : dept?.working_hours_per_day ?? 8.25,
    late_buffer_minutes: normalizeLateBufferMinutes(dept?.late_buffer_minutes ?? DEFAULT_LATE_BUFFER_MINUTES),
    has_custom: !!useCustom,
  };
}

export async function getEffectiveShiftForEmployee(employeeId) {
  const employee = await Employee.findById(employeeId).populate('department_id');
  if (!employee) return null;
  let dept = employee.department_id;
  if (dept && !dept.working_hours_per_day) {
    dept = await Department.findById(employee.department_id);
  }
  return { employee, ...resolveEffectiveShift(employee, dept) };
}

export function computeDailyStatus(workingHours, threshold) {
  const diff = workingHours - threshold;
  const eps = 1 / 120; // ~30 seconds
  if (Math.abs(diff) < eps) return { status: 'OnTime', surplus_shortfall: 0 };
  if (diff > 0) return { status: 'Extra', surplus_shortfall: diff };
  return { status: 'Low', surplus_shortfall: diff };
}
