# Pre-migration report: May–August (HRMS → NewHRMS)

- **Generated:** 2026-08-17T11:44:11.612Z
- **Mode:** pre-migrate
- **Source:** `hrms` → **Target:** `NewHRMS`
- **Attendance / early-checkout / OT window:** 2026-08-17 → 2026-08-17
- **Leave unpaid policy:** from 2026-04-01 through 2026-12-31 (includes future applied leaves)
- **Leave tagging:** Full Day + Half Day → `[Unpaid]`
- **Schema changes:** none

## Source totals

| Metric | Count |
|--------|------:|
| Attendance rows | 19 |
| Early logout (Approved/Rejected/Pending) | 0 |
| Leaves overlapping 2026-04-01→2026-12-31 | 115 |

## By month (source)

| Month | Attendance | Leaves | Early logout | Mgmt OT (Approved) |
|-------|----------:|-------:|-------------:|-------------------:|
| 2026-05 | 438 | 25 | 48 | 0 |
| 2026-06 | 481 | 23 | 26 | 0 |
| 2026-07 | 534 | 19 | 53 | 3 |
| 2026-08 | 271 | 19 | 28 | 0 |

## Leave categories (Apr → TO)

| Category | Count | Migrated as |
|----------|------:|-------------|
| Unpaid Leave | 87 | [Unpaid] Full/Half Day (forced from Apr) |
| Half Day Leave | 24 | [Unpaid] Full/Half Day (forced from Apr) |
| Paid Leave | 2 | [Unpaid] Full/Half Day (forced from Apr) |
| Extra Time Leave | 2 | [Extra Time Leave] (unchanged pay tag) |

## Early checkout ↔ monthly hours

Legacy `earlyLogoutRequest` is copied into NewHRMS `earlycheckoutrequests`. Early minutes for salary/monthly hours come from attendance `check_out` vs shift end; `recalculateMonthlySummary` folds low hours into monthly counted vs target hours.

## Migrate plan

1. Upsert attendance (second precision check-in/out, breaks, worked hours).
2. Upsert EarlyCheckoutRequest from `earlyLogoutRequest` (link to NewHRMS attendance).
3. Replace leaves overlapping Apr→TO for mapped employees; force Unpaid on Full/Half Day.
4. Upsert Approved management OT as OvertimeRequest (Management).
5. Recalculate MonthlySummary for every touched employee-month.
6. Verify: 0 missing attendance / leaves / early-checkout vs source.
