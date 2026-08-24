import mongoose from 'mongoose';

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    working_hours_per_day: { type: Number, required: true }, // hours as decimal e.g. 8.25 = 8h 15m
    /** Half-day leave / target credit; defaults to working_hours_per_day ÷ 2 when unset */
    half_day_hours: { type: Number, default: null },
    shift_start: { type: String, required: true }, // "09:30"
    shift_end: { type: String, required: true },
    // Grace after shift start. Cutoff minute is inclusive:
    // 08:45 + 15 minutes permits check-in through 09:00:59.
    // From 09:01 penalty is max(15, minutes past buffer end).
    late_buffer_minutes: {
      type: Number,
      default: 15,
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
