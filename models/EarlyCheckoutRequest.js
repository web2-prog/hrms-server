import mongoose from 'mongoose';

// An employee asks to leave before shift end. HR/Admin must approve or reject.
// On approval the attendance record gets check_out = requested_time.
const earlyCheckoutRequestSchema = new mongoose.Schema(
  {
    employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    attendance_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', required: true },
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    requested_time: { type: String, required: true }, // HH:MM:SS — the moment the employee asked to leave
    reason: { type: String, default: '' },
    status: {
      type: String,
      enum: ['Pending', 'Approved', 'Rejected', 'Cancelled'],
      default: 'Pending',
      index: true,
    },
    decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    decided_at: { type: Date, default: null },
    decision_note: { type: String, default: '' },
  },
  { timestamps: true }
);

earlyCheckoutRequestSchema.index({ employee_id: 1, date: 1, status: 1 });

export default mongoose.model('EarlyCheckoutRequest', earlyCheckoutRequestSchema);
