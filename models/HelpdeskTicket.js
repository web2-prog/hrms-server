import mongoose from 'mongoose';

const TICKET_TYPES = ['Complaint', 'HR Request'];
const TICKET_STATUSES = ['Pending', 'In Progress', 'Resolved', 'Rejected'];
const TICKET_PRIORITIES = ['Low', 'Medium', 'High'];

const schema = new mongoose.Schema(
  {
    employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    type: { type: String, enum: TICKET_TYPES, required: true, index: true },
    subject: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    priority: { type: String, enum: TICKET_PRIORITIES, default: 'Medium', index: true },
    status: { type: String, enum: TICKET_STATUSES, default: 'Pending', index: true },
    admin_response: { type: String, default: '' },
    handled_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    handled_on: { type: Date, default: null },
  },
  { timestamps: true }
);

schema.index({ employee_id: 1, status: 1 });
schema.index({ type: 1, status: 1 });

export { TICKET_TYPES, TICKET_STATUSES, TICKET_PRIORITIES };
export default mongoose.model('HelpdeskTicket', schema, 'helpdesk_tickets');
