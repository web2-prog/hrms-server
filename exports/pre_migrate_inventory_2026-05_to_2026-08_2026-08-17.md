# Pre-migration inventory: HRMS → NewHRMS

- **Generated:** 2026-08-17T04:59:13.949Z
- **Source:** `hrms`
- **Target:** `NewHRMS` (no writes in this step)
- **Attendance / sync window:** 2026-05-01 → 2026-08-17
- **Leave unpaid policy:** from 2026-04-01 onward, Full Day + Half Day → Unpaid

## Totals

| Metric | Count |
|--------|------:|
| Legacy users | 60 |
| Active legacy users | 26 |
| Mapped NewHRMS employees | 39 |
| Attendance rows in range | 1722 |
| Attendance mapped | 1722 |
| Attendance unmapped | 0 |
| Leaves overlapping Apr→TO | 113 |
| Leaves mapped | 113 |
| Leaves unmapped | 0 |
| Early-like attendance rows | 2 |

## By month (source vs NewHRMS today)

| Month | HRMS att | HRMS leaves | NewHRMS att | NewHRMS leaves | NewHRMS early-checkout reqs |
|-------|--------:|------------:|------------:|---------------:|----------------------------:|
| 2026-05 | 438 | 25 | 438 | 13 | 0 |
| 2026-06 | 481 | 23 | 481 | 14 | 0 |
| 2026-07 | 534 | 19 | 534 | 19 | 0 |
| 2026-08 | 269 | 17 | 271 | 17 | 0 |

## Leave categories (Apr → TO)

| Category | Count |
|----------|------:|
| Unpaid Leave | 86 |
| Half Day Leave | 23 |
| Paid Leave | 2 |
| Extra Time Leave | 2 |

## Policy notes (to apply on migrate)

1. **No schema changes** — upsert into existing NewHRMS collections only.
2. **May–August:** migrate all attendance, leaves, management OT for mapped employees.
3. **From April 2026:** every Full Day and Half Day leave is stored with `[Unpaid]` in reason (salary LOP uses this).
4. **Early checkout:** NewHRMS counts early minutes from `check_out` vs shift end and folds shortfall into monthly working hours via `recalculateMonthlySummary` — no separate schema field required for historical early minutes.
5. If legacy has dedicated early-checkout / early-leave request docs, they are inventoried above and will be mapped into `earlycheckoutrequests` when attendance rows exist.

## Unmapped attendance users

_None — all attendance userIds resolve via map or name._

## Collections in hrms

- `attendances`
- `auditlogs`
- `companyholidays`
- `leaverequests`
- `notifications`
- `otps`
- `systemsettings`
- `users`
