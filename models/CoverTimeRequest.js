import mongoose from 'mongoose';

/** Minimum cover duration an employee must work after daily hours before checkout (45 minutes). */
export const MIN_COVER_HOURS = 0.75;

/**
 * Cover time lets an employee make up shortfall hours (e.g. after an early checkout)
 * by staying past the daily working-hours target. Approved cover hours count toward
 * monthly working hours (not overtime).
 */
const coverTimeRequestSchema = new mongoose.Schema(
  {
    employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    attendance_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', required: true },
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    /** Hours the employee intends to cover (min 45m). */
    requested_hours: { type: Number, required: true, min: MIN_COVER_HOURS },
    /**
     * Hours actually worked past the daily target on checkout, capped at requested_hours.
     * Set when the employee checks out (or when HR finalizes after checkout).
     */
    actual_cover_hours: { type: Number, default: 0, min: 0 },
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

coverTimeRequestSchema.index({ employee_id: 1, date: 1, status: 1 });

export default mongoose.model('CoverTimeRequest', coverTimeRequestSchema);
