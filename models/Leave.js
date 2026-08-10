import mongoose from 'mongoose';

const leaveSchema = new mongoose.Schema(
  {
    employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    from_date: { type: String, required: true, index: true },
    to_date: { type: String, required: true, index: true },
    day_type: { type: String, enum: ['Full Day', 'Half Day'], default: 'Full Day', index: true },
    reason: { type: String, default: '' },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending', index: true },
    applied_on: { type: Date, default: Date.now },
    approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    approved_on: { type: Date, default: null },
  },
  { timestamps: true }
);

leaveSchema.index({ employee_id: 1, status: 1 });

export default mongoose.model('Leave', leaveSchema);
