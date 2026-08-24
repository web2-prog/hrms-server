import PDFDocument from 'pdfkit';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function inr(n) {
  const v = Number(n) || 0;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const ones = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigitWords(n) {
  if (n < 20) return ones[n];
  return `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`.trim();
}

function threeDigitWords(n) {
  if (n === 0) return '';
  if (n < 100) return twoDigitWords(n);
  return `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${twoDigitWords(n % 100)}` : ''}`.trim();
}

function indianNumberWords(n) {
  if (n === 0) return '';
  if (n < 1000) return threeDigitWords(n);
  if (n < 100000) {
    const thousands = Math.floor(n / 1000);
    const remainder = n % 1000;
    return `${threeDigitWords(thousands)} Thousand${remainder ? ` ${indianNumberWords(remainder)}` : ''}`.trim();
  }
  if (n < 10000000) {
    const lakhs = Math.floor(n / 100000);
    const remainder = n % 100000;
    return `${threeDigitWords(lakhs)} Lakh${remainder ? ` ${indianNumberWords(remainder)}` : ''}`.trim();
  }
  const crores = Math.floor(n / 10000000);
  const remainder = n % 10000000;
  return `${threeDigitWords(crores)} Crore${remainder ? ` ${indianNumberWords(remainder)}` : ''}`.trim();
}

function amountToWords(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return 'Indian Rupee Zero Only';
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  let words = `Indian Rupee ${indianNumberWords(rupees)}`;
  if (paise > 0) words += ` and ${indianNumberWords(paise)} Paise`;
  return `${words} Only`;
}

/**
 * Zoho-style salary slip PDF (server-side) matching the React preview sections.
 */
function drawSalarySlipPdf(doc, form) {

  const monthLabel = MONTH_NAMES[form.month - 1] || '';
  const left = 36;
  const right = 559;
  const width = right - left;

  // Header
  doc.fontSize(14).fillColor('#1a1a1a').font('Helvetica-Bold').text(form.companyName || 'KriraAI Pvt. Ltd.', left, 40, {
    width: width * 0.55,
  });
  doc
    .fontSize(9)
    .fillColor('#888888')
    .font('Helvetica')
    .text(form.companyAddress || '', left, doc.y + 2, { width: width * 0.55 });

  const headerTop = 40;
  doc
    .fontSize(9)
    .fillColor('#888888')
    .text('Payslip For the Month', left + width * 0.55, headerTop, { width: width * 0.45, align: 'right' });
  doc
    .fontSize(14)
    .fillColor('#1a1a1a')
    .font('Helvetica-Bold')
    .text(`${monthLabel} ${form.year}`, left + width * 0.55, headerTop + 14, { width: width * 0.45, align: 'right' });

  let y = 95;
  doc.moveTo(left, y).lineTo(right, y).strokeColor('#e8e8e8').stroke();
  y += 16;

  // Employee details + net card
  const details = [
    ['Employee Name', form.empName || '—'],
    ['Designation', form.designation || '—'],
    ['Employee ID', form.empNo || '—'],
    ['Date of Joining', form.doj || '—'],
    ['Pay Period', `${monthLabel} ${form.year}`],
    ['Pay Date', form.payDate || '—'],
  ];

  let dy = y;
  for (const [label, value] of details) {
    doc.fontSize(10).fillColor('#888888').font('Helvetica').text(label, left, dy, { width: 110, continued: false });
    doc.fillColor('#1a1a1a').font('Helvetica-Bold').text(`:  ${value}`, left + 110, dy);
    dy += 16;
  }

  const cardX = left + width - 170;
  const cardY = y;
  doc.roundedRect(cardX, cardY, 170, 108, 4).strokeColor('#d5d5d5').stroke();
  doc.rect(cardX, cardY, 170, 52).fill('#e6f4ea');
  doc
    .fillColor('#1a1a1a')
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(inr(form.netPay), cardX, cardY + 12, { width: 170, align: 'center' });
  doc
    .fillColor('#089949')
    .font('Helvetica')
    .fontSize(9)
    .text('Employee Net Pay', cardX, cardY + 32, { width: 170, align: 'center' });
  doc
    .fillColor('#888888')
    .fontSize(9)
    .text(`Paid Days      ${form.paidDays ?? 0}`, cardX + 12, cardY + 58, { width: 146 });
  doc.text(`Leave Count   ${form.leaveDays ?? 0}`, cardX + 12, cardY + 72, { width: 146 });
  doc.text(`LOP Days       ${form.lopDays ?? 0}`, cardX + 12, cardY + 86, { width: 146 });

  y = Math.max(dy, cardY + 120);
  doc.moveTo(left, y).lineTo(right, y).strokeColor('#e8e8e8').stroke();
  y += 12;

  doc
    .fontSize(10)
    .fillColor('#888888')
    .font('Helvetica')
    .text(`PF A/C Number : `, left, y, { continued: true })
    .fillColor('#1a1a1a')
    .font('Helvetica-Bold')
    .text(form.pfNo || 'NA', { continued: false });
  doc
    .fontSize(10)
    .fillColor('#888888')
    .font('Helvetica')
    .text(`UAN : `, left + 220, y, { continued: true })
    .fillColor('#1a1a1a')
    .font('Helvetica-Bold')
    .text(form.uan || 'NA');
  y += 20;
  doc.moveTo(left, y).lineTo(right, y).dash(3, { space: 2 }).strokeColor('#d0d0d0').stroke();
  doc.undash();
  y += 14;

  // Table header
  const col = {
    eName: left,
    eAmt: left + 120,
    eYtd: left + 185,
    dName: left + 260,
    dAmt: left + 380,
    dYtd: left + 445,
  };
  doc.rect(left, y, width, 22).fill('#f9f9f9');
  doc.fillColor('#555555').font('Helvetica-Bold').fontSize(8);
  doc.text('EARNINGS', col.eName + 4, y + 7);
  doc.text('AMOUNT', col.eAmt, y + 7, { width: 60, align: 'right' });
  doc.text('YTD', col.eYtd, y + 7, { width: 60, align: 'right' });
  doc.text('DEDUCTIONS', col.dName + 4, y + 7);
  doc.text('AMOUNT', col.dAmt, y + 7, { width: 60, align: 'right' });
  doc.text('YTD', col.dYtd, y + 7, { width: 60, align: 'right' });
  y += 26;

  const earnings = [
    { label: 'Basic', amount: form.basic, ytd: form.ytdBasic },
    ...(form.overtime > 0 ? [{ label: 'Overtime', amount: form.overtime, ytd: form.ytdOvertime }] : []),
    ...((form.customEarnings || []).map((item) => ({
      label: item.label,
      amount: item.amount,
      ytd: item.ytd ?? item.amount,
    }))),
  ];
  const deductions = [];
  if (form.shortfallDeduction > 0) {
    deductions.push({
      label: 'Shortfall Deduction',
      amount: form.shortfallDeduction,
      ytd: form.ytdShortfallDeduction,
    });
  }
  deductions.push({
    label: 'Leave Deduction',
    amount: form.leaveDeduction || 0,
    ytd: form.ytdLeaveDeduction || 0,
  });
  if (form.earlyCheckoutDeduction > 0) {
    deductions.push({
      label: `Early Checkout Deduction (${Math.round(Number(form.earlyCheckoutMinutes) || 0)} min)`,
      amount: form.earlyCheckoutDeduction,
      ytd: form.ytdEarlyCheckoutDeduction,
    });
  }
  if (form.bondSecurity > 0) {
    const pct = form.bondSecurityPercent ? ` (${form.bondSecurityPercent}%)` : '';
    deductions.push({
      label: `Bond Security Hold${pct}`,
      amount: form.bondSecurity,
      ytd: form.ytdBondSecurity,
    });
  }
  deductions.push({ label: 'TDS', amount: form.tds || 0, ytd: form.ytdTds || 0 });
  for (const item of form.customDeductions || []) {
    deductions.push({
      label: item.label,
      amount: item.amount,
      ytd: item.ytd ?? item.amount,
    });
  }

  const rows = Math.max(earnings.length, deductions.length, 1);
  doc.font('Helvetica').fontSize(10).fillColor('#333333');
  for (let i = 0; i < rows; i++) {
    const e = earnings[i];
    const d = deductions[i];
    if (e) {
      doc.font('Helvetica').text(e.label, col.eName + 4, y);
      doc.font('Helvetica-Bold').text(inr(e.amount), col.eAmt, y, { width: 60, align: 'right' });
      doc.font('Helvetica').text(inr(e.ytd), col.eYtd, y, { width: 60, align: 'right' });
    }
    if (d) {
      doc.font('Helvetica').text(d.label, col.dName + 4, y);
      doc.font('Helvetica-Bold').text(inr(d.amount), col.dAmt, y, { width: 60, align: 'right' });
      doc.font('Helvetica').text(inr(d.ytd), col.dYtd, y, { width: 60, align: 'right' });
    }
    y += 18;
  }

  y += 8;
  doc.rect(left, y, width, 24).fill('#f5f5f5');
  doc.fillColor('#1a1a1a').font('Helvetica-Bold').fontSize(10);
  doc.text('Gross Earnings', col.eName + 4, y + 7);
  doc.text(inr(form.grossEarnings), col.eAmt, y + 7, { width: 60, align: 'right' });
  doc.text('Total Deductions', col.dName + 4, y + 7);
  doc.text(inr(form.totalDeductions), col.dAmt, y + 7, { width: 60, align: 'right' });
  y += 40;

  // Net payable box
  doc.roundedRect(left, y, width, 48, 4).strokeColor('#d5d5d5').stroke();
  doc
    .fillColor('#1a1a1a')
    .font('Helvetica-Bold')
    .fontSize(11)
    .text('TOTAL NET PAYABLE', left + 12, y + 10);
  doc
    .fillColor('#888888')
    .font('Helvetica')
    .fontSize(8)
    .text('Gross Earnings - Total Deductions', left + 12, y + 26);
  doc.roundedRect(right - 140, y + 10, 128, 28, 3).fill('#e6f4ea');
  doc
    .fillColor('#1a1a1a')
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(inr(form.netPay), right - 140, y + 17, { width: 128, align: 'center' });
  y += 60;

  doc
    .fillColor('#555555')
    .font('Helvetica')
    .fontSize(10)
    .text(`Amount In Words : ${amountToWords(form.netPay)}`, left, y, { width, align: 'right' });
}

export function renderSalarySlipPdf(res, form) {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc.pipe(res);
  drawSalarySlipPdf(doc, form);
  doc.end();
}

/** Build payslip PDF as a Buffer (for email attachments). */
export function buildSalarySlipPdfBuffer(form) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    drawSalarySlipPdf(doc, form);
    doc.end();
  });
}
