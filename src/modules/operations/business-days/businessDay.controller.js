import asyncHandler from "../../../utils/asyncHandler.js";
import ApiError from "../../../utils/ApiError.js";
import { BusinessDay } from "./businessDay.model.js";
import { Shift } from "../shifts/shift.model.js";
import Branch from "../../organization/branches/models/branch.model.js";
import BankDepositSlip from "../../finance/treasury/bank-deposit-slips/models/bankDepositSlip.model.js";
import SalesInvoice from "../../sales/invoices/models/invoice.model.js";
import SalesReturn from "../../sales/returns/models/salesReturn.model.js";
import FundTransfer from "../../finance/treasury/fund-transfers/models/fundTransfer.model.js";
import { FUND_TRANSFER_STATUS } from "../../finance/treasury/fund-transfers/constants/fundTransfer.constant.js";
import PaymentQr from "../../finance/treasury/payment-qr/models/paymentQr.model.js";
import {
  openBusinessDay as openBusinessDayService,
  closeBusinessDay as closeBusinessDayService,
  cancelBusinessDay as cancelBusinessDayService,
  getOpenBusinessDay as getOpenBusinessDayService,
  getSuggestedBusinessDate as getSuggestedBusinessDateService,
} from "./businessDay.service.js";

// ── Shared helpers (reused from shift summary logic) ─────────────────────────

