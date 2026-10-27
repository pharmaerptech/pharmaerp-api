import { Shift } from "./shift.model.js";
import { DayClosing } from "../day-closings/dayClosing.model.js";
import { BusinessDay } from "../business-days/businessDay.model.js";
import { getOpenBusinessDay } from "../business-days/businessDay.service.js";
import SalesInvoice from "../../sales/invoices/models/invoice.model.js";
import BankTransaction from "../../finance/treasury/bank-management/bank-transactions/models/bankTransaction.model.js";
import branchCashService from "../../finance/treasury/cash-management/branch-cash/services/branchCash.service.js";
import ApiError from "../../../utils/ApiError.js";
import { getTimePeriod, periodIdToLabel } from "../../../utils/timePeriod.js";
import { getBusinessDateRange } from "../../../utils/businessDate.js";

import branchCashRepository from "../../finance/treasury/cash-management/branch-cash/repositories/branchCash.repository.js";
import journalPostingService from "../../finance/journal-vouchers/services/journalPosting.service.js";
import PaymentQr from "../../finance/treasury/payment-qr/models/paymentQr.model.js";
import CustomerAdvanceTransaction from "../../parties/customers/models/customerAdvanceTransaction.model.js";
import bankTransactionService from "../../finance/treasury/bank-management/bank-transactions/services/bankTransaction.service.js";
import BankAccount from "../../finance/treasury/bank-management/bank-accounts/models/bankAccount.model.js";
import { getUpiClearingAccount } from "../../finance/treasury/shared/findOrCreateSystemAccount.js";
import {
  BANK_TRANSACTION_TYPE,
  BANK_TRANSACTION_DIRECTION,
  BANK_TRANSACTION_STATUS,
  BANK_TRANSACTION_PAYMENT_MODE,
  BANK_TRANSACTION_CATEGORY,
} from "../../finance/treasury/bank-management/bank-transactions/constants/bankTransaction.constant.js";

export const openShift = async (data) => {
  const { workspaceId, companyId, branchId, date } = data;

  // Guard 1: An OPEN Business Day must exist for this branch.
  const openDay = await getOpenBusinessDay(branchId);
  if (!openDay) {
    throw new ApiError(400, "No open Business Day found for this branch. Please open a Business Day first before starting a shift.");
  }

  // Guard 2: Ensure no currently open shift for this branch
  const existingOpenShift = await Shift.findOne({ branchId, status: "open" });
  if (existingOpenShift) {
    throw new ApiError(400, "An open shift already exists for this branch. Please close it first.");
  }

  // Ensure BranchCash is initialized for this branch (idempotent)
  if (branchId) {
    try {
      await branchCashService.initializeBranchCash(
        workspaceId,
        companyId,
        data.openedBy || data.createdBy,
        branchId,
        null // branch name not required for idempotent init
      );
    } catch (err) {
      console.warn("[Shift] Could not ensure BranchCash for branch:", err.message);
    }
  }

  // Resolve opening denominations and ensure openingFloatAmount is exact denomination sum
  let openingDenominations = data.openingDenominations || [];
  let openingFloatAmount = Number(data.openingFloatAmount) || 0;

  if (openingDenominations.length > 0) {
    openingFloatAmount = openingDenominations.reduce(
      (sum, d) => sum + (Number(d.denomination) || 0) * (Number(d.count || d.quantity) || 0),
      0
    );
  } else if (branchId) {
    try {
      const branchBalance = await branchCashRepository.findBalanceByBranchId(branchId, companyId);
      if (branchBalance?.runningDenominations?.length > 0) {
        openingDenominations = branchBalance.runningDenominations.map((d) => ({
          denomination: d.denomination,
          count: d.quantity,
          amount: d.subtotal || (d.denomination * d.quantity),
        }));
        openingFloatAmount = openingDenominations.reduce((sum, d) => sum + (d.amount || 0), 0);
      }
    } catch (e) {
      console.warn("[Shift] Could not fetch runningDenominations for openShift:", e.message);
    }
  }

  const shift = await Shift.create({
    ...data,
    // Derive date from the active Business Day (not from user input)
    date: openDay.businessDate,
    businessDayId: openDay._id,
    openingFloatAmount,
    openingDenominations,
  });

  // Add this shift to the Business Day's shifts array
  await BusinessDay.findByIdAndUpdate(openDay._id, {
    $addToSet: { shifts: shift._id },
  });

  return shift;
};

