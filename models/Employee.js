import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const employeeSchema = new mongoose.Schema(
  {
    employee_id: { type: String, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    phone: { type: String, default: '' },
    password: { type: String, required: true, select: false },
    department_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', index: true },
    role: { type: String, enum: ['admin', 'hr', 'employee'], default: 'employee', index: true },
    joining_date: { type: Date },
    photo_url: { type: String, default: '' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    base_salary: { type: Number, default: 0 },
    custom_shift_start: { type: String, default: null },
    custom_shift_end: { type: String, default: null },
    custom_working_hours_per_day: { type: Number, default: null },
    custom_half_day_hours: { type: Number, default: null },
    profile_details: {
      address: { type: String, default: '' },
      dob: { type: Date, default: null },
      gender: { type: String, default: '' },
      emergency_contact: { type: String, default: '' },
      personal_email: { type: String, default: '' },
      aadhaar_number: { type: String, default: '' },
    },
    bank_details: {
      bank_name: { type: String, default: '' },
      account_number: { type: String, default: '' },
      ifsc_code: { type: String, default: '' },
      account_holder_name: { type: String, default: '' },
      tax_id: { type: String, default: '' },
    },
    /** Legacy single-bond snapshot (kept in sync with primary Active bond). */
    bond_details: {
      bond_start_date: { type: Date, default: null },
      bond_end_date: { type: Date, default: null },
      bond_amount: { type: Number, default: 0 },
      bond_status: { type: String, default: '' },
    },
    /** Multiple bond records (Job / Internship, etc.). */
    bonds: [
      {
        type: { type: String, default: 'Job' },
        start_date: { type: Date, default: null },
        end_date: { type: Date, default: null },
        period_months: { type: Number, default: 12 },
        amount: { type: Number, default: 0 },
        status: { type: String, default: 'Active' },
        notes: { type: String, default: '' },
        /**
         * Joining security / proof (returned by company after bond):
         * - marksheet_12th: employee submits 12th marksheet
         * - salary_deduction: % of monthly salary held during bond
         */
        proof_type: {
          type: String,
          enum: ['', 'marksheet_12th', 'salary_deduction'],
          default: '',
        },
        proof_status: {
          type: String,
          enum: ['', 'Held', 'Returned'],
          default: '',
        },
        proof_returned_date: { type: Date, default: null },
        salary_deduction_percent: { type: Number, default: 15 },
      },
    ],
    /**
     * Stepped monthly salary bands (e.g. increment every 3 months during a 1-year bond).
     * Salary slip generation uses the band covering that month.
     */
    salary_schedule: [
      {
        start_date: { type: String, default: null },
        end_date: { type: String, default: null },
        monthly_salary: { type: Number, default: 0 },
        label: { type: String, default: '' },
        step_index: { type: Number, default: 0 },
      },
    ],
  },
  { timestamps: true }
);

employeeSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

employeeSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

employeeSchema.virtual('has_custom_shift').get(function () {
  return !!(
    this.custom_shift_start ||
    this.custom_shift_end ||
    this.custom_working_hours_per_day != null ||
    this.custom_half_day_hours != null
  );
});

employeeSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.password;
    return ret;
  },
});

export default mongoose.model('Employee', employeeSchema);
