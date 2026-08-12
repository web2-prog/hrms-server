import mongoose from 'mongoose';

const attendanceSchema = new mongoose.Schema(
  {
    employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    // check_in / check_out: HH:MM:SS (legacy HH:MM still accepted)
    check_in: { type: String, default: null },
    check_out: { type: String, default: null },
    break_total: { type: Number, default: 0 }, // fractional minutes (second precision)
    break_started_at: { type: String, default: null }, // HH:MM:SS
    working_hours: { type: Number, default: 0 }, // decimal hours (second precision)
    status: { type: String, enum: ['Extra', 'Low', 'OnTime', 'Working', 'OnBreak', 'Absent'], default: 'Absent', index: true },
    surplus_shortfall: { type: Number, default: 0 }, // decimal hours (+ extra, - shortfall)
    /** When true, late check-in penalty minutes are waived for this day */
    penalty_waived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

attendanceSchema.index({ employee_id: 1, date: 1 }, { unique: true });
attendanceSchema.index({ date: 1, status: 1 });

export default mongoose.model('Attendance', attendanceSchema);
