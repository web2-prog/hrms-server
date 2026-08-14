import Employee from '../models/Employee.js';
import AuditLog from '../models/AuditLog.js';
import { parseListQuery, listResponse, nextEmployeeId } from '../utils/helpers.js';
import { clearEmployeeData } from '../services/clearData.js';
import {
  ensureBondsArray,
  resolveCurrentSalary,
  syncLegacyBondDetails,
  toISODate,
} from '../services/salarySchedule.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, '..', 'uploads');

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const filter = {};
    if (req.query.department_id) filter.department_id = req.query.department_id;
    if (req.query.role) filter.role = req.query.role;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.custom_shift === 'true') {
      filter.$or = [
        { custom_shift_start: { $ne: null } },
        { custom_shift_end: { $ne: null } },
        { custom_working_hours_per_day: { $ne: null } },
      ];
    }
    if (search) {
      filter.$and = filter.$and || [];
      filter.$and.push({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { employee_id: { $regex: search, $options: 'i' } },
          { phone: { $regex: search, $options: 'i' } },
        ],
      });
    }
    const [data, total] = await Promise.all([
      Employee.find(filter).populate('department_id').sort({ createdAt: -1 }).skip(skip).limit(limit),
      Employee.countDocuments(filter),
    ]);
    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function create(req, res) {
  try {
    const body = { ...req.body };
    if (!body.password) body.password = 'Welcome@123';
    body.employee_id = body.employee_id || (await nextEmployeeId(Employee));
    if (req.file) body.photo_url = `/uploads/${req.file.filename}`;
    const emp = await Employee.create(body);
    const populated = await Employee.findById(emp._id).populate('department_id');
    res.status(201).json(populated);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function getOne(req, res) {
  const emp = await Employee.findById(req.params.id).populate('department_id');
  if (!emp) return res.status(404).json({ message: 'Not found' });
  if (req.user.role === 'employee' && String(req.user._id) !== String(emp._id)) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  const json = emp.toJSON();
  json.bonds = ensureBondsArray(json);
  json.current_salary = resolveCurrentSalary(json);
  res.json(json);
}

export async function update(req, res) {
  try {
    if (req.user.role === 'hr') {
      // HR cannot change role to admin or department structure fields beyond assignment
      delete req.body.role;
    }
    const updates = { ...req.body };
    if (req.file) updates.photo_url = `/uploads/${req.file.filename}`;

    // Handle shift toggle: clear custom if using department default
    if (updates.use_department_default === true || updates.use_department_default === 'true') {
      updates.custom_shift_start = null;
      updates.custom_shift_end = null;
      updates.custom_working_hours_per_day = null;
    }
    delete updates.use_department_default;
    delete updates.password;
    delete updates.current_salary;

    if (Array.isArray(updates.bonds)) {
      updates.bonds = updates.bonds.map((b) => {
        const proof_type = ['marksheet_12th', 'salary_deduction'].includes(b.proof_type)
          ? b.proof_type
          : '';
        let proof_status = ['Held', 'Returned'].includes(b.proof_status) ? b.proof_status : '';
        if (proof_type && !proof_status) proof_status = 'Held';
        if (!proof_type) proof_status = '';
        return {
          type: b.type || 'Job',
          start_date: b.start_date || null,
          end_date: b.end_date || null,
          period_months: Number(b.period_months) || 12,
          amount: Number(b.amount) || 0,
          status: b.status || 'Active',
          notes: b.notes || '',
          proof_type,
          proof_status,
          proof_returned_date:
            proof_status === 'Returned' ? b.proof_returned_date || new Date() : null,
          salary_deduction_percent:
            proof_type === 'salary_deduction' ? Number(b.salary_deduction_percent) || 15 : 15,
        };
      });
      updates.bond_details = syncLegacyBondDetails(updates.bonds);
    }

    if (Array.isArray(updates.salary_schedule)) {
      updates.salary_schedule = updates.salary_schedule.map((s, i) => ({
        start_date: toISODate(s.start_date),
        end_date: toISODate(s.end_date),
        monthly_salary: Number(s.monthly_salary) || 0,
        label: s.label || '',
        step_index: s.step_index != null ? Number(s.step_index) : i,
      }));
      const existing = await Employee.findById(req.params.id).select('base_salary');
      const current = resolveCurrentSalary({
        salary_schedule: updates.salary_schedule,
        base_salary: updates.base_salary ?? existing?.base_salary,
      });
      if (current > 0) updates.base_salary = current;
    }

    const emp = await Employee.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true }).populate(
      'department_id'
    );
    if (!emp) return res.status(404).json({ message: 'Not found' });
    const json = emp.toJSON();
    json.bonds = ensureBondsArray(json);
    json.current_salary = resolveCurrentSalary(json);
    res.json(json);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

/**
 * Admin/HR sets a new password for an employee (no current password needed).
 * The pre-save hook re-hashes it with bcrypt.
 */
export async function resetPassword(req, res) {
  try {
    const emp = await Employee.findById(req.params.id).select('+password');
    if (!emp) return res.status(404).json({ message: 'Not found' });
    const { new_password } = req.body;
    if (!new_password || String(new_password).length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }
    emp.password = String(new_password);
    await emp.save();
    await AuditLog.create({
      action: 'password_reset',
      performed_by: req.user._id,
      target_employee_id: emp._id,
      details: { reset_by_role: req.user.role, email: emp.email },
    });
    res.json({ message: 'Password updated' });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function clearData(req, res) {
  try {
    const { start_date, end_date } = req.body;
    if (!start_date || !end_date) return res.status(400).json({ message: 'start_date and end_date required' });
    const result = await clearEmployeeData({
      employeeId: req.params.id,
      start: start_date,
      end: end_date,
      performedBy: req.user._id,
    });
    res.json({ message: 'Data cleared', ...result });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function uploadOfferLetter(req, res) {
  try {
    if (!req.file) return res.status(400).json({ message: 'Offer letter file is required' });
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(404).json({ message: 'Not found' });

    // Remove previous file if present
    if (emp.offer_letter_url) {
      const prev = path.join(uploadDir, path.basename(emp.offer_letter_url));
      if (fs.existsSync(prev)) {
        try {
          fs.unlinkSync(prev);
        } catch {
          /* ignore */
        }
      }
    }

    emp.offer_letter_url = `/uploads/${req.file.filename}`;
    emp.offer_letter_name = req.file.originalname || req.file.filename;
    await emp.save();

    const populated = await Employee.findById(emp._id).populate('department_id');
    const json = populated.toJSON();
    json.bonds = ensureBondsArray(json);
    json.current_salary = resolveCurrentSalary(json);
    res.json(json);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function downloadOfferLetter(req, res) {
  try {
    const emp = await Employee.findById(req.params.id).select('name employee_id offer_letter_url offer_letter_name');
    if (!emp) return res.status(404).json({ message: 'Not found' });
    if (req.user.role === 'employee' && String(req.user._id) !== String(emp._id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (!emp.offer_letter_url) {
      return res.status(404).json({ message: 'Offer letter not uploaded' });
    }

    const filePath = path.join(uploadDir, path.basename(emp.offer_letter_url));
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'Offer letter file missing' });
    }

    const downloadName =
      emp.offer_letter_name ||
      `Offer-Letter-${emp.employee_id || emp.name || emp._id}${path.extname(filePath)}`;
    res.download(filePath, downloadName);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function removeOfferLetter(req, res) {
  try {
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(404).json({ message: 'Not found' });
    if (emp.offer_letter_url) {
      const prev = path.join(uploadDir, path.basename(emp.offer_letter_url));
      if (fs.existsSync(prev)) {
        try {
          fs.unlinkSync(prev);
        } catch {
          /* ignore */
        }
      }
    }
    emp.offer_letter_url = '';
    emp.offer_letter_name = '';
    await emp.save();
    res.json({ message: 'Offer letter removed' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
