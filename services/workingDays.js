import Holiday from '../models/Holiday.js';
import { datesInRange, todayISO } from '../utils/helpers.js';

function isSunday(dateStr) {
  return new Date(dateStr + 'T00:00:00').getDay() === 0;
}

function inMonth(dateStr, year, month) {
  return dateStr.startsWith(`${year}-${String(month).padStart(2, '0')}`);
}

function inYear(dateStr, year) {
  return dateStr.startsWith(`${year}-`);
}

/**
 * Set of non-working dates for a year (or a month within it): every Sunday plus
 * all holiday dates. Dates are always clamped to the requested period, so a
 * vacation spanning into the next year never leaks into this one.
 */
export async function getNonWorkingDateSet(year, month = null) {
  const set = new Set();

  const start = month ? new Date(year, month - 1, 1) : new Date(year, 0, 1);
  const end = month ? new Date(year, month, 0) : new Date(year, 11, 31);
  const inPeriod = (d) => (month ? inMonth(d, year, month) : inYear(d, year));

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = todayISO(d);
    if (isSunday(iso)) set.add(iso);
  }

  // Single-day holidays are year-scoped, but a vacation can span a year
  // boundary (e.g. Dec 28 → Jan 4). Match vacations by range overlap with the
  // requested period so each year sees its own share of the days.
  const startISO = todayISO(start);
  const endISO = todayISO(end);
  const holidays = await Holiday.find({
    $or: [
      { type: 'Vacation', start_date: { $lte: endISO }, end_date: { $gte: startISO } },
      { type: { $ne: 'Vacation' }, year },
    ],
  }).lean();
  for (const h of holidays) {
    if (h.type === 'Vacation') {
      for (const d of datesInRange(h.start_date, h.end_date)) {
        if (inPeriod(d)) set.add(d);
      }
      continue;
    }
    if (h.date && inPeriod(h.date)) set.add(h.date);
  }

  return set;
}

/**
 * Year calendar summary. The breakdown is non-overlapping — every off day is
 * counted exactly once (vacation absorbs any weekend days inside it, and a
 * festival/manual day wins over a Saturday/Sunday), so the category counts
 * always add up to non_working_days and working + non-working = total.
 */
export async function getWorkingDaysOfYear(year) {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const totalDays = isLeap ? 366 : 365;
  const nonWorking = await getNonWorkingDateSet(year);

  // Vacation days: every calendar day of the range that falls inside this year.
  // Match by overlap so a vacation spanning into the next (or from the previous)
  // year contributes its days to each year it touches.
  const vacationDates = new Set();
  const vacations = await Holiday.find({
    type: 'Vacation',
    start_date: { $lte: `${year}-12-31` },
    end_date: { $gte: `${year}-01-01` },
  }).lean();
  for (const v of vacations) {
    for (const d of datesInRange(v.start_date, v.end_date)) {
      if (inYear(d, year)) vacationDates.add(d);
    }
  }

  // Non-vacation holiday dates; a Festival/Manual wins over a Saturday on the
  // same date so each day maps to a single bucket.
  const holidayDates = new Map();
  const singleDays = await Holiday.find({ year, type: { $in: ['Festival', 'Manual', 'Saturday'] } }).lean();
  for (const h of singleDays) {
    if (!h.date) continue;
    const existing = holidayDates.get(h.date);
    if (!existing || existing === 'Saturday') holidayDates.set(h.date, h.type);
  }

  const breakdown = {
    sundays: 0,
    alternate_saturdays: 0,
    festivals: 0,
    manual_holidays: 0,
    vacation_days: vacationDates.size,
  };

  for (const date of nonWorking) {
    if (vacationDates.has(date)) continue;
    const type = holidayDates.get(date);
    if (type === 'Festival') breakdown.festivals += 1;
    else if (type === 'Manual') breakdown.manual_holidays += 1;
    else if (type === 'Saturday') breakdown.alternate_saturdays += 1;
    else if (isSunday(date)) breakdown.sundays += 1;
  }

  return {
    year,
    total_days: totalDays,
    non_working_days: nonWorking.size,
    working_days: totalDays - nonWorking.size,
    breakdown: {
      ...breakdown,
      note: 'Non-overlapping: each off day counted once; vacations absorb weekend days inside them',
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