const calculateShiftSummary = async (shift) => {
  const shiftEndTime = shift.status === "closed" ? shift.closedAt : new Date();

  const query = {
    workspaceId: shift.workspaceId,
    companyId: shift.companyId,
    isDeleted: false,
    $or: [
      { shiftId: shift._id },
      { createdAt: { $gte: shift.openedAt || shift.createdAt, $lte: shiftEndTime } },
    ],
  };

  if (shift.branchId) query.branchId = shift.branchId;

  const [salesInvoices, salesReturns] = await Promise.all([
    SalesInvoice.find(query),
    SalesReturn.find(query).catch(() => []),
  ]);
  const invoices = [...salesInvoices, ...salesReturns];

  let invoiceCount = 0;
  let cashInvoiceCount = 0;
  let netSales = 0;
  let paymentQrCount = 0;
  let qrNet = 0;
  let cashNet = 0;
  let splitInvoiceCount = 0;
  let splitNet = 0;
  let splitCashAmount = 0;
  let splitUpiAmount = 0;
  let pureCashAmount = 0;
  let pureUpiAmount = 0;

  const upiBreakdownRaw = {};

  const _trackUpi = (paymentQrId, amount) => {
    const key = paymentQrId ? String(paymentQrId) : "unattributed";
    if (!upiBreakdownRaw[key]) upiBreakdownRaw[key] = { transactionCount: 0, totalAmount: 0 };
    upiBreakdownRaw[key].transactionCount++;
    upiBreakdownRaw[key].totalAmount += amount;
  };

  for (const inv of invoices) {
    if (inv.shiftId && shift._id && String(inv.shiftId._id || inv.shiftId) !== String(shift._id)) {
      continue;
    }
    if (inv.status === "Cancelled") continue;

    const isReturn = Boolean(
      inv.isReturn ||
      inv.returnNo ||
      inv.status === "Returned" ||
      inv.grandTotal < 0 ||
      (inv.constructor && inv.constructor.modelName === "SalesReturn")
    );

    if (isReturn) {
      const billTotal = Math.abs(Number(inv.grandTotal || 0));
      netSales -= billTotal;
      const pMethod = String(inv.paymentMethod || "CASH").toUpperCase();
      const retType = String(inv.returnType || "").toLowerCase();

      if (inv.paymentMethod === "Split" && Array.isArray(inv.payments)) {
        for (const p of inv.payments) {
          const pType = String(p.paymentType || p.mode || "").toUpperCase();
          const amt = Math.abs(Number(p.amount || 0));
          if (pType.includes("UPI") || pType.includes("QR")) {
            qrNet -= amt;
            splitUpiAmount -= amt;
          } else if (pType.includes("CASH")) {
            cashNet -= amt;
            splitCashAmount -= amt;
          }
        }
      } else if (pMethod.includes("UPI") || pMethod.includes("QR")) {
        qrNet -= billTotal;
        pureUpiAmount -= billTotal;
      } else if (pMethod.includes("CASH") || retType === "cash_refund") {
        cashNet -= billTotal;
        pureCashAmount -= billTotal;
      }
      continue;
    }

    invoiceCount++;
    netSales += inv.grandTotal;

    if (inv.paymentMethod === "Split") {
      splitInvoiceCount++;
      splitNet += inv.grandTotal || 0;
      let billSplitCash = 0;
      let billSplitUpi = 0;
      if (Array.isArray(inv.payments) && inv.payments.length > 0) {
        for (const p of inv.payments) {
          const pType = p.paymentType ? p.paymentType.toUpperCase() : "CASH";
          const amt = Number(p.amount || 0);
          if (pType.includes("UPI") || pType.includes("QR")) {
            billSplitUpi += amt;
            _trackUpi(p.paymentQrId || inv.paymentQrId, amt);
          } else if (pType.includes("CASH")) {
            billSplitCash += amt;
          } else if (!pType.includes("CARD") && !pType.includes("WALLET") && !pType.includes("CREDIT")) {
            billSplitCash += amt;
          }
        }
      } else {
        const tendered = Number(inv.cashTendered || 0);
        billSplitCash = Math.min(Number(inv.grandTotal || 0), tendered);
        billSplitUpi = Math.max(0, Number(inv.grandTotal || 0) - billSplitCash);
      }
      splitCashAmount += billSplitCash;
      splitUpiAmount += billSplitUpi;
      cashNet += billSplitCash;
      qrNet += billSplitUpi;
    } else {
      const pMethod = inv.paymentMethod ? inv.paymentMethod.toUpperCase() : "CASH";
      if (pMethod.includes("UPI") || pMethod.includes("QR")) {
        paymentQrCount++;
        const amt = Number(inv.grandTotal || 0);
        pureUpiAmount += amt;
        qrNet += amt;
        _trackUpi(inv.paymentQrId, amt);
      } else if (pMethod.includes("CASH")) {
        cashInvoiceCount++;
        const amt = (inv.cashTendered - inv.changeDue > 0)
          ? (inv.cashTendered - inv.changeDue)
          : Number(inv.grandTotal || 0);
        pureCashAmount += amt;
        cashNet += amt;
      } else {
        cashInvoiceCount++;
        const amt = Number(inv.grandTotal || 0);
        pureCashAmount += amt;
        cashNet += amt;
      }
    }
  }

  // Enrich UPI breakdown with metadata
  const qrIds = Object.keys(upiBreakdownRaw).filter((k) => k !== "unattributed");
  let upiBreakdown = [];
  if (qrIds.length > 0) {
    const qrDocs = await PaymentQr.find({ _id: { $in: qrIds } }).select("upiId label provider").lean();
    const qrMap = {};
    for (const qr of qrDocs) qrMap[String(qr._id)] = qr;
    upiBreakdown = Object.entries(upiBreakdownRaw).map(([key, data]) => {
      if (key === "unattributed") {
        return { paymentQrId: null, upiId: "Unattributed", label: "Legacy / Untracked", provider: null, ...data };
      }
      const qr = qrMap[key] || {};
      return { paymentQrId: key, upiId: qr.upiId || key, label: qr.label || key, provider: qr.provider || null, ...data };
    });
  } else if (upiBreakdownRaw["unattributed"]) {
    upiBreakdown = [{ paymentQrId: null, upiId: "Unattributed", label: "Legacy / Untracked", provider: null, ...upiBreakdownRaw["unattributed"] }];
  }

  const shiftDeposits =
    (shift.manualDeposits || []).reduce((acc, d) => acc + (Number(d.amount) || 0), 0) ||
    Number(shift.totalFundDeposits) ||
    0;
  const shiftWithdrawals =
    (shift.manualWithdrawals || []).reduce((acc, w) => acc + (Number(w.amount) || 0), 0) ||
    Number(shift.totalFundWithdrawals) ||
    0;

  const expectedClosingCashAmount =
    shift.expectedClosingCashAmount !== undefined && shift.status === "closed"
      ? shift.expectedClosingCashAmount
      : (shift.openingFloatAmount || 0) + cashNet - shiftWithdrawals + shiftDeposits;

  return {
    ...shift.toObject(),
    totalFundDeposits: shiftDeposits,
    totalFundWithdrawals: shiftWithdrawals,
    invoiceCount,
    cashInvoiceCount,
    paymentQrCount,
    splitInvoiceCount,
    splitNet,
    splitCashAmount,
    splitUpiAmount,
    pureCashAmount,
    pureUpiAmount,
    netSales,
    cashNet,
    qrNet,
    upiBreakdown,
    expectedClosingCashAmount,
    cancelledInvoiceCount: shift.cancelledInvoiceCount || 0,
    cancelledSalesTotal: shift.cancelledSalesTotal || 0,
  };
};

