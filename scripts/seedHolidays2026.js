import dotenv from 'dotenv';
import cliProgress from 'cli-progress';
import { connectDB } from '../config/db.js';
import { seedHolidays2026 } from './seed.js';

dotenv.config();

async function main() {
  await connectDB();
  const bar = new cliProgress.SingleBar({
    format: 'Holidays 2026 |{bar}| {percentage}% | {value}/{total}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
  });
  bar.start(1, 0);
  const counts = await seedHolidays2026();
  bar.update(1);
  bar.stop();
  console.log(
    `\nApplied 2026 holidays: ${counts.saturdays} alternate Saturdays, ${counts.festivals} festivals, ${counts.vacations} vacation(s)`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
