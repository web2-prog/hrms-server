/** Date helpers — store / compare as YYYY-MM-DD (UTC calendar day). */

export function toISODate(d) {
  if (!d) return null;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function parseISODate(s) {
  const iso = toISODate(s);
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addMonthsUTC(date, months) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const target = new Date(Date.UTC(y, m + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target;
}

/**
 * Build stepped salary schedule for a bond period.
 * Example: 12-month bond, increment every 3 months → 4 salary bands.
 */
export function generateSalarySchedule({
  start_date,
  period_months = 12,
  starting_salary = 0,
  increment_every_months = 3,
  increment_amount = 0,
  increment_percent = 0,
}) {
  const start = parseISODate(start_date);
  const period = Math.max(1, Number(period_months) || 12);
  const every = Math.max(1, Number(increment_every_months) || period);
  if (!start) throw new Error('start_date is required to generate salary schedule');

  const entries = [];
  let salary = Number(starting_salary) || 0;
  let cursor = 0;
  let step = 0;

  while (cursor < period) {
    const chunk = Math.min(every, period - cursor);
    const segStart = addMonthsUTC(start, cursor);
    const nextStart = addMonthsUTC(start, cursor + chunk);
    const segEnd = new Date(nextStart);
    segEnd.setUTCDate(segEnd.getUTCDate() - 1);

    entries.push({
      start_date: toISODate(segStart),
      end_date: toISODate(segEnd),
      monthly_salary: Math.round(salary * 100) / 100,
      label: `Months ${cursor + 1}–${cursor + chunk}`,
      step_index: step,
    });

    cursor += chunk;
    step += 1;
    if (Number(increment_amount)) salary += Number(increment_amount);
    else if (Number(increment_percent)) salary *= 1 + Number(increment_percent) / 100;
  }

  return entries;
}

/** Resolve monthly salary for a given calendar month from schedule (else base_salary). */
export function resolveMonthlySalary(employee, month, year) {
  const schedule = Array.isArray(employee?.salary_schedule) ? employee.salary_schedule : [];
  const probe = `${year}-${String(month).padStart(2, '0')}-15`;
  const hit = schedule.find((s) => {
    const from = toISODate(s.start_date);
    const to = toISODate(s.end_date);
    if (!from) return false;
    if (from > probe) return false;
    if (to && to < probe) return false;
    return true;
  });
  if (hit && hit.monthly_salary != null) return Number(hit.monthly_salary) || 0;
  return Number(employee?.base_salary) || 0;
}

/** Current effective salary from schedule as of today (or base_salary). */
export function resolveCurrentSalary(employee, asOf = new Date()) {
  const probe = toISODate(asOf);
  const schedule = Array.isArray(employee?.salary_schedule) ? employee.salary_schedule : [];
  const hit = schedule.find((s) => {
    const from = toISODate(s.start_date);
    const to = toISODate(s.end_date);
    if (!from || from > probe) return false;
    if (to && to < probe) return false;
    return true;
  });
  if (hit && hit.monthly_salary != null) return Number(hit.monthly_salary) || 0;
  return Number(employee?.base_salary) || 0;
}

/** Active bond whose proof is still held by the company (any proof type). */
export function getActiveHeldBond(employee) {
  const bonds = Array.isArray(employee?.bonds) ? employee.bonds : [];
  return (
    bonds.find(
      (b) =>
        String(b.status || '').toLowerCase() === 'active' &&
        b.proof_type &&
        String(b.proof_status || 'Held') !== 'Returned'
    ) || null
  );
}

/**
 * Active bond with joining proof = salary_deduction (e.g. 15% hold).
 * Only applies while proof is still Held (not Returned).
 */
export function getSalaryDeductionBond(employee) {
  const bonds = Array.isArray(employee?.bonds) ? employee.bonds : [];
  return (
    bonds.find(
      (b) =>
        String(b.status || '').toLowerCase() === 'active' &&
        b.proof_type === 'salary_deduction' &&
        String(b.proof_status || 'Held') !== 'Returned'
    ) || null
  );
}

/** Percent to hold from monthly salary (default 15 when salary_deduction). */
export function resolveSalaryDeductionPercent(bond) {
  if (!bond || bond.proof_type !== 'salary_deduction') return 0;
  const pct = Number(bond.salary_deduction_percent);
  if (!Number.isFinite(pct) || pct <= 0) return 15;
  return Math.min(100, pct);
}

/** Sync legacy bond_details from the primary Active bond (or first bond). */
export function syncLegacyBondDetails(bonds = []) {
  if (!Array.isArray(bonds) || !bonds.length) {
    return { bond_start_date: null, bond_end_date: null, bond_amount: 0, bond_status: '' };
  }
  const active = bonds.find((b) => String(b.status || '').toLowerCase() === 'active') || bonds[0];
  return {
    bond_start_date: active.start_date || null,
    bond_end_date: active.end_date || null,
    bond_amount: Number(active.amount) || 0,
    bond_status: active.status || '',
  };
}

/** If bonds empty but legacy bond_details exists, seed one bond entry. */
export function ensureBondsArray(employee) {
  const bonds = Array.isArray(employee.bonds) ? [...employee.bonds] : [];
  if (bonds.length) return bonds;
  const bd = employee.bond_details || {};
  if (!bd.bond_start_date && !bd.bond_end_date && !bd.bond_amount && !bd.bond_status) return [];
  return [
    {
      type: 'Job',
      start_date: bd.bond_start_date || null,
      end_date: bd.bond_end_date || null,
      period_months: 12,
      amount: Number(bd.bond_amount) || 0,
      status: bd.bond_status || 'Active',
      notes: '',
    },
  ];
}
