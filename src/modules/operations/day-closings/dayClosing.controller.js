import asyncHandler from "../../../utils/asyncHandler.js";
import ApiError from "../../../utils/ApiError.js";
import { DayClosing } from "./dayClosing.model.js";
import { Shift } from "../shifts/shift.model.js";
import SalesInvoice from "../../sales/invoices/models/invoice.model.js";
import SalesReturn from "../../sales/returns/models/salesReturn.model.js";
import FundTransfer from "../../finance/treasury/fund-transfers/models/fundTransfer.model.js";
import { FUND_TRANSFER_STATUS } from "../../finance/treasury/fund-transfers/constants/fundTransfer.constant.js";
import PaymentQr from "../../finance/treasury/payment-qr/models/paymentQr.model.js";
import { createDayClosing as createDayClosingService, closeDayClosing, cancelDayClosing as cancelDayClosingService } from "./dayClosing.service.js";
import { getBusinessDateRange } from "../../../utils/businessDate.js";

// Helper function to calculate shift summary
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

  // Per-UPI breakdown: { [paymentQrId]: { transactionCount, totalAmount } }
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
          } else if (pType.includes("CASH")) {
            cashNet -= amt;
          }
        }
      } else if (pMethod.includes("UPI") || pMethod.includes("QR")) {
        qrNet -= billTotal;
      } else if (pMethod.includes("CASH") || retType === "cash_refund") {
        cashNet -= billTotal;
      }
      continue;
    }

    invoiceCount++;
    netSales += inv.grandTotal;

    if (inv.paymentMethod === "Split" && Array.isArray(inv.payments)) {
      let hasUpi = false;
      let hasCash = false;
      for (const p of inv.payments) {
        const pType = p.paymentType ? p.paymentType.toUpperCase() : "CASH";
        if (pType.includes("UPI") || pType.includes("QR")) {
          hasUpi = true;
          qrNet += (p.amount || 0);
          _trackUpi(p.paymentQrId, p.amount || 0);
        } else if (pType.includes("CASH")) {
          hasCash = true;
          cashNet += (p.amount || 0);
        } else if (!pType.includes("CARD") && !pType.includes("WALLET") && !pType.includes("CREDIT")) {
          hasCash = true;
          cashNet += (p.amount || 0);
        }
      }
      // Note: split invoices have their own separate tracking and should not inflate pure cash/UPI counts
    } else {
      const pMethod = inv.paymentMethod ? inv.paymentMethod.toUpperCase() : "CASH";
      if (pMethod.includes("UPI") || pMethod.includes("QR")) {
        paymentQrCount++;
        qrNet += inv.grandTotal;
        _trackUpi(inv.paymentQrId, inv.grandTotal);
      } else if (pMethod.includes("CASH")) {
        cashInvoiceCount++;
        cashNet += (inv.cashTendered - inv.changeDue > 0) ? (inv.cashTendered - inv.changeDue) : inv.grandTotal;
      } else {
        cashInvoiceCount++;
        cashNet += inv.grandTotal;
      }
    }
  }

  // Enrich upiBreakdown with PaymentQr metadata (upiId, label, provider)
  const qrIds = Object.keys(upiBreakdownRaw).filter(k => k !== "unattributed");
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

  const expectedClosingCashAmount = shift.expectedClosingCashAmount !== undefined && shift.status === "closed"
    ? shift.expectedClosingCashAmount
    : (shift.openingFloatAmount || 0) + cashNet - (shift.totalFundWithdrawals || 0) + (shift.totalFundDeposits || 0);

  return {
    ...shift.toObject(),
    invoiceCount,
    cashInvoiceCount,
    paymentQrCount,
    netSales,
    cashNet,
    qrNet,
    upiBreakdown,
    expectedClosingCashAmount,
    cancelledInvoiceCount: shift.cancelledInvoiceCount || 0,
    cancelledSalesTotal: shift.cancelledSalesTotal || 0,
  };
};

