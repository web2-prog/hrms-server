import mongoose from 'mongoose';

const HOLIDAY_TYPES = ['Saturday', 'Festival', 'Vacation', 'Manual'];

const schema = new mongoose.Schema(
  {
    type: { type: String, enum: HOLIDAY_TYPES, required: true, index: true },
    name: { type: String, default: '' },
    /** Single-day holidays (Saturday / Festival / Manual) */
    date: { type: String, default: null },
    day: { type: String, default: '' },
    /** Range holidays (Vacation) */
    start_date: { type: String, default: null },
    end_date: { type: String, default: null },
    month: { type: Number, default: null },
    year: { type: Number, required: true },
  },
  { timestamps: true }
);

schema.index({ year: 1, type: 1 });
schema.index({ year: 1, month: 1, type: 1 });
schema.index({ date: 1 });
schema.index(
  { type: 1, date: 1 },
  {
    unique: true,
    partialFilterExpression: {
      date: { $type: 'string' },
      type: { $in: ['Saturday', 'Festival', 'Manual'] },
    },
  }
);

export { HOLIDAY_TYPES };
export default mongoose.model('Holiday', schema, 'holidays');
