import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    month: { type: Number, required: true, min: 1, max: 12, index: true },
    year: { type: Number, required: true, min: 2026, index: true },
    /** Target before previous-month carry-in */
    base_monthly_target_hours: { type: Number, default: 0 },
    /** Hours carried INTO this month from previous month's carry_forward decision */
    carried_forward_hours: { type: Number, default: 0 },
    /** Final monthly target = base + carried_forward */
    monthly_target_hours: { type: Number, default: 0 },
    monthly_counted_hours: { type: Number, default: 0 },
    monthly_shortfall_or_surplus: { type: Number, default: 0 },
    /** Current pending shortfall hours (max(0, target - counted)) */
    pending_hours: { type: Number, default: 0 },
    working_days_in_month: { type: Number, default: 0 },
    approved_leave_days_in_month: { type: Number, default: 0 },
    overtime_hours: { type: Number, default: 0 },
    attendance_ot_hours: { type: Number, default: 0 },
    management_ot_hours: { type: Number, default: 0 },
    /** Approved cover-time hours counted toward monthly working hours (not OT). */
    cover_time_hours: { type: Number, default: 0 },
    low_hours: { type: Number, default: 0 },
    /**
     * Month-end decision for pending hours:
     * - deduct: salary deduction for this month
     * - carry_forward: add pending hours to next month's target
     */
    shortfall_action: {
      type: String,
      enum: ['deduct', 'carry_forward'],
      default: undefined,
    },
    /** Hours sent to next month when shortfall_action is carry_forward */
    carried_to_next_hours: { type: Number, default: 0 },
    shortfall_decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    shortfall_decided_on: { type: Date, default: null },
  },
  { timestamps: true }
);

schema.index({ employee_id: 1, month: 1, year: 1 }, { unique: true });

export default mongoose.model('MonthlySummary', schema, 'monthly_summary');
