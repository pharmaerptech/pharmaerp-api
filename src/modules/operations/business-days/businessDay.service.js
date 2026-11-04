import { BusinessDay } from "./businessDay.model.js";
import { Shift } from "../shifts/shift.model.js";
import ApiError from "../../../utils/ApiError.js";
import BankAccount from "../../finance/treasury/bank-management/bank-accounts/models/bankAccount.model.js";
import bankTransactionService from "../../finance/treasury/bank-management/bank-transactions/services/bankTransaction.service.js";
import { getUpiClearingAccount } from "../../finance/treasury/shared/findOrCreateSystemAccount.js";
import {
  BANK_TRANSACTION_TYPE,
  BANK_TRANSACTION_DIRECTION,
  BANK_TRANSACTION_STATUS,
  BANK_TRANSACTION_PAYMENT_MODE,
  BANK_TRANSACTION_CATEGORY,
} from "../../finance/treasury/bank-management/bank-transactions/constants/bankTransaction.constant.js";

// ── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Normalise any date value to midnight UTC (canonical business date).
 * Accepts YYYY-MM-DD string, Date object, or timestamp.
 * Avoids timezone drift by parsing YYYY-MM-DD components directly into UTC.
 */
const toCanonicalDate = (input) => {
  if (!input) {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }
  if (typeof input === "string") {
    const match = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10) - 1;
      const day = parseInt(match[3], 10);
      return new Date(Date.UTC(year, month, day));
    }
  }
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  }
  const d = new Date(input);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/**
 * Returns today's canonical date (midnight UTC).
 * If clientDate (e.g. "2026-10-08") is provided, normalizes that date.
 */
const todayCanonical = (clientDate) => {
  if (clientDate) {
    return toCanonicalDate(clientDate);
  }
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
};

/**
 * Returns tomorrow's canonical date (midnight UTC).
 */
