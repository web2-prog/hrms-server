import mongoose from 'mongoose';

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    working_hours_per_day: { type: Number, required: true }, // hours as decimal e.g. 8.25 = 8h 15m
    /** Half-day leave / target credit; defaults to working_hours_per_day ÷ 2 when unset */
    half_day_hours: { type: Number, default: null },
    shift_start: { type: String, required: true }, // "09:30"
    shift_end: { type: String, required: true },
    // Grace period after shift start. The cutoff minute is inclusive:
    // 08:45 + 20 minutes permits check-in through 09:05:59; 09:06 starts the penalty.
    late_buffer_minutes: {
      type: Number,
      default: 20,
      min: 0,
      max: 240,
      validate: {
        validator: Number.isInteger,
        message: 'Late buffer must be a whole number of minutes',
      },
    },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  },
  { timestamps: true }
);

export default mongoose.model('Department', departmentSchema);