/**
 * Close a shift.
 *
 * New behaviour:
 *   1. Calculate totalCash = openingFloat + cashSalesThisShift
 *   2. carryForwardAmount = how much the pharmacist wants in running for next shift
 *   3. frozenAtClose = totalCash - carryForwardAmount → moves to frozen reserve
 *   4. BranchCash is updated atomically via branchCashService.freezeAtShiftClose
 *
 * @param {string} shiftId
 * @param {string} userId
 * @param {number} actualClosingCashAmount   - physical cash counted at close
 * @param {Array}  closingDenominations      - denomination breakdown of physical cash
 * @param {string} note
 * @param {number} carryForwardAmount        - how much to keep as running (rest becomes frozen)
 * @param {Array}  frozenDenominations       - denomination breakdown of frozen portion
 */
export const closeShift = async (
  shiftId,
  userId,
  actualClosingCashAmount,
  closingDenominations = [],
  note,
  carryForwardAmount = 0,
  frozenDenominations = []
) => {
  const shift = await Shift.findById(shiftId);
  if (!shift) throw new ApiError(404, "Shift not found");
  if (shift.status !== "open") throw new ApiError(400, "Shift is not open");

  // Validate carryForwardAmount
  const safeCarry = Math.max(0, Number(carryForwardAmount) || 0);
  const totalCash = Math.max(0, Number(actualClosingCashAmount) || 0);

  if (safeCarry > totalCash) {
    throw new ApiError(
      400,
      `Carry-forward amount (₹${safeCarry}) cannot exceed actual closing cash (₹${totalCash})`
    );
  }

  const frozenAmount = totalCash - safeCarry;

  // ── Calculate expected cash and sales totals dynamically ─────────────────
  const query = {
    workspaceId: shift.workspaceId,
    companyId: shift.companyId,
    isDeleted: false,
    $or: [
      { shiftId: shift._id },
      { createdAt: { $gte: shift.openedAt || shift.createdAt, $lte: new Date() } },
    ],
  };

  if (shift.branchId) query.branchId = shift.branchId;

  const invoices = await SalesInvoice.find(query).populate("customerId", "name phone");

  let totalCashSales = 0;
  let upiSalesTotal = 0;
  let splitSalesTotal = 0;
  let splitInvoiceCount = 0;
  let splitCashAmount = 0;
  let splitUpiAmount = 0;
  let pureCashAmount = 0;
  let pureUpiAmount = 0;
  let pureCashCount = 0;
  let pureUpiCount = 0;
  let creditSalesTotal = 0;
  let creditInvoiceCount = 0;
  let advanceSalesTotal = 0;
  let advanceInvoiceCount = 0;

  // Cancelled metrics tracking
  let cancelledInvoiceCount = 0;
  let cancelledSalesTotal = 0;
  let cancelledCashTotal = 0;
  let cancelledUpiTotal = 0;
  let cancelledSplitTotal = 0;
  const cancelledInvoices = [];
  const cancelledBreakdown = {
    cash: { count: 0, amount: 0 },
    upi: { count: 0, amount: 0 },
    split: { count: 0, amount: 0 },
    card: { count: 0, amount: 0 },
    wallet: { count: 0, amount: 0 },
    other: { count: 0, amount: 0 },
  };

  // Per-UPI breakdown tracking: { [qrId]: { transactionCount, totalAmount, invoiceIds: Set } }
  const upiBreakdownRaw = {};
  const _trackUpi = (qrId, amount, invoiceId, isSplit = false) => {
    const key = qrId ? String(qrId) : "unattributed";
    if (!upiBreakdownRaw[key]) {
      upiBreakdownRaw[key] = {
        transactionCount: 0,
        totalAmount: 0,
        invoiceIds: new Set(),
        pureBillCount: 0,
        splitBillCount: 0,
      };
    }
    upiBreakdownRaw[key].transactionCount += 1;
    upiBreakdownRaw[key].totalAmount += Number(amount) || 0;
    if (invoiceId) {
      upiBreakdownRaw[key].invoiceIds.add(String(invoiceId));
    }
    if (isSplit) {
      upiBreakdownRaw[key].splitBillCount++;
    } else {
      upiBreakdownRaw[key].pureBillCount++;
    }
  };

  for (const inv of invoices) {
    if (inv.status === "Cancelled") {
      cancelledInvoiceCount += 1;
      const billTotal = Number(inv.grandTotal || 0);
      cancelledSalesTotal += billTotal;
      const isSplit = inv.paymentMethod === "Split";
      const pMethod = String(inv.paymentMethod || "CASH").toUpperCase();

      if (isSplit) {
        cancelledSplitTotal += billTotal;
        cancelledBreakdown.split.count += 1;
        cancelledBreakdown.split.amount += billTotal;
        if (Array.isArray(inv.payments)) {
          for (const p of inv.payments) {
            const pt = String(p.paymentType || p.mode || "").toUpperCase();
            const amt = Number(p.amount || 0);
            if (pt.includes("UPI") || pt.includes("QR")) {
              cancelledUpiTotal += amt;
            } else if (pt.includes("CASH")) {
              cancelledCashTotal += amt;
            }
          }
        }
      } else if (pMethod.includes("UPI") || pMethod.includes("QR")) {
        cancelledUpiTotal += billTotal;
        cancelledBreakdown.upi.count += 1;
        cancelledBreakdown.upi.amount += billTotal;
      } else if (pMethod.includes("CASH")) {
        cancelledCashTotal += billTotal;
        cancelledBreakdown.cash.count += 1;
        cancelledBreakdown.cash.amount += billTotal;
      } else if (pMethod.includes("CARD")) {
        cancelledBreakdown.card.count += 1;
        cancelledBreakdown.card.amount += billTotal;
      } else if (pMethod.includes("WALLET")) {
        cancelledBreakdown.wallet.count += 1;
        cancelledBreakdown.wallet.amount += billTotal;
      } else {
        cancelledBreakdown.other.count += 1;
        cancelledBreakdown.other.amount += billTotal;
      }

      cancelledInvoices.push({
        invoiceId: inv._id,
        invoiceNo: inv.invoiceNo,
        grandTotal: billTotal,
        paymentMethod: inv.paymentMethod || "Cash",
        payments: inv.payments || [],
        cancelledAt: inv.cancelledAt || inv.updatedAt || new Date(),
        cancelledBy: inv.cancelledBy || null,
        customerName: inv.customerId?.name || "Walk-in Customer",
      });
      continue;
    }

    const isSplit = inv.paymentMethod === "Split";
    if (isSplit) {
      splitInvoiceCount += 1;
      splitSalesTotal += inv.grandTotal || 0;

      let billSplitCash = 0;
      let billSplitUpi = 0;
      let hasCreditInBill = false;
      let hasAdvanceInBill = false;
      if (Array.isArray(inv.payments) && inv.payments.length > 0) {
        for (const p of inv.payments) {
          const pt = String(p.paymentType || p.mode || "").toUpperCase();
          const amt = Number(p.amount) || 0;
          if (pt.includes("UPI") || pt.includes("QR")) {
            billSplitUpi += amt;
            upiSalesTotal += amt;
            _trackUpi(p.paymentQrId || inv.paymentQrId, amt, inv._id, true);
          } else if (pt.includes("CREDIT")) {
            creditSalesTotal += amt;
            hasCreditInBill = true;
          } else if (pt.includes("ADVANCE") || pt.includes("WALLET")) {
            advanceSalesTotal += amt;
            hasAdvanceInBill = true;
          } else if (
            pt.includes("CASH") ||
            (!pt.includes("CARD"))
          ) {
            billSplitCash += amt;
            totalCashSales += amt;
          }
        }
      } else {
        const tendered = Number(inv.cashTendered || 0);
        billSplitCash = Math.min(Number(inv.grandTotal || 0), tendered);
        billSplitUpi = Math.max(0, Number(inv.grandTotal || 0) - billSplitCash);
        totalCashSales += billSplitCash;
        upiSalesTotal += billSplitUpi;
      }
      if (hasCreditInBill) creditInvoiceCount += 1;
      if (hasAdvanceInBill) advanceInvoiceCount += 1;
      splitCashAmount += billSplitCash;
      splitUpiAmount += billSplitUpi;
    } else {
      const pMethod = String(inv.paymentMethod || "CASH").toUpperCase();
      if (pMethod.includes("UPI") || pMethod.includes("QR")) {
        pureUpiCount += 1;
        const amt = inv.grandTotal || 0;
        pureUpiAmount += amt;
        upiSalesTotal += amt;
        _trackUpi(inv.paymentQrId, amt, inv._id, false);
      } else if (pMethod.includes("CASH")) {
        pureCashCount += 1;
        const cashCollected =
          inv.cashTendered - inv.changeDue > 0
            ? inv.cashTendered - inv.changeDue
            : inv.grandTotal || 0;
        pureCashAmount += cashCollected;
        totalCashSales += cashCollected;
      } else if (pMethod.includes("CREDIT")) {
        creditInvoiceCount += 1;
        creditSalesTotal += inv.grandTotal || 0;
      } else if (pMethod.includes("ADVANCE")) {
        advanceInvoiceCount += 1;
        advanceSalesTotal += inv.grandTotal || 0;
      } else {
        pureCashCount += 1;
        const amt = inv.grandTotal || 0;
        pureCashAmount += amt;
        totalCashSales += amt;
      }
    }
  }

  // ── Customer Advance & Credit Settlement Tracking for this Shift ─────────
  const advanceTxs = await CustomerAdvanceTransaction.find({
    workspaceId: shift.workspaceId,
    companyId: shift.companyId,
    status: "ACTIVE",
    isDeleted: false,
    $or: [
      { shiftId: shift._id },
      { createdAt: { $gte: shift.openedAt || shift.createdAt, $lte: new Date() } },
    ],
  }).lean();

  let advanceCashTotal = 0;
  let advanceCashTendered = 0;
  let advanceChangeDue = 0;
  let advanceCashCount = 0;
  let advanceUpiTotal = 0;
  let advanceUpiCount = 0;

  let creditCashTotal = 0;
  let creditCashTendered = 0;
  let creditChangeDue = 0;
  let creditCashCount = 0;
  let creditUpiTotal = 0;
  let creditUpiCount = 0;

  const advCreditUpiRaw = {};

  const _trackAdvCreditUpi = (paymentQrId, amount, sourceType) => {
    const key = paymentQrId ? String(paymentQrId) : "unattributed";
    if (!advCreditUpiRaw[key]) {
      advCreditUpiRaw[key] = {
        paymentQrId: paymentQrId || null,
        transactionCount: 0,
        totalAmount: 0,
        advanceCount: 0,
        advanceAmount: 0,
        creditCount: 0,
        creditAmount: 0,
        sourceType,
      };
    }
    advCreditUpiRaw[key].transactionCount++;
    advCreditUpiRaw[key].totalAmount += Number(amount) || 0;
    if (sourceType === "ADVANCE") {
      advCreditUpiRaw[key].advanceCount++;
      advCreditUpiRaw[key].advanceAmount += Number(amount) || 0;
    } else if (sourceType === "CREDIT") {
      advCreditUpiRaw[key].creditCount++;
      advCreditUpiRaw[key].creditAmount += Number(amount) || 0;
    }
    if (advCreditUpiRaw[key].advanceCount > 0 && advCreditUpiRaw[key].creditCount > 0) {
      advCreditUpiRaw[key].sourceType = "MIXED";
    }
  };

  for (const tx of advanceTxs) {
    const isReceipt = tx.type === "RECEIPT" || tx.type === "ADVANCE_RECEIVED";
    const isCreditSettled = tx.type === "CREDIT_SETTLED" || tx.type === "SETTLEMENT";
    const pMethod = String(tx.paymentMethod || "Cash").toUpperCase();
    const amt = Number(tx.amount || 0);
    const tendered = Number(tx.cashTendered || amt);
    const change = Number(tx.changeDue || 0);

    if (isReceipt) {
      if (pMethod.includes("UPI") || pMethod.includes("QR")) {
        advanceUpiTotal += amt;
        advanceUpiCount++;
        _trackAdvCreditUpi(tx.paymentQrId, amt, "ADVANCE");
      } else if (pMethod.includes("CASH")) {
        advanceCashTotal += amt;
        advanceCashTendered += tendered;
        advanceChangeDue += change;
        advanceCashCount++;
      }
    } else if (isCreditSettled) {
      if (pMethod.includes("UPI") || pMethod.includes("QR")) {
        creditUpiTotal += amt;
        creditUpiCount++;
        _trackAdvCreditUpi(tx.paymentQrId, amt, "CREDIT");
      } else if (pMethod.includes("CASH")) {
        creditCashTotal += amt;
        creditCashTendered += tendered;
        creditChangeDue += change;
        creditCashCount++;
      }
    }
  }

  // Compute manual deposit / withdrawal totals already recorded on the shift
  // (these are populated by branchCash.service when deposit/withdraw APIs are called
  //  during the open shift — we now include them in the expected-cash formula)
  const totalManualDeposits = (shift.manualDeposits || []).reduce((s, d) => s + (d.amount || 0), 0);
  const totalManualWithdrawalsFromRunning = (shift.manualWithdrawals || [])
    .filter((w) => w.source === "running")
    .reduce((s, w) => s + (w.amount || 0), 0);

  // Expected = Opening + Cash Sales + Customer Advance Cash + Customer Credit Cash + Deposits into Running − Withdrawals from Running
  const expectedCash =
    shift.openingFloatAmount +
    totalCashSales +
    advanceCashTotal +
    creditCashTotal +
    totalManualDeposits -
    totalManualWithdrawalsFromRunning;

  // ── Check for Denomination-wise Adjustment ───────────────────────────────
  let isAdjusted = false;
  let expectedDenominations = [];
  let adjustedDenominations = [];
  if (shift.branchId) {
    const balance = await branchCashRepository.findBalanceByBranchId(shift.branchId, shift.companyId);
    const runningDenoms = balance?.runningDenominations || [];
    const expectedMap = new Map(runningDenoms.map(d => [Number(d.denomination), Number(d.quantity) || 0]));
    const closingMap = new Map(closingDenominations.map(d => [Number(d.denomination), Number(d.count || d.quantity) || 0]));
    
    // Build expectedDenominations array
    expectedDenominations = Array.from(expectedMap.entries()).map(([denom, count]) => ({
      denomination: denom,
      count: count,
      amount: denom * count
    })).filter(d => d.count > 0);

    for (const d of [500, 200, 100, 50, 20, 10, 5, 2, 1]) {
      const expCount = expectedMap.get(d) || 0;
      const actCount = closingMap.get(d) || 0;
      if (expCount !== actCount) {
        isAdjusted = true;
        adjustedDenominations.push({
          denomination: d,
          expectedCount: expCount,
          actualCount: actCount
        });
      }
    }
  }

  // ── Freeze excess cash into frozen reserve OR apply adjustment ──────────
  if ((frozenAmount > 0 || isAdjusted) && shift.branchId) {
    try {
      await branchCashService.freezeAtShiftClose(
        shift.branchId.toString(),
        shift.companyId.toString(),
        userId,
        frozenAmount,
        frozenDenominations,
        closingDenominations  // full counted denominations for carry-forward calculation
      );
      
      if (frozenAmount > 0) {
        // Log freeze event to frozenLedger for day-closing timeline
        await branchCashService.pushFreezeAuditEntry(
          shift.branchId.toString(),
          shift.companyId.toString(),
          { frozenAmount, shiftId: shift._id, userId },
        );
      }
    } catch (freezeErr) {
      console.warn("[Shift] freezeAtShiftClose warning:", freezeErr.message);
      // Non-fatal if BranchCash hasn't been initialised yet (legacy data)
    }
  }

  // ── Post Shift Adjustment (if adjusted) ────────────
  const cashDifferenceAmount = totalCash - expectedCash;
  if (isAdjusted && shift.branchId) {
    try {
      await branchCashService.postShiftAdjustment(
        shift.workspaceId.toString(),
        shift.companyId.toString(),
        userId,
        shift.branchId.toString(),
        cashDifferenceAmount,
        shift._id.toString()
      );
    } catch (adjErr) {
      console.warn("[Shift] postShiftAdjustment warning:", adjErr.message);
    }
  }

  // ── Capture Branch Cash Snapshot ─────────────────────────────────────────
  let branchRunningCashAtClose = null;
  let branchFrozenCashAtClose = null;
  if (shift.branchId) {
    try {
      const finalBalance = await branchCashService.getByBranchId(
        shift.branchId.toString(),
        shift.companyId.toString()
      );
      if (finalBalance) {
        branchRunningCashAtClose = finalBalance.runningCash || 0;
        branchFrozenCashAtClose = finalBalance.frozenCash || 0;
      }
    } catch (err) {
      console.warn("[Shift] Error capturing branch cash snapshot:", err.message);
    }
  }

  // ── Update shift record ──────────────────────────────────────────────────
  shift.expectedClosingCashAmount = expectedCash;
  shift.actualClosingCashAmount = totalCash;
  shift.closingDenominations = closingDenominations;
  shift.expectedDenominations = expectedDenominations;
  shift.adjustedDenominations = adjustedDenominations;
  shift.cashDifferenceAmount = cashDifferenceAmount;
  shift.isAdjusted = isAdjusted;
  shift.carryForwardAmount = safeCarry;
  shift.frozenAtClose = frozenAmount;
  shift.branchRunningCashAtClose = branchRunningCashAtClose;
  shift.branchFrozenCashAtClose = branchFrozenCashAtClose;
  shift.cashSalesTotal = totalCashSales; // persisted for day-closing aggregation
  shift.upiSalesTotal = upiSalesTotal;
  shift.splitSalesTotal = splitSalesTotal;
  shift.splitInvoiceCount = splitInvoiceCount;
  shift.splitCashAmount = splitCashAmount;
  shift.splitUpiAmount = splitUpiAmount;
  shift.pureCashAmount = pureCashAmount;
  shift.pureUpiAmount = pureUpiAmount;
  shift.cashInvoiceCount = pureCashCount;
  shift.paymentQrCount = pureUpiCount;
  shift.creditSalesTotal = creditSalesTotal;
  shift.creditInvoiceCount = creditInvoiceCount;
  shift.advanceSalesTotal = advanceSalesTotal;
  shift.advanceInvoiceCount = advanceInvoiceCount;
  shift.cancelledInvoiceCount = cancelledInvoiceCount;
  shift.cancelledSalesTotal = cancelledSalesTotal;
  shift.cancelledCashTotal = cancelledCashTotal;
  shift.cancelledUpiTotal = cancelledUpiTotal;
  shift.cancelledSplitTotal = cancelledSplitTotal;
  shift.cancelledInvoices = cancelledInvoices;
  shift.cancelledBreakdown = cancelledBreakdown;

  // Persist customer advance & credit settlement totals
  shift.advanceCashTotal = advanceCashTotal;
  shift.advanceCashTendered = advanceCashTendered;
  shift.advanceChangeDue = advanceChangeDue;
  shift.advanceCashCount = advanceCashCount;
  shift.advanceUpiTotal = advanceUpiTotal;
  shift.advanceUpiCount = advanceUpiCount;
  shift.creditCashTotal = creditCashTotal;
  shift.creditCashTendered = creditCashTendered;
  shift.creditChangeDue = creditChangeDue;
  shift.creditCashCount = creditCashCount;
  shift.creditUpiTotal = creditUpiTotal;
  shift.creditUpiCount = creditUpiCount;

  // ── Build and persist enriched per-QR / per-Bank UPI breakdown ─────────────
  const qrIds = Object.keys(upiBreakdownRaw).filter((k) => k !== "unattributed");
  let upiBreakdown = [];
  if (qrIds.length > 0) {
    const qrDocs = await PaymentQr.find({ _id: { $in: qrIds } })
      .populate({
        path: "bankAccountId",
        select: "accountName accountNumber ifscCode bankMasterId",
        populate: { path: "bankMasterId", select: "name shortName" },
      })
      .lean();
    const qrMap = {};
    for (const qr of qrDocs) qrMap[String(qr._id)] = qr;

    upiBreakdown = Object.entries(upiBreakdownRaw).map(([key, data]) => {
      const pureBillCount = data.pureBillCount || 0;
      const splitBillCount = data.splitBillCount || 0;
      const totalBillsForQr = (pureBillCount + splitBillCount) || (data.invoiceIds ? data.invoiceIds.size : data.transactionCount);
      if (key === "unattributed") {
        return {
          paymentQrId: null,
          upiId: "Unattributed",
          label: "Legacy / Untracked UPI",
          provider: null,
          bankAccountId: null,
          bankName: "Unlinked Bank",
          accountName: "Direct / Legacy UPI",
          accountNumber: "",
          qrImageUrl: null,
          transactionCount: data.transactionCount,
          billCount: totalBillsForQr,
          pureBillCount,
          splitBillCount,
          totalAmount: data.totalAmount,
        };
      }
      const qr = qrMap[key] || {};
      const bankAcct = qr.bankAccountId || {};
      const bankMaster = bankAcct.bankMasterId || {};
      const bankName = bankMaster.name || bankMaster.shortName || bankAcct.accountName || "Bank";
      return {
        paymentQrId: qr._id || key,
        upiId: qr.upiId || key,
        label: qr.label || qr.upiId || "UPI QR",
        provider: qr.provider || null,
        bankAccountId: bankAcct._id || null,
        bankName,
        accountName: bankAcct.accountName || "",
        accountNumber: bankAcct.accountNumber ? `••••${String(bankAcct.accountNumber).slice(-4)}` : "",
        qrImageUrl: qr.qrImageUrl || null,
        transactionCount: data.transactionCount,
        billCount: totalBillsForQr,
        pureBillCount,
        splitBillCount,
        totalAmount: data.totalAmount,
      };
    });
  } else if (upiBreakdownRaw["unattributed"]) {
    const data = upiBreakdownRaw["unattributed"];
    const pureBillCount = data.pureBillCount || 0;
    const splitBillCount = data.splitBillCount || 0;
    const totalBillsForQr = (pureBillCount + splitBillCount) || (data.invoiceIds ? data.invoiceIds.size : data.transactionCount);
    upiBreakdown = [
      {
        paymentQrId: null,
        upiId: "Unattributed",
        label: "Legacy / Untracked UPI",
        provider: null,
        bankAccountId: null,
        bankName: "Unlinked Bank",
        accountName: "Direct / Legacy UPI",
        accountNumber: "",
        qrImageUrl: null,
        transactionCount: data.transactionCount,
        billCount: totalBillsForQr,
        pureBillCount,
        splitBillCount,
        totalAmount: data.totalAmount,
      },
    ];
  }
  shift.upiBreakdown = upiBreakdown;

  // ── Build and persist enriched per-QR advance/credit UPI breakdown ────────
  const advQrIds = Object.keys(advCreditUpiRaw).filter((k) => k !== "unattributed");
  let advanceCreditUpiBreakdown = [];
  if (advQrIds.length > 0) {
    const qrDocs = await PaymentQr.find({ _id: { $in: advQrIds } })
      .populate({
        path: "bankAccountId",
        select: "accountName accountNumber ifscCode bankMasterId",
        populate: { path: "bankMasterId", select: "name shortName" },
      })
      .lean();
    const qrMap = {};
    for (const qr of qrDocs) qrMap[String(qr._id)] = qr;

    advanceCreditUpiBreakdown = Object.entries(advCreditUpiRaw).map(([key, data]) => {
      if (key === "unattributed") {
        return {
          paymentQrId: null,
          upiId: "Unattributed",
          label: "Legacy / Untracked UPI",
          provider: null,
          bankAccountId: null,
          bankName: "Unlinked Bank",
          accountName: "Direct / Legacy UPI",
          accountNumber: "",
          qrImageUrl: null,
          transactionCount: data.transactionCount,
          totalAmount: data.totalAmount,
          advanceCount: data.advanceCount,
          advanceAmount: data.advanceAmount,
          creditCount: data.creditCount,
          creditAmount: data.creditAmount,
          sourceType: data.sourceType,
        };
      }
      const qr = qrMap[key] || {};
      const bankAcct = qr.bankAccountId || {};
      const bankMaster = bankAcct.bankMasterId || {};
      const bankName = bankMaster.name || bankMaster.shortName || bankAcct.accountName || "Bank";
      return {
        paymentQrId: qr._id || key,
        upiId: qr.upiId || key,
        label: qr.label || qr.upiId || "UPI QR",
        provider: qr.provider || null,
        bankAccountId: bankAcct._id || null,
        bankName,
        accountName: bankAcct.accountName || "",
        accountNumber: bankAcct.accountNumber ? `••••${String(bankAcct.accountNumber).slice(-4)}` : "",
        qrImageUrl: qr.qrImageUrl || null,
        transactionCount: data.transactionCount,
        totalAmount: data.totalAmount,
        advanceCount: data.advanceCount,
        advanceAmount: data.advanceAmount,
        creditCount: data.creditCount,
        creditAmount: data.creditAmount,
        sourceType: data.sourceType,
      };
    });
  } else if (advCreditUpiRaw["unattributed"]) {
    const data = advCreditUpiRaw["unattributed"];
    advanceCreditUpiBreakdown = [
      {
        paymentQrId: null,
        upiId: "Unattributed",
        label: "Legacy / Untracked UPI",
        provider: null,
        bankAccountId: null,
        bankName: "Unlinked Bank",
        accountName: "Direct / Legacy UPI",
        accountNumber: "",
        qrImageUrl: null,
        transactionCount: data.transactionCount,
        totalAmount: data.totalAmount,
        advanceCount: data.advanceCount,
        advanceAmount: data.advanceAmount,
        creditCount: data.creditCount,
        creditAmount: data.creditAmount,
        sourceType: data.sourceType,
      },
    ];
  }
  shift.advanceCreditUpiBreakdown = advanceCreditUpiBreakdown;

  // Kept for backward compat, zeroed since fund transfers are deprecated
  shift.totalFundWithdrawals = 0;
  shift.totalFundDeposits = 0;
  shift.status = "closed";

  const now = new Date();
  shift.closedAt = now;
  shift.closedBy = userId;
  if (note) shift.note = note;

  const closePeriod = getTimePeriod(now);
  const openLabel = periodIdToLabel(shift.openPeriod || "morning");
  const closeLabel = periodIdToLabel(closePeriod.id);

  let baseName;
  if (shift.openPeriod === closePeriod.id) {
    baseName = `${closeLabel} Shift`;
  } else {
    baseName = `${openLabel} - ${closeLabel} Shift`;
  }

  const { dateFilter } = getBusinessDateRange(shift.date);

  const sameNameCount = await Shift.countDocuments({
    branchId: shift.branchId,
    date: dateFilter,
    status: "closed",
    shiftName: { $regex: `^${baseName}`, $options: "i" },
    _id: { $ne: shift._id },
  });

  shift.shiftName = sameNameCount > 0 ? `${baseName} ${sameNameCount + 1}` : baseName;
  shift.closePeriod = closePeriod.id;

  // ── Consolidated Per-Bank UPI Settlement ─────────────────────────────────
  // Hold all UPI payments during shift; at shift close, release exactly ONE entry per bank per shift!
  const invoiceNos = invoices
    .filter((inv) => inv.status !== "Cancelled")
    .map((inv) => inv.invoiceNo)
    .filter(Boolean);
  const advanceReceiptNos = advanceTxs
    .map((tx) => tx.referenceNumber)
    .filter(Boolean);

  let hasLegacyPendingFlushed = false;

  try {
    // 1. Backward compatibility: flush any legacy individual PENDING_SHIFT_CLOSE transactions from older shifts
    const pendingBankTxs = await BankTransaction.find({
      companyId: shift.companyId,
      workspaceId: shift.workspaceId,
      status: "PENDING_SHIFT_CLOSE",
      $or: [
        { shiftId: shift._id },
        ...(invoiceNos.length > 0 ? [{ referenceNumber: { $in: invoiceNos } }] : []),
        ...(advanceReceiptNos.length > 0 ? [{ referenceNumber: { $in: advanceReceiptNos } }] : []),
      ],
    });

    if (pendingBankTxs.length > 0) {
      hasLegacyPendingFlushed = true;
      for (const bt of pendingBankTxs) {
        if (bt.journalVoucherId) {
          try {
            await journalPostingService.postJournalVoucher(
              bt.journalVoucherId,
              shift.companyId,
              shift.workspaceId,
              userId
            );
          } catch (postErr) {
            console.error(`[Shift] Error posting legacy JV ${bt.journalVoucherId} for BT ${bt._id}:`, postErr);
          }
        }
        bt.status = "POSTED";
        bt.postedAt = now;
        bt.postedBy = userId;
        await bt.save();
      }
    }
  } catch (btFlushErr) {
    console.error("[Shift] Error flushing legacy pending UPI bank transactions:", btFlushErr);
  }

  // 2. Standard Shift-Consolidated UPI Settlement:
  // If no legacy individual transactions were flushed, aggregate net UPI collections by bank account
  // and create EXACTLY ONE BankTransaction and JournalVoucher per bank account.
  if (!hasLegacyPendingFlushed) {
    try {
      // Find fallback primary active bank account if unlinked/unattributed QRs exist
      const defaultBank =
        (await BankAccount.findOne({
          companyId: shift.companyId,
          workspaceId: shift.workspaceId,
          isDeleted: false,
          isActive: true,
          isPrimary: true,
        })) ||
        (await BankAccount.findOne({
          companyId: shift.companyId,
          workspaceId: shift.workspaceId,
          isDeleted: false,
          isActive: true,
        }));

      const bankTotalsMap = new Map();

      // Aggregate from Sales UPI breakdown
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
            bankName: item.bankName || "Bank Account",
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

      // Aggregate from Customer Advance & Credit Settlement UPI breakdown
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
            bankName: item.bankName || "Bank Account",
            totalAmount: 0,
            transactionCount: 0,
            billCount: 0,
          });
        }
        const entry = bankTotalsMap.get(bankId);
        entry.totalAmount += amt;
        entry.transactionCount += Number(item.transactionCount || 0);
      }

      // Safety Fallback: If bankTotalsMap is empty but shift has recorded positive UPI collections,
      // attribute the total UPI collection to the default bank so funds are never trapped!
      const totalRecordedUpi = Math.round(
        Number(
          shift.actualClosingUpiAmount ||
          shift.expectedClosingUpiAmount ||
          ((Number(shift.salesUpiTotal || 0)) + (Number(shift.advanceUpiTotal || 0)) + (Number(shift.creditUpiTotal || 0)))
        ) * 100
      ) / 100;

      if (bankTotalsMap.size === 0 && totalRecordedUpi > 0 && defaultBank?._id) {
        const defaultBankId = String(defaultBank._id);
        bankTotalsMap.set(defaultBankId, {
          bankAccountId: defaultBankId,
          bankName: defaultBank.bankMasterId?.name || defaultBank.accountName || "Bank Account",
          totalAmount: totalRecordedUpi,
          transactionCount: 1,
          billCount: 1,
        });
      }

      const upiClearingAccount = await getUpiClearingAccount(
        shift.workspaceId,
        shift.companyId,
        userId
      );


      for (const [bankId, bankData] of bankTotalsMap.entries()) {
        const netAmount = Math.round(Number(bankData.totalAmount) * 100) / 100;
        if (netAmount <= 0) continue;

        const totalTxCount = bankData.transactionCount || bankData.billCount || 1;
        const shiftDisplay = shift.shiftName || shift.shiftNo || "Shift";

        const settlementPayload = {
          transactionDate: now,
          bankAccountId: bankId,
          transactionType: BANK_TRANSACTION_TYPE.UPI,
          paymentMode: BANK_TRANSACTION_PAYMENT_MODE.UPI,
          category: BANK_TRANSACTION_CATEGORY.UPI_SETTLEMENT,
          direction: BANK_TRANSACTION_DIRECTION.CREDIT,
          amount: netAmount,
          referenceNumber: `SHIFT-${shift.shiftNo}`,
          narration: `${shiftDisplay} UPI Settlement (${totalTxCount} payments)`,
          counterpartyAccountId: upiClearingAccount?._id || null,
          shiftId: shift._id,
          status: BANK_TRANSACTION_STATUS.POSTED,
        };

        await bankTransactionService.createBankTransaction(
          shift.workspaceId,
          shift.companyId,
          userId,
          settlementPayload
        );
      }
    } catch (settleErr) {
      console.error("[Shift] Error creating consolidated UPI bank transactions at shift close:", settleErr);
    }
  }

  await shift.save();
  return shift;
};

export const cancelShift = async (shiftId, userId, note) => {
  const shift = await Shift.findById(shiftId);
  if (!shift) throw new ApiError(404, "Shift not found");
  if (shift.status === "closed") throw new ApiError(400, "Closed shift cannot be cancelled");

  shift.status = "cancelled";
  shift.closedAt = new Date();
  shift.closedBy = userId;
  if (note) shift.note = note;

  await shift.save();
  return shift;
};
