import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    overtime_multiplier: { type: Number, default: 1.5 },
    deduction_multiplier: { type: Number, default: 1.0 },
  },
  { timestamps: true }
);

export default mongoose.model('SystemSettings', schema, 'system_settings');