const fetchFundTransfers = async ({ shiftIds = [], dayClosingId = null, cashAccountId = null }) => {
  const orConditions = [];
  if (shiftIds.length > 0) orConditions.push({ shiftId: { $in: shiftIds } });
  if (dayClosingId) orConditions.push({ dayClosingId });

  if (orConditions.length === 0) {
    return { withdrawals: [], deposits: [], totalWithdrawals: 0, totalDeposits: 0 };
  }

  const fundTransfers = await FundTransfer.find({
    $or: orConditions,
    status: FUND_TRANSFER_STATUS.POSTED,
    isDeleted: false,
  })
    .populate("fromCashAccountId", "accountName")
    .populate("toCashAccountId",   "accountName")
    .populate("fromBankAccountId", "accountName")
    .populate("toBankAccountId",   "accountName")
    .populate("createdBy",         "fullName");

  const withdrawals = [];
  const deposits = [];
  let totalWithdrawals = 0;
  let totalDeposits = 0;

  const targetCaId = null;

  for (const ft of fundTransfers) {
    const fromId = ft.fromCashAccountId ? String(ft.fromCashAccountId._id || ft.fromCashAccountId) : null;
    const toId   = ft.toCashAccountId   ? String(ft.toCashAccountId._id   || ft.toCashAccountId)   : null;

    const ftData = {
      _id:            ft._id,
      transferNumber: ft.transferNumber,
      amount:         ft.amount,
      narration:      ft.narration,
      transferDate:   ft.transferDate,
      createdBy:      ft.createdBy?.fullName || "System",
    };

    if (targetCaId) {
      if (fromId === targetCaId) {
        withdrawals.push({
          ...ftData,
          toAccountType: ft.toAccountType,
          toAccountName: ft.toCashAccountId?.accountName || ft.toBankAccountId?.accountName || "External",
        });
        totalWithdrawals += ft.amount;
      } else if (toId === targetCaId) {
        deposits.push({
          ...ftData,
          fromAccountType: ft.fromAccountType,
          fromAccountName: ft.fromCashAccountId?.accountName || ft.fromBankAccountId?.accountName || "External",
        });
        totalDeposits += ft.amount;
      }
    } else {
      if (ft.fromAccountType === "CASH") {
        withdrawals.push({
          ...ftData,
          toAccountType: ft.toAccountType,
          toAccountName: ft.toCashAccountId?.accountName || ft.toBankAccountId?.accountName || "External",
        });
        totalWithdrawals += ft.amount;
      } else if (ft.toAccountType === "CASH") {
        deposits.push({
          ...ftData,
          fromAccountType: ft.fromAccountType,
          fromAccountName: ft.fromCashAccountId?.accountName || ft.fromBankAccountId?.accountName || "External",
        });
        totalDeposits += ft.amount;
      }
    }
  }

  return { withdrawals, deposits, totalWithdrawals, totalDeposits };
};

