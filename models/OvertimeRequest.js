import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    hours: { type: Number, required: true, min: 0.01 },
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

schema.index({ employee_id: 1, status: 1 });
schema.index({ employee_id: 1, date: 1 });

export default mongoose.model('OvertimeRequest', schema, 'overtime_requests');
