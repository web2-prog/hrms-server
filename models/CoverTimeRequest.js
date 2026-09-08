import mongoose from 'mongoose';
import { hoursToMinutes, minutesToHours } from '../utils/helpers.js';

/** Minimum cover duration an employee must work after daily hours before checkout (45 minutes). */
export const MIN_COVER_HOURS = 0.75;
export const MIN_COVER_MINUTES = 45;

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
    /** Auto hours at request: surplus past daily target, capped by monthly shortfall (min 45m). */
    requested_hours: { type: Number, required: true, min: MIN_COVER_HOURS },
    /** Whole minutes synced with requested_hours (0.75 → 45). */
    requested_minutes: { type: Number, required: true, min: MIN_COVER_MINUTES },
    /**
     * Hours actually worked past the daily target on checkout, capped at requested_hours.
     * Set when the employee checks out (or when HR finalizes after checkout).
     */
    actual_cover_hours: { type: Number, default: 0, min: 0 },
    actual_cover_minutes: { type: Number, default: 0, min: 0 },
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

coverTimeRequestSchema.pre('validate', function syncHoursMinutes(next) {
  if (this.isModified('requested_minutes') && this.requested_minutes != null && !this.isModified('requested_hours')) {
    this.requested_hours = minutesToHours(this.requested_minutes);
  } else if (this.requested_hours != null) {
    this.requested_minutes = hoursToMinutes(this.requested_hours);
  }
  if (this.isModified('actual_cover_minutes') && this.actual_cover_minutes != null && !this.isModified('actual_cover_hours')) {
    this.actual_cover_hours = minutesToHours(this.actual_cover_minutes);
  } else if (this.actual_cover_hours != null) {
    this.actual_cover_minutes = hoursToMinutes(this.actual_cover_hours);
  }
  next();
});

coverTimeRequestSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    if (ret.requested_minutes == null && ret.requested_hours != null) {
      ret.requested_minutes = hoursToMinutes(ret.requested_hours);
    }
    if (ret.actual_cover_minutes == null && ret.actual_cover_hours != null) {
      ret.actual_cover_minutes = hoursToMinutes(ret.actual_cover_hours);
    }
    return ret;
  },
});

coverTimeRequestSchema.index({ employee_id: 1, date: 1, status: 1 });

export default mongoose.model('CoverTimeRequest', coverTimeRequestSchema);