export const getDraftDayClosingSummary = asyncHandler(async (req, res, next) => {
  const branchId = req.headers["x-branch-id"] || req.branchId || req.query.branchId || null;
  const { date } = req.query; // format YYYY-MM-DD
  
  if (!branchId) return next(new ApiError(400, "Branch ID required"));
  if (!date) return next(new ApiError(400, "Date is required"));

  const { dateFilter, dateStr } = getBusinessDateRange(date);

  // Check if a draft or closed day closing already exists for this date
  const existingDayClosing = await DayClosing.findOne({ branchId, date: dateFilter, status: { $ne: "cancelled" } });
  if (existingDayClosing) {
    return next(new ApiError(400, `A Day Closing already exists for ${date}.`));
  }

  // Check if there are any OPEN shifts for this branch on this date
  const openShiftsCount = await Shift.countDocuments({ branchId, date: dateFilter, status: "open" });
  if (openShiftsCount > 0) {
    return next(new ApiError(400, "One or more shifts are still open for this date. For day closing, all shifts must be closed."));
  }

  // Find all closed shifts for this date
  const shifts = await Shift.find({ branchId, date: dateFilter, status: "closed" }).sort({ openedAt: 1 });
  
  if (shifts.length === 0) {
    return res.status(200).json({ success: true, data: { shifts: [], message: `No closed shifts found for ${date}.` } });
  }

  const shiftSummaries = await Promise.all(shifts.map(calculateShiftSummary));

  let totalInvoiceCount = 0;
  let totalCashInvoiceCount = 0;
  let totalPaymentQrCount = 0;
  let totalNetSales = 0;
  let totalCashNet = 0;
  let totalQrNet = 0;
  let totalExpected = 0;
  let totalActual = 0;
  let totalOpening = 0;
  let openingDenominations = [];
  let closingDenominations = [];
  let upiBreakdownRaw = {};

  shiftSummaries.forEach(s => {
    totalInvoiceCount += s.invoiceCount;
    totalCashInvoiceCount += s.cashInvoiceCount;
    totalPaymentQrCount += s.paymentQrCount;
    totalNetSales += s.netSales;
    totalCashNet += s.cashNet;
    totalQrNet += s.qrNet;

    // Aggregate UPI breakdowns
    if (s.upiBreakdown && Array.isArray(s.upiBreakdown)) {
      s.upiBreakdown.forEach(upi => {
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

  if (shiftSummaries.length > 0) {
    const firstShift = shiftSummaries[0];
    const lastShift = shiftSummaries[shiftSummaries.length - 1];
    
    totalOpening = firstShift.openingFloatAmount || 0;
    openingDenominations = firstShift.openingDenominations || [];
    totalExpected = lastShift.expectedClosingCashAmount || 0;
    totalActual = lastShift.actualClosingCashAmount || 0;
    closingDenominations = lastShift.closingDenominations || [];
  }

  // Fetch fund transfers for these shifts
  const shiftIds = shifts.map(s => s._id);
  const ftData = await fetchFundTransfers({ shiftIds });

  const summary = {
    date,
    branchId,
    status: "preview",
    shifts: shiftSummaries,
    totalInvoiceCount,
    totalCashInvoiceCount,
    totalPaymentQrCount,
    totalNetSales,
    totalCashNet,
    totalQrNet,
    upiBreakdown,
    totalExpected,
    totalActual,
    totalOpening,
    openingDenominations,
    closingDenominations,
    withdrawals: ftData.withdrawals,
    deposits: ftData.deposits,
    totalWithdrawals: ftData.totalWithdrawals,
    totalDeposits: ftData.totalDeposits,
    cashDifferenceAmount: totalActual - totalExpected,
  };

  res.status(200).json({ success: true, data: summary });
});

export const getDayClosingSummary = asyncHandler(async (req, res, next) => {
  const dayClosing = await DayClosing.findById(req.params.id).populate("shifts");
  if (!dayClosing) return next(new ApiError(404, "Day Closing not found"));

  const shiftSummaries = await Promise.all(dayClosing.shifts.map(calculateShiftSummary));

  let totalInvoiceCount = 0;
  let totalCashInvoiceCount = 0;
  let totalPaymentQrCount = 0;
  let totalNetSales = 0;
  let totalCashNet = 0;
  let totalQrNet = 0;

  let upiBreakdownRaw = {};

  shiftSummaries.forEach(s => {
    totalInvoiceCount += s.invoiceCount;
    totalCashInvoiceCount += s.cashInvoiceCount;
    totalPaymentQrCount += s.paymentQrCount;
    totalNetSales += s.netSales;
    totalCashNet += s.cashNet;
    totalQrNet += s.qrNet;

    // Aggregate UPI breakdowns
    if (s.upiBreakdown && Array.isArray(s.upiBreakdown)) {
      s.upiBreakdown.forEach(upi => {
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

  // Query fund transfers linked to this day closing and its shifts
  const shiftIds = (dayClosing.shifts || []).map(s => s._id);
  const ftData = await fetchFundTransfers({
    shiftIds,
    dayClosingId: dayClosing._id,
    cashDifferenceAmount: dayClosing.cashDifferenceAmount,
  });

  const summary = {
    ...dayClosing.toObject(),
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
    totalWithdrawals: dayClosing.totalFundWithdrawals || ftData.totalWithdrawals,
    totalDeposits: dayClosing.totalFundDeposits || ftData.totalDeposits,
    openingDenominations: dayClosing.openingDenominations || [],
    closingDenominations: dayClosing.closingDenominations || [],
  };

  res.status(200).json({ success: true, data: summary });
});

export const createDayClosing = asyncHandler(async (req, res, next) => {
  const branchId = req.headers["x-branch-id"] || req.branchId || req.query.branchId || req.body.branchId || null;
  
  if (!branchId) return next(new ApiError(400, "Branch ID is missing in context"));

  // Handle date selection: default today, optionally any specified date
  const { canonicalDate } = getBusinessDateRange(req.body.date);

  const payload = {
    ...req.body,
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    branchId,
    createdBy: req.user?._id,
    date: canonicalDate,
    dayClosingNo: `DC-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 100)}`
  };

  const dayClosing = await createDayClosingService(payload);
  res.status(201).json({ success: true, data: dayClosing });
});

export const listDayClosings = asyncHandler(async (req, res, next) => {
  const branchId = req.headers["x-branch-id"] || req.branchId || req.query.branchId || null;
  const { date, status, sort = "desc" } = req.query;
  
  const filter = {
    workspaceId: req.workspaceId,
    companyId: req.companyId,
  };
  
  if (branchId) filter.branchId = branchId;
  if (date) {
    const { dateFilter } = getBusinessDateRange(date);
    filter.date = dateFilter;
  }
  if (status && status !== "all") filter.status = status;

  const sortOrder = sort === "asc" ? 1 : -1;
  const dayClosings = await DayClosing.find(filter)
    .sort({ createdAt: sortOrder })
    .populate("shifts")
    .populate("createdBy", "fullName email")
    .populate("approvedBy", "fullName email");
    
  res.status(200).json({ success: true, data: dayClosings });
});

export const getDayClosingById = asyncHandler(async (req, res, next) => {
  const dayClosing = await DayClosing.findById(req.params.id).populate("shifts");
  if (!dayClosing) return next(new ApiError(404, "Day Closing not found"));
  res.status(200).json({ success: true, data: dayClosing });
});

export const updateDayClosing = asyncHandler(async (req, res, next) => {
  const dayClosing = await DayClosing.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!dayClosing) return next(new ApiError(404, "Day Closing not found"));
  res.status(200).json({ success: true, data: dayClosing });
});

export const updateDayClosingStatus = asyncHandler(async (req, res, next) => {
  const { status, actualClosingCashAmount, closingDenominations, note } = req.body;
  const userId = req.user?._id;
  
  if (status === "closed") {
    const dayClosing = await closeDayClosing(req.params.id, userId, actualClosingCashAmount, closingDenominations, note);
    return res.status(200).json({ success: true, data: dayClosing });
  }

  const dayClosing = await DayClosing.findByIdAndUpdate(req.params.id, { status, note }, { new: true });
  res.status(200).json({ success: true, data: dayClosing });
});

export const cancelDayClosing = asyncHandler(async (req, res, next) => {
  const { note } = req.body;
  const userId = req.user?._id;
  const dayClosing = await cancelDayClosingService(req.params.id, userId, note);
  res.status(200).json({ success: true, data: dayClosing });
});

export const syncDayClosingController = asyncHandler(async (req, res, next) => {
  res.status(200).json({ success: true, message: "Sync not implemented in this version" });
});
