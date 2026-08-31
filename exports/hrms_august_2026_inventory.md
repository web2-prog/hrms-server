# August 2026 HRMS snapshot inventory

- **Generated:** 2026-08-25T10:30:05.475Z
- **Mode:** live
- **Source:** `hrms` → **Target:** `NewHRMS`
- **Range:** 2026-08-01 → 2026-08-31
- **Snapshot file:** `hrms_august_2026_snapshot.json`

## Source totals

| Metric | Count |
|--------|------:|
| Attendance rows | 405 |
| Leaves overlapping August | 39 |
| Early logout requests | 36 |
| Management OT (Approved) | 0 |
| General OT | 263 |

## Leave categories

| Category | Count |
|----------|------:|
| Unpaid Leave | 32 |
| Half Day Leave | 7 |

## Next steps

1. Wipe NewHRMS August records (`--phase wipe`)
2. Import from this snapshot (`--phase import`)
3. Verify (`--phase verify`)
