import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    action: { type: String, required: true, index: true },
    performed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    target_employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    date_range: {
      start: { type: String, default: null },
      end: { type: String, default: null },
    },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

export default mongoose.model('AuditLog', schema, 'audit_logs');