const fetchFundTransfers = async ({ shifts = [], shiftIds = [], businessDayId = null }) => {
  const withdrawals = [];
  const deposits = [];
  let totalWithdrawals = 0;
  let totalDeposits = 0;

  // 1. Process shift manual deposits and manual withdrawals
  for (const s of shifts) {
    const shiftName = s.shiftName || `Shift ${s.shiftNo || ""}`;
    const shiftId = s._id;

    if (Array.isArray(s.manualDeposits)) {
      for (const dep of s.manualDeposits) {
        deposits.push({
          _id: dep._id,
          transferNumber: `DEP-${String(dep._id).slice(-6).toUpperCase()}`,
          referenceNo: `DEP-${String(dep._id).slice(-6).toUpperCase()}`,
          amount: Number(dep.amount) || 0,
          narration: dep.narration || "Manual cash deposit",
          transferDate: dep.date || s.openedAt,
          createdBy:
            dep.createdBy?.fullName ||
            dep.createdBy?.name ||
            dep.createdBy?.email ||
            "Staff",
          fromAccountType: "CASH",
          fromAccountName: "External Cash",
          toAccountType: "CASH",
          toAccountName: "Branch Cash Drawer",
          shiftId,
          shiftName,
          source: "shift_manual_deposit",
        });
        totalDeposits += Number(dep.amount) || 0;
      }
    }

    if (Array.isArray(s.manualWithdrawals)) {
      for (const w of s.manualWithdrawals) {
        withdrawals.push({
          _id: w._id,
          transferNumber: `WDL-${String(w._id).slice(-6).toUpperCase()}`,
          referenceNo: `WDL-${String(w._id).slice(-6).toUpperCase()}`,
          amount: Number(w.amount) || 0,
          narration: w.narration || "Manual cash withdrawal",
          transferDate: w.date || s.openedAt,
          createdBy:
            w.createdBy?.fullName ||
            w.createdBy?.name ||
            w.createdBy?.email ||
            "Staff",
          fromAccountType: "CASH",
          fromAccountName: w.source === "running" ? "Running Drawer" : "Frozen Reserve",
          toAccountType: "CASH",
          toAccountName: "External",
          shiftId,
          shiftName,
          source: w.source || "shift_manual_withdrawal",
        });
        totalWithdrawals += Number(w.amount) || 0;
      }
    }
  }

  // 2. Query any posted FundTransfer records
  const orConditions = [];
  if (shiftIds.length > 0) orConditions.push({ shiftId: { $in: shiftIds } });
  if (businessDayId) orConditions.push({ businessDayId });

  if (orConditions.length > 0) {
    const fundTransfers = await FundTransfer.find({
      $or: orConditions,
      status: FUND_TRANSFER_STATUS.POSTED,
      isDeleted: false,
    })
      .populate("fromBankAccountId", "accountName")
      .populate("toBankAccountId", "accountName")
      .populate("createdBy", "fullName name email");

    for (const ft of fundTransfers) {
      const ftData = {
        _id: ft._id,
        transferNumber: ft.transferNumber,
        referenceNo: ft.transferNumber,
        amount: Number(ft.amount) || 0,
        narration: ft.narration,
        transferDate: ft.transferDate,
        createdBy: ft.createdBy?.fullName || ft.createdBy?.name || "System",
        shiftId: ft.shiftId || null,
        source: "fund_transfer",
      };

      if (ft.fromAccountType === "CASH") {
        withdrawals.push({
          ...ftData,
          fromAccountType: ft.fromAccountType,
          fromAccountName: "Branch Cash Drawer",
          toAccountType: ft.toAccountType,
          toAccountName:
            ft.toCashAccountId?.accountName ||
            ft.toBankAccountId?.accountName ||
            "External",
        });
        totalWithdrawals += Number(ft.amount) || 0;
      } else if (ft.toAccountType === "CASH") {
        deposits.push({
          ...ftData,
          fromAccountType: ft.fromAccountType,
          fromAccountName:
            ft.fromCashAccountId?.accountName ||
            ft.fromBankAccountId?.accountName ||
            "External",
          toAccountType: ft.toAccountType,
          toAccountName: "Branch Cash Drawer",
        });
        totalDeposits += Number(ft.amount) || 0;
      }
    }
  }

  return { withdrawals, deposits, totalWithdrawals, totalDeposits };
};

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * POST /operations/business-days
 * Opens a new Business Day.
 */
