import mongoose from 'mongoose';
import { hoursToMinutes, minutesToHours } from '../utils/helpers.js';

const schema = new mongoose.Schema(
  {
    employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    /** Decimal hours (kept for salary / monthly summary math). Always synced with minutes. */
    hours: { type: Number, required: true, min: 0.01 },
    /** Whole minutes — primary display unit (0.75h → 45). Always synced with hours. */
    minutes: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true, trim: true },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending', index: true },
    /** Set by admin/HR on approval: where hours are credited */
    ot_type: {
      type: String,
      enum: ['General', 'Management'],
      default: undefined,
    },
    applied_on: { type: Date, default: Date.now },
    decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    decided_on: { type: Date, default: null },
    decision_note: { type: String, default: '' },
  },
  { timestamps: true }
);

schema.pre('validate', function syncHoursMinutes(next) {
  if (this.isModified('minutes') && this.minutes != null && !this.isModified('hours')) {
    this.hours = minutesToHours(this.minutes);
  } else if (this.hours != null) {
    this.minutes = hoursToMinutes(this.hours);
  }
  next();
});

schema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    if (ret.minutes == null && ret.hours != null) {
      ret.minutes = hoursToMinutes(ret.hours);
    }
    if (ret.hours == null && ret.minutes != null) {
      ret.hours = minutesToHours(ret.minutes);
    }
    return ret;
  },
});

schema.index({ employee_id: 1, status: 1 });
schema.index({ employee_id: 1, date: 1 });

export default mongoose.model('OvertimeRequest', schema, 'overtime_requests');
