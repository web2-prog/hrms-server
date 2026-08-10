import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    month: { type: Number, required: true, index: true },
    year: { type: Number, required: true, index: true },
    base_salary: { type: Number, default: 0 },
    monthly_target_hours: { type: Number, default: 0 },
    monthly_counted_hours: { type: Number, default: 0 },
    overtime_hours: { type: Number, default: 0 },
    shortfall_hours: { type: Number, default: 0 },
    /** Month-end decision applied when slip was generated */
    shortfall_action: { type: String, enum: ['deduct', 'carry_forward'], default: undefined },
    deduction_amount: { type: Number, default: 0 }, // shortfall hours deduction
    leave_deduction_amount: { type: Number, default: 0 }, // unpaid / LOP leave
    early_checkout_minutes: { type: Number, default: 0 },
    early_checkout_deduction_amount: { type: Number, default: 0 },
    overtime_amount: { type: Number, default: 0 },
    /** Security hold when joining proof is salary_deduction (returned after bond). */
    bond_security_deduction: { type: Number, default: 0 },
    bond_security_percent: { type: Number, default: 0 },
    tds: { type: Number, default: 0 },
    net_pay: { type: Number, default: 0 },
    /** Payslip display meta (Zoho-style) */
    company_key: { type: String, enum: ['kriraai', 'ondial'], default: 'kriraai' },
    company_name: { type: String, default: 'KriraAI Pvt. Ltd.' },
    company_address: {
      type: String,
      default: 'C2-1310, Pragati IT Park, opp. AR Mall, Mota Varachha Road, Uttran, Surat',
    },
    pay_date: { type: String, default: '' },
    paid_days: { type: Number, default: 0 },
    lop_days: { type: Number, default: 0 },
    pf_no: { type: String, default: 'NA' },
    uan: { type: String, default: 'NA' },
    status: { type: String, enum: ['Draft', 'Finalized'], default: 'Draft', index: true },
    payment_status: { type: String, enum: ['Pending', 'Paid'], default: 'Pending', index: true },
    paid_date: { type: Date, default: null },
    payment_reference: { type: String, default: '' },
    adjustment_note: { type: String, default: '' },
    generated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    generated_on: { type: Date, default: Date.now },
    finalized_on: { type: Date, default: null },
  },
  { timestamps: true }
);

schema.index({ employee_id: 1, month: 1, year: 1 }, { unique: true });
schema.index({ payment_status: 1, year: 1 });

export default mongoose.model('SalarySlip', schema, 'salary_slips');
