/**
 * Business Date Utilities for Pharmacy ERP
 * 
 * Standardizes calendar date handling and MongoDB date ranges for Indian Standard Time (IST, UTC+05:30).
 * A business calendar date (e.g. 2026-10-01) in IST starts at:
 *   Previous day 18:30:00.000 UTC (12:00:00 AM IST)
 * and ends at:
 *   Current day 18:29:59.999 UTC (11:59:59.999 PM IST)
 */

export const getBusinessDateRange = (dateInput) => {
  let year, month, day;

  if (typeof dateInput === "string" && dateInput.includes("-")) {
    const cleanStr = dateInput.split("T")[0];
    const parts = cleanStr.split("-").map(Number);
    year = parts[0];
    month = parts[1]; // 1-indexed (1..12)
    day = parts[2];
  } else {
    const d = new Date(dateInput || new Date());
    // Convert UTC timestamp to IST (+5:30)
    const istMs = d.getTime() + 5.5 * 60 * 60 * 1000;
    const istDate = new Date(istMs);
    year = istDate.getUTCFullYear();
    month = istDate.getUTCMonth() + 1;
    day = istDate.getUTCDate();
  }

  // Canonical date: Midnight IST stored as UTC
  // 00:00:00 IST on YYYY-MM-DD = 18:30:00 UTC on previous day
  const canonicalDate = new Date(Date.UTC(year, month - 1, day - 1, 18, 30, 0, 0));

  // Business day range covering the full 24-hour period in IST
  // Also comfortably covers standard UTC midnight (00:00:00.000Z)
  const startOfDay = new Date(Date.UTC(year, month - 1, day - 1, 18, 30, 0, 0));
  const endOfDay = new Date(Date.UTC(year, month - 1, day, 18, 29, 59, 999));

  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  return {
    year,
    month,
    day,
    dateStr,
    canonicalDate,
    startOfDay,
    endOfDay,
    dateFilter: { $gte: startOfDay, $lte: endOfDay },
  };
};

export const formatBusinessDate = (date) => {
  if (!date) return "";
  const d = new Date(date);
  // Add 5.5 hours to show correct IST day
  const istMs = d.getTime() + 5.5 * 60 * 60 * 1000;
  const istDate = new Date(istMs);
  const year = istDate.getUTCFullYear();
  const month = String(istDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(istDate.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/**
 * Resolves a transaction timestamp in Indian Standard Time (IST, UTC+05:30).
 * - If dateInput is omitted/falsy, returns current instant (new Date()).
 * - If dateInput is a Date instance, returns it directly.
 * - If dateInput is a "YYYY-MM-DD" string:
 *     If it matches today's IST calendar date, returns new Date() to record the exact current time.
 *     If it is a different date (e.g. past entry), preserves the IST calendar date with the current IST time of day.
 * - If dateInput is an ISO string with time, parses and returns it.
 */
export const parseISTTransactionDate = (dateInput) => {
  if (!dateInput) return new Date();
  if (dateInput instanceof Date && !isNaN(dateInput.getTime())) return dateInput;

  if (typeof dateInput === "string") {
    const trimmed = dateInput.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const todayIST = formatBusinessDate(new Date());
      if (trimmed === todayIST) {
        return new Date();
      }
      const now = new Date();
      const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
      const istDate = new Date(istMs);
      const hours = String(istDate.getUTCHours()).padStart(2, "0");
      const minutes = String(istDate.getUTCMinutes()).padStart(2, "0");
      const seconds = String(istDate.getUTCSeconds()).padStart(2, "0");
      const ms = String(istDate.getUTCMilliseconds()).padStart(3, "0");
      return new Date(`${trimmed}T${hours}:${minutes}:${seconds}.${ms}+05:30`);
    }
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) return parsed;
  }

  return new Date();
};

