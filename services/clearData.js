import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import OvertimeRequest from '../models/OvertimeRequest.js';
import SalarySlip from '../models/SalarySlip.js';
import MonthlySummary from '../models/MonthlySummary.js';
import AuditLog from '../models/AuditLog.js';

export async function clearEmployeeData({ employeeId, start, end, performedBy }) {
  const dateFilter = { $gte: start, $lte: end };

  const att = await Attendance.deleteMany({ employee_id: employeeId, date: dateFilter });
  const leaves = await Leave.deleteMany({
    employee_id: employeeId,
    $or: [
      { from_date: dateFilter },
      { to_date: dateFilter },
      { from_date: { $lte: start }, to_date: { $gte: end } },
    ],
  });
  const overtime = await OvertimeRequest.deleteMany({ employee_id: employeeId, date: dateFilter });

  const startY = parseInt(start.slice(0, 4), 10);
  const startM = parseInt(start.slice(5, 7), 10);
  const endY = parseInt(end.slice(0, 4), 10);
  const endM = parseInt(end.slice(5, 7), 10);

  const slipFilter = {
    employee_id: employeeId,
    $or: [],
  };
  for (let y = startY; y <= endY; y++) {
    const mStart = y === startY ? startM : 1;
    const mEnd = y === endY ? endM : 12;
    for (let m = mStart; m <= mEnd; m++) {
      slipFilter.$or.push({ month: m, year: y });
    }
  }
  const slips = slipFilter.$or.length
    ? await SalarySlip.deleteMany({ employee_id: employeeId, $or: slipFilter.$or })
    : { deletedCount: 0 };
  const summaries = slipFilter.$or.length
    ? await MonthlySummary.deleteMany({ employee_id: employeeId, $or: slipFilter.$or })
    : { deletedCount: 0 };

  await AuditLog.create({
    action: 'clear_data',
    performed_by: performedBy,
    target_employee_id: employeeId,
    details: {
      attendance_deleted: att.deletedCount,
      leaves_deleted: leaves.deletedCount,
      overtime_deleted: overtime.deletedCount,
      salary_slips_deleted: slips.deletedCount,
      monthly_summary_deleted: summaries.deletedCount,
    },
    date_range: { start, end },
  });

  return {
    attendance_deleted: att.deletedCount,
    leaves_deleted: leaves.deletedCount,
    overtime_deleted: overtime.deletedCount,
    salary_slips_deleted: slips.deletedCount,
    monthly_summary_deleted: summaries.deletedCount,
  };
}
