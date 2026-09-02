import Employee from '../models/Employee.js';

const ELEVATED_ROLES = new Set(['admin', 'hr']);

export function isElevatedRole(role) {
  return ELEVATED_ROLES.has(role);
}

function sameId(a, b) {
  return String(a) === String(b);
}

/**
 * Resolve a target employee document (or lean object with role) from an id or doc.
 * @returns {Promise<{ _id: unknown, role: string } | null>}
 */
export async function resolveTargetEmployee(target) {
  if (!target) return null;
  if (typeof target === 'object' && target.role) {
    return { _id: target._id, role: target.role };
  }
  const id = typeof target === 'object' ? target._id || target : target;
  if (!id) return null;
  const emp = await Employee.findById(id).select('_id role').lean();
  return emp;
}

/**
 * Attendance time edits:
 * - HR (and employees) cannot change their own time
 * - Only Admin can change Admin/HR attendance time
 * Admin may edit anyone including themselves.
 *
 * @returns {string | null} error message, or null if allowed
 */
export function attendanceTimePermissionError(actor, targetEmployee) {
  if (!actor || !targetEmployee) return 'Employee not found';

  if (sameId(actor._id, targetEmployee._id) && actor.role !== 'admin') {
    return 'You cannot change your own attendance time. Ask an admin.';
  }

  if (isElevatedRole(targetEmployee.role) && actor.role !== 'admin') {
    return 'Only an admin can change attendance time for admin or HR accounts.';
  }

  return null;
}

/**
 * Request decisions (leave, OT, early checkout, cover time):
 * - Nobody can decide their own request
 * - Only Admin can decide requests for Admin/HR
 *
 * @returns {string | null} error message, or null if allowed
 */
export function requestDecidePermissionError(actor, targetEmployee) {
  if (!actor || !targetEmployee) return 'Employee not found';

  if (sameId(actor._id, targetEmployee._id)) {
    return 'You cannot approve or reject your own request. Ask an admin.';
  }

  if (isElevatedRole(targetEmployee.role) && actor.role !== 'admin') {
    return 'Only an admin can approve or reject requests for admin or HR accounts.';
  }

  return null;
}

/** Convenience: load target + return attendance permission error (or null). */
export async function assertCanManageAttendanceTime(actor, targetOrId) {
  const target = await resolveTargetEmployee(targetOrId);
  if (!target) return { error: 'Employee not found', status: 404 };
  const message = attendanceTimePermissionError(actor, target);
  if (message) return { error: message, status: 403 };
  return { target };
}

/**
 * Generic staff-record actions (shortfall, salary overrides, etc.):
 * HR cannot act on self; only Admin can act on Admin/HR.
 */
export function staffRecordPermissionError(actor, targetEmployee, actionLabel = 'manage this record') {
  if (!actor || !targetEmployee) return 'Employee not found';
  if (sameId(actor._id, targetEmployee._id) && actor.role !== 'admin') {
    return `You cannot ${actionLabel} for your own account. Ask an admin.`;
  }
  if (isElevatedRole(targetEmployee.role) && actor.role !== 'admin') {
    return `Only an admin can ${actionLabel} for admin or HR accounts.`;
  }
  return null;
}

export async function assertCanActOnStaffRecord(actor, targetOrId, actionLabel) {
  const target = await resolveTargetEmployee(targetOrId);
  if (!target) return { error: 'Employee not found', status: 404 };
  const message = staffRecordPermissionError(actor, target, actionLabel);
  if (message) return { error: message, status: 403 };
  return { target };
}

/** Convenience: load target + return decide permission error (or null). */
export async function assertCanDecideRequest(actor, targetOrId) {
  const target = await resolveTargetEmployee(targetOrId);
  if (!target) return { error: 'Employee not found', status: 404 };
  const message = requestDecidePermissionError(actor, target);
  if (message) return { error: message, status: 403 };
  return { target };
}