export const openBusinessDay = asyncHandler(async (req, res, next) => {
  const branchId = req.headers["x-branch-id"] || req.branchId || req.body.branchId || null;
  if (!branchId) return next(new ApiError(400, "Branch ID is missing"));

  const clientDate = req.body.clientDate || req.query.clientDate || req.headers["x-client-date"] || null;
  const payload = {
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    branchId,
    businessDate: req.body.businessDate || req.body.date || clientDate || new Date(),
    clientDate,
    createdBy: req.user?._id,
    note: req.body.note,
  };

  const businessDay = await openBusinessDayService(payload);
  await businessDay.populate([
    { path: "createdBy", select: "fullName name email role" },
    { path: "branchId", select: "name branchCode branchName" },
  ]);
  res.status(201).json({ success: true, data: businessDay });
});

/**
 * GET /operations/business-days
 * Lists all Business Days with optional filters.
 */
export const listBusinessDays = asyncHandler(async (req, res, next) => {
  const branchId = req.headers["x-branch-id"] || req.branchId || req.query.branchId || null;
  const { date, status, sort = "desc" } = req.query;

  const filter = {
    workspaceId: req.workspaceId,
    companyId: req.companyId,
  };

  if (branchId) filter.branchId = branchId;
  if (date) {
    const d = new Date(date);
    const canonical = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    filter.businessDate = canonical;
  }
  if (status && status !== "all") filter.status = status;

  const sortOrder = sort === "asc" ? 1 : -1;
  const businessDays = await BusinessDay.find(filter)
    .sort({ businessDate: sortOrder })
    .populate("shifts")
    .populate("createdBy", "fullName name email role")
    .populate("closedBy", "fullName name email role")
    .populate("branchId", "name branchCode branchName");

  res.status(200).json({ success: true, data: businessDays });
});

/**
 * GET /operations/business-days/open
 * Returns the currently OPEN Business Day for a branch, or 404.
 * Used by the frontend persistent status banner.
 */
export const getOpenBusinessDay = asyncHandler(async (req, res, next) => {
  const branchId = req.headers["x-branch-id"] || req.branchId || req.query.branchId || null;
  if (!branchId) return next(new ApiError(400, "Branch ID is required"));

  const businessDay = await getOpenBusinessDayService(branchId);
  if (!businessDay) return next(new ApiError(404, "No open Business Day found for this branch"));

  await businessDay.populate([
    { path: "shifts" },
    { path: "createdBy", select: "fullName name email role" },
    { path: "closedBy", select: "fullName name email role" },
    { path: "branchId", select: "name branchCode branchName" },
  ]);

  // Also fetch the currently open shift (if any) to include in response
  const openShift = await Shift.findOne({ businessDayId: businessDay._id, status: "open" });

  res.status(200).json({
    success: true,
    data: { ...businessDay.toObject(), currentOpenShift: openShift || null },
  });
});

/**
 * GET /operations/business-days/suggested-date
 * Returns the suggested businessDate for the next Business Day opening.
 */
export const getSuggestedBusinessDate = asyncHandler(async (req, res, next) => {
  const branchId = req.headers["x-branch-id"] || req.branchId || req.query.branchId || null;
  if (!branchId) return next(new ApiError(400, "Branch ID is required"));

  const clientDate = req.query.clientDate || req.headers["x-client-date"] || null;
  const suggestion = await getSuggestedBusinessDateService(branchId, clientDate);
  res.status(200).json({ success: true, data: suggestion });
});

/**
 * GET /operations/business-days/:id
 * Returns a single Business Day by ID.
 */
