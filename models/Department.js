import mongoose from 'mongoose';

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    working_hours_per_day: { type: Number, required: true }, // hours as decimal e.g. 8.25
    shift_start: { type: String, required: true }, // "09:30"
    shift_end: { type: String, required: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  },
  { timestamps: true }
);

export default mongoose.model('Department', departmentSchema);
