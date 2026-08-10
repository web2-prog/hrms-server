import Holiday from '../models/Holiday.js';
import { datesInRange, todayISO } from '../utils/helpers.js';

function isSunday(dateStr) {
  return new Date(dateStr + 'T00:00:00').getDay() === 0;
}

function inMonth(dateStr, year, month) {
  if (!month) return true;
  return dateStr.startsWith(`${year}-${String(month).padStart(2, '0')}`);
}

export async function getNonWorkingDateSet(year, month = null) {
  const set = new Set();

  const start = month ? new Date(year, month - 1, 1) : new Date(year, 0, 1);
  const end = month ? new Date(year, month, 0) : new Date(year, 11, 31);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = todayISO(d);
    if (isSunday(iso)) set.add(iso);
  }

  const holidays = await Holiday.find({ year }).lean();
  for (const h of holidays) {
    if (h.type === 'Vacation') {
      for (const d of datesInRange(h.start_date, h.end_date)) {
        if (inMonth(d, year, month)) set.add(d);
      }
      continue;
    }
    if (h.date && inMonth(h.date, year, month)) set.add(h.date);
  }

  return set;
}

export async function getWorkingDaysOfYear(year) {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const totalDays = isLeap ? 366 : 365;
  const nonWorking = await getNonWorkingDateSet(year);
  const sundays = [...nonWorking].filter(isSunday).length;

  const [sats, festivals, manuals, vacations] = await Promise.all([
    Holiday.countDocuments({ year, type: 'Saturday' }),
    Holiday.countDocuments({ year, type: 'Festival' }),
    Holiday.countDocuments({ year, type: 'Manual' }),
    Holiday.find({ year, type: 'Vacation' }).lean(),
  ]);

  let vacationDays = 0;
  for (const v of vacations) vacationDays += datesInRange(v.start_date, v.end_date).length;

  return {
    year,
    total_days: totalDays,
    non_working_days: nonWorking.size,
    working_days: totalDays - nonWorking.size,
    breakdown: {
      sundays,
      alternate_saturdays: sats,
      festivals,
      manual_holidays: manuals,
      vacation_days: vacationDays,
      note: 'Overlaps counted once via date union',
    },
  };
}

export async function getWorkingDaysInMonth(year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const nonWorking = await getNonWorkingDateSet(year, month);
  const workingDates = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!nonWorking.has(iso)) workingDates.push(iso);
  }
  return { working_days: workingDates.length, working_dates: workingDates, non_working: [...nonWorking] };
}

export async function isNonWorkingDay(dateStr) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const set = await getNonWorkingDateSet(year);
  return set.has(dateStr);
}