const tomorrowCanonical = (clientDate) => {
  const base = todayCanonical(clientDate);
  const t = new Date(base.getTime());
  t.setUTCDate(t.getUTCDate() + 1);
  return t;
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the currently OPEN BusinessDay for a branch, or null.
 * Used as a shared guard across Shift and BankDepositSlip services.
 */
export const getOpenBusinessDay = async (branchId) => {
  return BusinessDay.findOne({ branchId, status: "open" });
};

/**
 * Returns the suggested businessDate for the next Business Day opening.
 *
 * Logic:
 *   - If no BusinessDay exists for today → suggest today.
 *   - If today's BusinessDay is already closed → suggest tomorrow.
 *   - If a BusinessDay is already open → no suggestion (caller handles this).
 *
 * @returns {{ suggestedDate: Date, reason: string }}
 */
export const getSuggestedBusinessDate = async (branchId, clientDate) => {
  const today = todayCanonical(clientDate);
  const tomorrow = tomorrowCanonical(clientDate);

  const openDay = await BusinessDay.findOne({ branchId, status: "open" }).lean();
  if (openDay) {
    return {
      suggestedDate: null,
      reason: "A Business Day is already open. Close it before opening a new one.",
      hasOpenDay: true,
      openDayId: openDay._id,
      openDayBusinessDate: openDay.businessDate,
      todayDate: today,
      tomorrowDate: tomorrow,
    };
  }

  const todayDay = await BusinessDay.findOne({
    branchId,
    businessDate: today,
    status: { $ne: "cancelled" },
  }).lean();

  if (!todayDay || todayDay.status === "open") {
    return {
      suggestedDate: today,
      reason: "Ready to start today's business day operations.",
      hasOpenDay: false,
      todayDate: today,
      tomorrowDate: tomorrow,
      isTodayClosed: false,
    };
  }

  // Today is already closed → suggest tomorrow
  return {
    suggestedDate: tomorrow,
    reason: "Today is already closed. Opening for tomorrow.",
    hasOpenDay: false,
    todayDate: today,
    tomorrowDate: tomorrow,
    isTodayClosed: true,
  };
};

/**
 * Opens a new Business Day for a branch.
 *
 * Rules enforced:
 *   1. No other BusinessDay can be OPEN for this branch.
 *   2. businessDate must be today or tomorrow only (past dates and dates beyond tomorrow strictly disallowed).
 *
 * @param {object} data
 * @param {string} data.workspaceId
 * @param {string} data.companyId
 * @param {string} data.branchId
 * @param {Date}   data.businessDate  - The logical date (validated: today or tomorrow)
 * @param {string} [data.clientDate]  - Local calendar date string from client
 * @param {string} data.createdBy
 * @param {string} [data.note]
 */
export const openBusinessDay = async (data) => {
  const { workspaceId, companyId, branchId, businessDate, clientDate, createdBy, note } = data;

  // Guard 1: Only one open Business Day per branch
  const existingOpen = await BusinessDay.findOne({ branchId, status: "open" });
  if (existingOpen) {
    throw new ApiError(
      400,
      `A Business Day is already open for this branch (${existingOpen.businessDayNo}). ` +
      `Please close it before opening a new one.`
    );
  }

  // Guard 2: Enforce strict sequential date logic (only Today or Tomorrow)
  const suggestion = await getSuggestedBusinessDate(branchId, clientDate);
  
  if (suggestion.hasOpenDay) {
    throw new ApiError(400, suggestion.reason);
  }

  const canonical = toCanonicalDate(businessDate);
  const today = todayCanonical(clientDate);
  const tomorrow = tomorrowCanonical(clientDate);

  if (canonical.getTime() < today.getTime()) {
    throw new ApiError(
      400,
      `Cannot open a Business Day for past dates or yesterday. You can only open for today or tomorrow.`
    );
  }

  if (canonical.getTime() > tomorrow.getTime()) {
    throw new ApiError(
      400,
      `Cannot open a Business Day beyond tomorrow. You can only open for today or tomorrow.`
    );
  }

  const existingForDate = await BusinessDay.findOne({
    branchId,
    businessDate: canonical,
    status: { $ne: "cancelled" },
  });

  if (existingForDate) {
    throw new ApiError(
      400,
      `A Business Day for this date (${canonical.toISOString().split("T")[0]}) already exists with status: ${existingForDate.status}.`
    );
  }

  const businessDayNo = `BD-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 100)}`;

  const businessDay = await BusinessDay.create({
    workspaceId,
    companyId,
    branchId,
    businessDate: canonical,
    actualOpenedAt: new Date(),
    businessDayNo,
    status: "open",
    createdBy,
    note: note || "",
  });

  return businessDay;
};

/**
 * Aggregates all net UPI collections across shifts of a Business Day grouped by bank account.
 * Supports sales invoices, customer advances, and customer credit settlements.
 *
 * @param {object} businessDay
 * @param {Array} shifts
 * @returns {Promise<{ bankTotalsMap: Map<string, object>, defaultBank: object }>}
 */
export const aggregateBusinessDayUpiCollections = async (businessDay, shifts = []) => {
  const defaultBank =
    (await BankAccount.findOne({
      companyId: businessDay.companyId,
      workspaceId: businessDay.workspaceId,
      isDeleted: false,
      isActive: true,
      isPrimary: true,
    })) ||
    (await BankAccount.findOne({
      companyId: businessDay.companyId,
      workspaceId: businessDay.workspaceId,
      isDeleted: false,
      isActive: true,
    }));

  const bankTotalsMap = new Map();

  for (const shift of shifts) {
    // If shift was already settled historically, skip it
    if (shift.upiSettlementStatus === "SETTLED") continue;

    // 1. Sales UPI breakdown
    for (const item of (shift.upiBreakdown || [])) {
      const amt = Number(item.totalAmount || 0);
      if (amt <= 0) continue;
      const bankId = item.bankAccountId
        ? String(item.bankAccountId)
        : (defaultBank ? String(defaultBank._id) : null);
      if (!bankId) continue;

      if (!bankTotalsMap.has(bankId)) {
        bankTotalsMap.set(bankId, {
          bankAccountId: bankId,
          bankName: item.bankName || defaultBank?.bankMasterId?.name || defaultBank?.accountName || "Bank Account",
          accountNumber: item.accountNumber || defaultBank?.accountNumber || "",
          totalAmount: 0,
          transactionCount: 0,
          billCount: 0,
        });
      }
      const entry = bankTotalsMap.get(bankId);
      entry.totalAmount += amt;
      entry.transactionCount += Number(item.transactionCount || 0);
      entry.billCount += Number(item.billCount || 0);
    }

    // 2. Customer Advance & Credit Settlement UPI breakdown
    for (const item of (shift.advanceCreditUpiBreakdown || [])) {
      const amt = Number(item.totalAmount || 0);
      if (amt <= 0) continue;
      const bankId = item.bankAccountId
        ? String(item.bankAccountId)
        : (defaultBank ? String(defaultBank._id) : null);
      if (!bankId) continue;

      if (!bankTotalsMap.has(bankId)) {
        bankTotalsMap.set(bankId, {
          bankAccountId: bankId,
          bankName: item.bankName || defaultBank?.bankMasterId?.name || defaultBank?.accountName || "Bank Account",
          accountNumber: item.accountNumber || defaultBank?.accountNumber || "",
          totalAmount: 0,
          transactionCount: 0,
          billCount: 0,
        });
      }
      const entry = bankTotalsMap.get(bankId);
      entry.totalAmount += amt;
      entry.transactionCount += Number(item.transactionCount || 0);
    }

    // 3. Fallback: If bankTotalsMap is empty for this shift but shift recorded positive UPI collections
    const shiftTotalRecordedUpi = Math.round(
      Number(
        shift.actualClosingUpiAmount ||
        shift.expectedClosingUpiAmount ||
        ((Number(shift.salesUpiTotal || 0)) + (Number(shift.advanceUpiTotal || 0)) + (Number(shift.creditUpiTotal || 0)))
      ) * 100
    ) / 100;

    const currentShiftMappedAmt = (shift.upiBreakdown || []).reduce((sum, u) => sum + Number(u.totalAmount || 0), 0) +
      (shift.advanceCreditUpiBreakdown || []).reduce((sum, u) => sum + Number(u.totalAmount || 0), 0);

    if (currentShiftMappedAmt === 0 && shiftTotalRecordedUpi > 0 && defaultBank?._id) {
      const defaultBankId = String(defaultBank._id);
      if (!bankTotalsMap.has(defaultBankId)) {
        bankTotalsMap.set(defaultBankId, {
          bankAccountId: defaultBankId,
          bankName: defaultBank?.bankMasterId?.name || defaultBank?.accountName || "Bank Account",
          accountNumber: defaultBank?.accountNumber || "",
          totalAmount: 0,
          transactionCount: 0,
          billCount: 0,
        });
      }
      const entry = bankTotalsMap.get(defaultBankId);
      entry.totalAmount += shiftTotalRecordedUpi;
      entry.transactionCount += 1;
      entry.billCount += 1;
    }
  }

  return { bankTotalsMap, defaultBank };
};

/**
 * Closes a Business Day.
 *
 * On close:
 *   - Verifies no linked Shift is still 'open'.
 *   - Aggregates all financial data from linked Shifts.
 *   - Stores per-shift cash breakdown in cashByShift[].
 *   - Sets status: 'closed' and records actualClosedAt.
 *
 * @param {string} businessDayId
 * @param {string} userId
 * @param {object} payload
 * @param {number} [payload.actualClosingCashAmount]
 * @param {Array}  [payload.closingDenominations]
 * @param {string} [payload.note]
 */
export const closeBusinessDay = async (businessDayId, userId, payload = {}) => {
  const { actualClosingCashAmount, closingDenominations = [], note } = payload;

  const businessDay = await BusinessDay.findById(businessDayId);
  if (!businessDay) throw new ApiError(404, "Business Day not found");
  if (businessDay.status === "closed") throw new ApiError(400, "Business Day is already closed");
  if (businessDay.status === "cancelled") throw new ApiError(400, "Cancelled Business Day cannot be closed");

  // Guard: All linked shifts must be closed
  const openShifts = await Shift.find({
    businessDayId: businessDay._id,
    status: "open",
  });
  if (openShifts.length > 0) {
    throw new ApiError(
      400,
      `Cannot close the Business Day. ${openShifts.length} shift(s) are still open. ` +
      `Please close all shifts first.`
    );
  }

  // Fetch all shifts that belong to this Business Day
  const shifts = await Shift.find({
    businessDayId: businessDay._id,
    status: { $ne: "cancelled" },
  }).sort({ openedAt: 1 });

  // ── Aggregate financial data from all shifts ──────────────────────────────
  let openingTotal = 0;
  let openingDenominations = [];
  let expectedTotal = 0;
  let closingDenominationsFromShifts = [];
  let totalFundWithdrawals = 0;
  let totalFundDeposits = 0;
  let totalManualDeposits = 0;
  let totalManualWithdrawals = 0;
  const cashByShift = [];

  if (shifts.length > 0) {
    const firstShift = shifts[0];
    const lastShift = shifts[shifts.length - 1];

    openingTotal = firstShift.openingFloatAmount || 0;
    openingDenominations = firstShift.openingDenominations || [];
    expectedTotal = lastShift.expectedClosingCashAmount || 0;
    closingDenominationsFromShifts = lastShift.closingDenominations || [];

    totalFundWithdrawals = shifts.reduce((sum, s) => sum + (s.totalFundWithdrawals || 0), 0);
    totalFundDeposits = shifts.reduce((sum, s) => sum + (s.totalFundDeposits || 0), 0);

    for (const s of shifts) {
      const shiftDeposits = (s.manualDeposits || []).reduce((acc, d) => acc + (d.amount || 0), 0);
      const shiftWithdrawals = (s.manualWithdrawals || [])
        .filter((w) => w.source === "running")
        .reduce((acc, w) => acc + (w.amount || 0), 0);

      totalManualDeposits += shiftDeposits;
      totalManualWithdrawals += shiftWithdrawals;

      cashByShift.push({
        shiftId:      s._id,
        shiftName:    s.shiftName || "",
        shiftNo:      s.shiftNo || "",
        openingFloat: s.openingFloatAmount || 0,
        cashSales:    s.cashSalesTotal || 0,
        deposits:     shiftDeposits,
        withdrawals:  shiftWithdrawals,
        expectedCash: s.expectedClosingCashAmount || 0,
        actualCash:   s.actualClosingCashAmount || 0,
      });
    }
  }

  // Use provided actualClosingCashAmount if given, else use last shift's amount
  const finalActualCash =
    actualClosingCashAmount !== undefined && actualClosingCashAmount !== null
      ? Number(actualClosingCashAmount)
      : (shifts[shifts.length - 1]?.actualClosingCashAmount || 0);

  const finalClosingDenominations =
    closingDenominations.length > 0 ? closingDenominations : closingDenominationsFromShifts;

  // ── Write all aggregated data to Business Day ─────────────────────────────
  businessDay.status = "closed";
  businessDay.actualClosedAt = new Date();
  businessDay.closedBy = userId;

  businessDay.openingFloatAmount = openingTotal;
  businessDay.openingDenominations = openingDenominations;
  businessDay.expectedClosingCashAmount = expectedTotal;
  businessDay.actualClosingCashAmount = finalActualCash;
  businessDay.closingDenominations = finalClosingDenominations;
  businessDay.cashDifferenceAmount = finalActualCash - expectedTotal;
  businessDay.totalFundWithdrawals = totalFundWithdrawals;
  businessDay.totalFundDeposits = totalFundDeposits;
  businessDay.totalManualDeposits = totalManualDeposits;
  businessDay.totalManualWithdrawals = totalManualWithdrawals;
  businessDay.cashByShift = cashByShift;

  // ── Consolidated UPI Settlement across all shifts ─────────────────────────
  if (businessDay.upiSettlementStatus !== "SETTLED") {
    try {
      const { bankTotalsMap } = await aggregateBusinessDayUpiCollections(businessDay, shifts);

      const upiClearingAccount = await getUpiClearingAccount(
        businessDay.workspaceId,
        businessDay.companyId,
        userId
      );

      const now = new Date();
      const settlementTxDate = now;
      const upiSettlementTransactions = [];
      const upiBankBreakdown = [];
      let grandTotalUpiAmount = 0;
      let grandTotalUpiTransactions = 0;

      for (const [bankId, bankData] of bankTotalsMap.entries()) {
        const netAmount = Math.round(Number(bankData.totalAmount) * 100) / 100;
        if (netAmount <= 0) continue;

        const totalTxCount = bankData.transactionCount || bankData.billCount || 1;
        grandTotalUpiAmount += netAmount;
        grandTotalUpiTransactions += totalTxCount;

        const settlementPayload = {
          transactionDate: settlementTxDate,
          bankAccountId: bankId,
          transactionType: BANK_TRANSACTION_TYPE.UPI,
          paymentMode: BANK_TRANSACTION_PAYMENT_MODE.UPI,
          category: BANK_TRANSACTION_CATEGORY.UPI_SETTLEMENT,
          direction: BANK_TRANSACTION_DIRECTION.CREDIT,
          amount: netAmount,
          referenceNumber: `BD-${businessDay.businessDayNo}`,
          narration: `Business Day ${businessDay.businessDayNo} UPI Settlement (${totalTxCount} payments across ${shifts.length} shifts)`,
          counterpartyAccountId: upiClearingAccount?._id || null,
          businessDayId: businessDay._id,
          status: BANK_TRANSACTION_STATUS.POSTED,
        };

        const createdBt = await bankTransactionService.createBankTransaction(
          businessDay.workspaceId,
          businessDay.companyId,
          userId,
          settlementPayload
        );

        if (createdBt?._id) {
          upiSettlementTransactions.push(createdBt._id);
        }

        upiBankBreakdown.push({
          bankAccountId: bankId,
          bankName: bankData.bankName,
          accountNumber: bankData.accountNumber,
          totalAmount: netAmount,
          transactionCount: totalTxCount,
          billCount: bankData.billCount || totalTxCount,
          bankTransactionId: createdBt?._id || null,
        });
      }

      businessDay.upiSettlementStatus = "SETTLED";
      businessDay.upiSettledAt = now;
      businessDay.upiSettledBy = userId;
      businessDay.totalUpiAmount = Math.round(grandTotalUpiAmount * 100) / 100;
      businessDay.totalUpiTransactions = grandTotalUpiTransactions;
      businessDay.upiBankBreakdown = upiBankBreakdown;
      businessDay.upiSettlementTransactions = upiSettlementTransactions;

      // Mark all linked shifts as SETTLED
      if (shifts.length > 0) {
        await Shift.updateMany(
          { _id: { $in: shifts.map((s) => s._id) } },
          { $set: { upiSettlementStatus: "SETTLED", upiSettledAt: now } }
        );
      }
    } catch (upiSettleErr) {
      console.error("[BusinessDay] Error settling consolidated UPI bank transactions at business day close:", upiSettleErr);
    }
  }

  if (note) businessDay.note = note;

  await businessDay.save();
  return businessDay;
};

/**
 * Cancels a Business Day.
 * Only allowed if status is 'open' (not 'closed').
 */
export const cancelBusinessDay = async (businessDayId, userId, note) => {
  const businessDay = await BusinessDay.findById(businessDayId);
  if (!businessDay) throw new ApiError(404, "Business Day not found");
  if (businessDay.status === "closed") {
    throw new ApiError(400, "A closed Business Day cannot be cancelled");
  }

  businessDay.status = "cancelled";
  businessDay.actualClosedAt = new Date();
  businessDay.closedBy = userId;
  if (note) businessDay.note = note;

  await businessDay.save();
  return businessDay;
};
