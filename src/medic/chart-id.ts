import {
  readdirSync,
  existsSync,
  openSync,
  closeSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Chart ID format: CHART-YYYY-MM-DD-NNN
 * where NNN is a zero-padded sequence number (001-999) that resets per day
 */
export interface ChartId {
  full: string;
  date: string;
  sequence: number;
}

/**
 * Parse a Chart ID string into its components
 */
export function parseChartId(chartId: string): ChartId | null {
  const match = chartId.match(/^CHART-(\d{4}-\d{2}-\d{2})-(\d{3})$/);
  if (!match) return null;

  return {
    full: chartId,
    date: match[1],
    sequence: parseInt(match[2], 10),
  };
}

/**
 * Format a Chart ID from its components
 */
export function formatChartId(date: string, sequence: number): string {
  return `CHART-${date}-${sequence.toString().padStart(3, "0")}`;
}

/**
 * Get today's date in YYYY-MM-DD format (UTC)
 */
export function getTodayDate(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Scan the charts directory for existing chart IDs on a given date
 * and return the maximum sequence number found
 */
export function getMaxSequenceForDate(
  chartsDir: string,
  date: string,
): number {
  if (!existsSync(chartsDir)) return 0;

  const files = readdirSync(chartsDir);
  const prefix = `CHART-${date}-`;
  let maxSeq = 0;

  for (const file of files) {
    // Strip file extension for parsing
    const baseName = file.replace(/\.[^/.]+$/, "");
    if (baseName.startsWith(prefix)) {
      const parsed = parseChartId(baseName);
      if (parsed && parsed.sequence > maxSeq) {
        maxSeq = parsed.sequence;
      }
    }
  }

  return maxSeq;
}

/**
 * Generate the next Chart ID for today.
 *
 * Claims the sequence by atomically creating a marker file for the ID.
 * If another caller already claimed the sequence, the function resans and retries.
 */
export function generateNextChartId(chartsDir: string): ChartId {
  mkdirSync(chartsDir, { recursive: true });

  const today = getTodayDate();
  let maxSeq = getMaxSequenceForDate(chartsDir, today);

  while (true) {
    const nextSeq = maxSeq + 1;

    if (nextSeq > 999) {
      throw new RangeError(
        `Chart sequence overflow for ${today}: maximum sequence is 999, cannot generate sequence ${nextSeq}`,
      );
    }

    const fileName = `CHART-${today}-${nextSeq.toString().padStart(3, "0")}.md`;
    const filePath = join(chartsDir, fileName);

    try {
      const fd = openSync(filePath, "wx");
      closeSync(fd);
      return {
        full: formatChartId(today, nextSeq),
        date: today,
        sequence: nextSeq,
      };
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "EEXIST") {
        maxSeq = getMaxSequenceForDate(chartsDir, today);
        continue;
      }
      throw err;
    }
  }
}