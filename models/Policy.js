import mongoose from 'mongoose';

const POLICY_CATEGORIES = ['General', 'Attendance', 'Leave', 'Code of Conduct', 'Salary', 'Other'];

const schema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true },
    category: { type: String, enum: POLICY_CATEGORIES, default: 'General', index: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    effective_date: { type: String, default: null },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  },
  { timestamps: true }
);

schema.index({ title: 'text', content: 'text' });

export { POLICY_CATEGORIES };
export default mongoose.model('Policy', schema, 'policies');
