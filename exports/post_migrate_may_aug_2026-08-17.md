# Post-migration report: May–August (HRMS → NewHRMS)

- **Generated:** 2026-08-17T11:44:25.312Z
- **Mode:** applied
- **Range:** 2026-08-17 → 2026-08-17
- **Unpaid leave policy from:** 2026-04-01

## Applied counts

| Metric | Count |
|--------|------:|
| Attendance upserted | 19 |
| Attendance skipped | 0 |
| Early checkout inserted | 0 |
| Early checkout skipped | 0 |
| Leaves inserted | 115 |
| Leaves skipped | 0 |
| Management OT | 0 |
| Monthly summaries recalculated | 35 |

## Verification (0 missing target)

| Check | Count |
|-------|------:|
| Missing attendance | 0 |
| Missing leaves | 0 |
| Missing early checkout | 0 |
| Leaves tagged [Unpaid] | 112 |
| Full/Half still tagged [Paid] (should be 0) | 0 |

## By month after migrate

| Month | HRMS att | NH att | HRMS leaves | NH leaves | HRMS early | NH early |
|-------|---------:|-------:|------------:|----------:|-----------:|---------:|
| 2026-05 | 438 | 438 | 25 | 25 | 48 | 48 |
| 2026-06 | 481 | 481 | 23 | 23 | 26 | 26 |
| 2026-07 | 534 | 534 | 19 | 19 | 53 | 53 |
| 2026-08 | 271 | 273 | 19 | 19 | 28 | 28 |

_All source rows present in NewHRMS. Unpaid policy applied. No schema changes._