export const getBusinessDayById = asyncHandler(async (req, res, next) => {
  const businessDay = await BusinessDay.findById(req.params.id)
    .populate({
      path: "shifts",
      populate: [
        { path: "openedBy", select: "fullName name email role" },
        { path: "closedBy", select: "fullName name email role" },
        { path: "manualDeposits.createdBy", select: "fullName name email role" },
        { path: "manualWithdrawals.createdBy", select: "fullName name email role" },
      ],
    })
    .populate("createdBy", "fullName name email role")
    .populate("closedBy", "fullName name email role")
    .populate("branchId", "name branchCode branchName");
  if (!businessDay) return next(new ApiError(404, "Business Day not found"));
  res.status(200).json({ success: true, data: businessDay });
});

/**
 * GET /operations/business-days/:id/summary
 * Returns a Business Day with full shift-level financial summary.
 */
export const getBusinessDaySummary = asyncHandler(async (req, res, next) => {
  const businessDay = await BusinessDay.findById(req.params.id)
    .populate({
      path: "shifts",
      populate: [
        { path: "openedBy", select: "fullName name email role" },
        { path: "closedBy", select: "fullName name email role" },
        { path: "manualDeposits.createdBy", select: "fullName name email role" },
        { path: "manualWithdrawals.createdBy", select: "fullName name email role" },
      ],
    })
    .populate("createdBy", "fullName name email role")
    .populate("closedBy", "fullName name email role")
    .populate("branchId", "name branchCode branchName");
  if (!businessDay) return next(new ApiError(404, "Business Day not found"));

  // Defensively fetch all shifts linked to this Business Day
  const linkedShifts = await Shift.find({
    $or: [
      { businessDayId: businessDay._id },
      { _id: { $in: (businessDay.shifts || []).map((s) => s._id || s) } },
    ],
  })
    .populate("openedBy", "fullName name email role")
    .populate("closedBy", "fullName name email role")
    .populate("manualDeposits.createdBy", "fullName name email role")
    .populate("manualWithdrawals.createdBy", "fullName name email role");

  const shiftMap = new Map();
  (businessDay.shifts || []).forEach((s) => {
    if (s && s._id) shiftMap.set(String(s._id), s);
  });
  linkedShifts.forEach((s) => {
    if (s && s._id) shiftMap.set(String(s._id), s);
  });
  const allShifts = Array.from(shiftMap.values());

  const shiftSummaries = await Promise.all(allShifts.map(calculateShiftSummary));

  let totalInvoiceCount = 0;
  let totalCashInvoiceCount = 0;
  let totalPaymentQrCount = 0;
  let totalNetSales = 0;
  let totalCashNet = 0;
  let totalQrNet = 0;
  const upiBreakdownRaw = {};

  shiftSummaries.forEach((s) => {
    totalInvoiceCount += s.invoiceCount;
    totalCashInvoiceCount += s.cashInvoiceCount;
    totalPaymentQrCount += s.paymentQrCount;
    totalNetSales += s.netSales;
    totalCashNet += s.cashNet;
    totalQrNet += s.qrNet;

    if (s.upiBreakdown && Array.isArray(s.upiBreakdown)) {
      s.upiBreakdown.forEach((upi) => {
        const key = upi.paymentQrId || "unattributed";
        if (!upiBreakdownRaw[key]) {
          upiBreakdownRaw[key] = { ...upi, transactionCount: 0, totalAmount: 0 };
        }
        upiBreakdownRaw[key].transactionCount += upi.transactionCount;
        upiBreakdownRaw[key].totalAmount += upi.totalAmount;
      });
    }
  });

  const upiBreakdown = Object.values(upiBreakdownRaw);
  const shiftIds = allShifts.map((s) => s._id);
  const ftData = await fetchFundTransfers({
    shifts: allShifts,
    shiftIds,
    businessDayId: businessDay._id,
  });

  const branchId = businessDay.branchId?._id || businessDay.branchId;
  const startOfDay = new Date(businessDay.businessDate);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(businessDay.businessDate);
  endOfDay.setUTCHours(23, 59, 59, 999);

  const bankSlipConditions = [{ businessDayId: businessDay._id }];
  if (branchId) {
    bankSlipConditions.push({
      branchId,
      slipDate: {
        $gte: new Date(startOfDay.getTime() - 24 * 60 * 60 * 1000),
        $lte: new Date(endOfDay.getTime() + 24 * 60 * 60 * 1000),
      },
    });
    if (businessDay.actualOpenedAt) {
      bankSlipConditions.push({
        branchId,
        createdAt: {
          $gte: new Date(new Date(businessDay.actualOpenedAt).getTime() - 2 * 60 * 60 * 1000),
          $lte: businessDay.actualClosedAt
            ? new Date(new Date(businessDay.actualClosedAt).getTime() + 2 * 60 * 60 * 1000)
            : new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    }
  }

  const bankSlips = await BankDepositSlip.find({
    $or: bankSlipConditions,
    isDeleted: false,
    status: { $ne: "cancelled" },
  })
    .populate("toBankAccountId", "accountName accountNumber bankName")
    .populate("createdBy", "fullName name email role")
    .sort({ createdAt: -1 })
    .lean();

  const totalBankSlipsAmount = bankSlips.reduce(
    (sum, b) => sum + (Number(b.amount) || 0),
    0
  );

  // Retrieve current branch cash balances
  let branchCash = null;
  if (branchId) {
    try {
      const { default: branchCashService } = await import(
        "../../finance/treasury/cash-management/branch-cash/services/branchCash.service.js"
      );
      branchCash = await branchCashService.getByBranchId(branchId, req.companyId);
    } catch (bcErr) {
      console.warn("[getBusinessDaySummary] Error fetching branchCash:", bcErr.message);
    }
  }

  const totalFundWithdrawals =
    ftData.totalWithdrawals || businessDay.totalFundWithdrawals || 0;
  const totalFundDeposits =
    ftData.totalDeposits || businessDay.totalFundDeposits || 0;

  let openingFloatAmount = businessDay.openingFloatAmount || 0;
  let expectedClosingCashAmount = businessDay.expectedClosingCashAmount || 0;
  let openingDenominations = businessDay.openingDenominations || [];

  if (businessDay.status === "open" && shiftSummaries.length > 0) {
    openingFloatAmount = shiftSummaries[0].openingFloatAmount || 0;
    openingDenominations = shiftSummaries[0].openingDenominations || [];
    expectedClosingCashAmount =
      openingFloatAmount + totalCashNet + totalFundDeposits - totalFundWithdrawals;
  }

  const branchDoc = businessDay.branchId;
  const branchName =
    branchDoc?.name || branchDoc?.branchName || branchDoc?.displayName || null;
  const branchCode = branchDoc?.branchCode || null;

  const summary = {
    ...businessDay.toObject(),
    shifts: allShifts,
    branchName,
    branchCode,
    branch: branchDoc,
    branchCash,
    shiftSummaries,
    totalInvoiceCount,
    totalCashInvoiceCount,
    totalPaymentQrCount,
    totalNetSales,
    totalCashNet,
    totalQrNet,
    upiBreakdown,
    withdrawals: ftData.withdrawals,
    deposits: ftData.deposits,
    totalWithdrawals: totalFundWithdrawals,
    totalDeposits: totalFundDeposits,
    openingFloatAmount,
    expectedClosingCashAmount,
    openingDenominations,
    closingDenominations: businessDay.closingDenominations || [],
    bankSlips,
    totalBankSlipsAmount,
    bankSlipsCount: bankSlips.length,
  };

  res.status(200).json({ success: true, data: summary });
});

/**
 * PATCH /operations/business-days/:id/close
 * Closes an open Business Day and aggregates all financial data.
 */
export const closeBusinessDay = asyncHandler(async (req, res, next) => {
  const { actualClosingCashAmount, closingDenominations, note } = req.body;
  const userId = req.user?._id;

  const businessDay = await closeBusinessDayService(req.params.id, userId, {
    actualClosingCashAmount,
    closingDenominations,
    note,
  });

  if (businessDay) {
    await businessDay.populate([
      { path: "createdBy", select: "fullName name email role" },
      { path: "closedBy", select: "fullName name email role" },
      { path: "branchId", select: "name branchCode branchName" },
    ]);
  }

  res.status(200).json({ success: true, data: businessDay });
});

/**
 * PATCH /operations/business-days/:id/cancel
 * Cancels an open Business Day.
 */
export const cancelBusinessDay = asyncHandler(async (req, res, next) => {
  const { note } = req.body;
  const userId = req.user?._id;
  const businessDay = await cancelBusinessDayService(req.params.id, userId, note);
  res.status(200).json({ success: true, data: businessDay });
});
