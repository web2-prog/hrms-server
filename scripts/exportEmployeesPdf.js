/**
 * Export ALL employee profiles from MongoDB database `hrms` to a single PDF.
 * Includes: basic, contact, bank, bond, guardian, package, shift overrides.
 * Progress bar shown in terminal.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cliProgress from 'cli-progress';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'exports');
const OUT_FILE = path.join(OUT_DIR, `all_employees_profiles_${new Date().toISOString().slice(0, 10)}.pdf`);

function s(v) {
  if (v == null || v === '') return '—';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && v.$date) return String(v.$date).slice(0, 10);
  return String(v);
}

function fmtDate(v) {
  if (!v) return '—';
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toISOString().slice(0, 10);
  } catch {
    return '—';
  }
}

function drawSection(doc, title) {
  doc.moveDown(0.4);
  doc.fontSize(12).fillColor('#1E3A8A').text(title, { underline: true });
  doc.moveDown(0.2);
  doc.fontSize(9).fillColor('#111827');
}

function kv(doc, label, value, x1 = 50, x2 = 200) {
  const y = doc.y;
  doc.font('Helvetica-Bold').text(label, x1, y, { continued: false, width: 140 });
  doc.font('Helvetica').text(s(value), x2, y, { width: 340 });
}

function ensureSpace(doc, need = 80) {
  if (doc.y + need > doc.page.height - 50) doc.addPage();
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.client.db('hrms');
  const users = await db
    .collection('users')
    .find({})
    .project({ password: 0 })
    .sort({ name: 1 })
    .toArray();

  const total = users.length;
  if (total === 0) {
    console.error('No users found in database `hrms`.');
    process.exit(1);
  }

  console.log(`Fetching complete. Generating PDF for ${total} employees from DB: hrms`);

  const bar = new cliProgress.SingleBar(
    {
      format: 'PDF Export |{bar}| {percentage}% | {value}/{total} employees | {name}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(total, 0, { name: 'starting' });

  const doc = new PDFDocument({ margin: 50, size: 'A4', info: { Title: 'All Employees Profile Details', Author: 'HRMS Export' } });
  const stream = fs.createWriteStream(OUT_FILE);
  doc.pipe(stream);

  // Cover page
  doc.fontSize(22).fillColor('#1E3A8A').text('HRMS — All Employees Profile Details', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).fillColor('#111827').text(`Database: hrms`, { align: 'center' });
  doc.text(`Collection: users`, { align: 'center' });
  doc.text(`Total employees: ${total}`, { align: 'center' });
  doc.text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
  doc.moveDown(2);
  doc.fontSize(10).fillColor('#6B7280').text(
    'Includes basic info, contact, bank details, bond details, guardian, package, and shift overrides for every employee. No employee omitted.',
    { align: 'center', width: 450 }
  );

  // Index
  doc.addPage();
  doc.fontSize(16).fillColor('#1E3A8A').text('Employee Index', { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(9).fillColor('#111827');
  users.forEach((u, i) => {
    ensureSpace(doc, 16);
    doc.text(`${String(i + 1).padStart(3, '0')}. ${u.name || '—'}  |  ${u.email || '—'}  |  ${u.role || '—'}  |  ${u.department || '—'}  |  ${u.isActive === false ? 'Inactive' : 'Active'}`);
  });

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    bar.update(i, { name: (u.name || 'employee').slice(0, 24) });

    doc.addPage();
    doc.fontSize(14).fillColor('#1E3A8A').text(`${i + 1}. ${u.name || 'Unnamed Employee'}`, { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#6B7280').text(`User ID: ${u._id}`);
    doc.fillColor('#111827');

    drawSection(doc, '1. Basic Details');
    kv(doc, 'Name', u.name);
    kv(doc, 'Username', u.username);
    kv(doc, 'Email', u.email);
    kv(doc, 'Role', u.role);
    kv(doc, 'Department', u.department);
    kv(doc, 'Status', u.isActive === false ? 'Inactive' : 'Active');
    kv(doc, 'Joining Date', fmtDate(u.joiningDate));
    kv(doc, 'Package (CTC)', u.package != null ? String(u.package) : '—');
    kv(doc, 'First Login Pending', u.isFirstLogin ? 'Yes' : 'No');
    kv(doc, 'Last Login', fmtDate(u.lastLogin));
    kv(doc, 'Created At', fmtDate(u.createdAt));
    kv(doc, 'Updated At', fmtDate(u.updatedAt));

    ensureSpace(doc, 100);
    drawSection(doc, '2. Contact Details');
    kv(doc, 'Phone', u.phone);
    kv(doc, 'Mobile Number', u.mobileNumber);
    kv(doc, 'Guardian Name', u.guardianName);
    kv(doc, 'Guardian Mobile', u.guardianMobileNumber);
    kv(doc, 'Aadhaar Number', u.aadhaarNumber);

    ensureSpace(doc, 100);
    drawSection(doc, '3. Bank Details');
    kv(doc, 'Bank Name', u.bankName);
    kv(doc, 'Account Holder', u.bankAccountHolderName);
    kv(doc, 'Account Number', u.bankAccountNumber);
    kv(doc, 'IFSC Code', u.bankIfscCode);

    ensureSpace(doc, 80);
    drawSection(doc, '4. Bond Details');
    const bonds = Array.isArray(u.bonds) ? u.bonds : [];
    if (bonds.length === 0) {
      doc.font('Helvetica').text('No bond records.');
    } else {
      bonds.forEach((b, bi) => {
        ensureSpace(doc, 70);
        doc.font('Helvetica-Bold').text(`Bond #${bi + 1}`);
        doc.font('Helvetica');
        // dump known bond fields safely
        const entries = Object.entries(b || {}).filter(([k]) => k !== '_id' && k !== '__v');
        if (entries.length === 0) doc.text('  (empty bond entry)');
        entries.forEach(([k, v]) => {
          const val = v instanceof Date ? fmtDate(v) : typeof v === 'object' ? JSON.stringify(v) : s(v);
          doc.text(`  ${k}: ${val}`);
        });
      });
    }

    ensureSpace(doc, 80);
    drawSection(doc, '5. Leave / Adjustments');
    kv(doc, 'Paid Leave Allocation', u.paidLeaveAllocation);
    kv(doc, 'Paid Leave Access', u.paidLeaveAccess === false ? 'No' : 'Yes');
    kv(doc, 'Paid Leave Last Allocated', fmtDate(u.paidLeaveLastAllocatedDate));
    kv(doc, 'Manual Extra Time Adj', u.manualExtraTimeAdjustment);
    kv(doc, 'Manual Half-Day Adj', u.manualHalfDayLeaveAdjustment);
    kv(doc, 'Manual Paid Leave Adj', u.manualPaidLeaveAdjustment);
    kv(doc, 'Manual Unpaid Leave Adj', u.manualUnpaidLeaveAdjustment);

    ensureSpace(doc, 80);
    drawSection(doc, '6. Shift Timing');
    kv(doc, 'Default Check-In', u.defaultCheckInTime);
    kv(doc, 'Default Check-Out', u.defaultCheckoutTime);
    const cin = u.checkInTimeOverrides && typeof u.checkInTimeOverrides === 'object' ? Object.keys(u.checkInTimeOverrides).length : 0;
    const cout = u.checkoutTimeOverrides && typeof u.checkoutTimeOverrides === 'object' ? Object.keys(u.checkoutTimeOverrides).length : 0;
    kv(doc, 'Check-In Overrides', `${cin} month(s)`);
    kv(doc, 'Check-Out Overrides', `${cout} month(s)`);

    ensureSpace(doc, 60);
    drawSection(doc, '7. Salary Breakdown');
    const sb = Array.isArray(u.salaryBreakdown) ? u.salaryBreakdown : [];
    if (sb.length === 0) doc.font('Helvetica').text('No salary breakdown entries.');
    else {
      sb.forEach((row, ri) => {
        ensureSpace(doc, 40);
        doc.font('Helvetica').text(`${ri + 1}. ${typeof row === 'object' ? JSON.stringify(row) : s(row)}`);
      });
    }

    ensureSpace(doc, 40);
    drawSection(doc, '8. Salary Slips on Profile');
    const slips = Array.isArray(u.salarySlips) ? u.salarySlips : [];
    doc.font('Helvetica').text(slips.length ? `${slips.length} slip(s) stored on user record` : 'No salary slips on user record.');
  }

  bar.update(total, { name: 'done' });
  bar.stop();

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  await mongoose.disconnect();
  console.log(`\nPDF saved: ${OUT_FILE}`);
  console.log(`Employees covered: ${total} / ${total} (none missed)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
