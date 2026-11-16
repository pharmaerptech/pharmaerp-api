import mongoose from "mongoose";
import SalesInvoice from "../../../../sales/invoices/models/invoice.model.js";
import PaymentQr from "../models/paymentQr.model.js";
import CustomerCreditTransaction from "../../../../parties/customers/models/customerCreditTransaction.model.js";
import CustomerAdvanceTransaction from "../../../../parties/customers/models/customerAdvanceTransaction.model.js";
import ApiError from "../../../../../utils/ApiError.js";

/**
 * Aggregates transaction statistics for a specific PaymentQr (UPI VPA).
 *
 * Handles two cases:
 * 1. Single-method UPI invoices where SalesInvoice.paymentQrId === id
 * 2. Split-payment invoices where any payments[].paymentQrId === id
 *    (uses the sub-payment amount, not the full invoice grandTotal)
 *
 * Returns:
 *   { totalTransactions, totalAmount, todayAmount, thisMonthAmount, recentTransactions }
 */
const getPaymentQrStats = async (paymentQrId, companyId, workspaceId, query = {}) => {
  if (!mongoose.Types.ObjectId.isValid(paymentQrId)) {
    throw new ApiError(400, "Invalid Payment QR ID");
  }

  const qrObjId = new mongoose.Types.ObjectId(paymentQrId);

  // Verify the QR belongs to this company/workspace
  const qr = await PaymentQr.findOne({
    _id: qrObjId,
    companyId,
    workspaceId,
    isDeleted: false,
  }).lean();

  if (!qr) throw new ApiError(404, "Payment QR not found");

  // Date helpers
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  // Optional date range filter from query
  const dateFrom = query.dateFrom ? new Date(query.dateFrom) : null;
  const dateTo = query.dateTo ? new Date(query.dateTo) : null;

  // -----------------------------------------------------------------------
  // Pipeline 1: Single-method UPI invoices  (paymentQrId at top level)
  // -----------------------------------------------------------------------
  // Pipeline 1: Single-method UPI invoices  (paymentQrId at top level)
  // -----------------------------------------------------------------------
  const singleMethodMatch = {
    companyId: new mongoose.Types.ObjectId(companyId),
    paymentQrId: qrObjId,
    isDeleted: false,
    status: { $ne: "Cancelled" },
  };
  if (dateFrom || dateTo) {
    const dateRange = {};
    if (dateFrom) dateRange.$gte = dateFrom;
    if (dateTo) dateRange.$lte = dateTo;
    singleMethodMatch.$or = [
      { createdAt: dateRange },
      { createdAt: { $exists: false }, date: dateRange },
    ];
  }

  // -----------------------------------------------------------------------
  // Pipeline 2: Split-payment invoices  (paymentQrId inside payments[])
  // -----------------------------------------------------------------------
  const splitMethodMatch = {
    companyId: new mongoose.Types.ObjectId(companyId),
    "payments.paymentQrId": qrObjId,
    isDeleted: false,
    status: { $ne: "Cancelled" },
  };
  if (dateFrom || dateTo) {
    const dateRange = {};
    if (dateFrom) dateRange.$gte = dateFrom;
    if (dateTo) dateRange.$lte = dateTo;
    splitMethodMatch.$or = [
      { createdAt: dateRange },
      { createdAt: { $exists: false }, date: dateRange },
    ];
  }

  const todayDateMatch = {
    $or: [
      { createdAt: { $gte: todayStart, $lte: todayEnd } },
      { createdAt: { $exists: false }, date: { $gte: todayStart, $lte: todayEnd } },
    ],
  };

  const monthDateMatch = {
    $or: [
      { createdAt: { $gte: monthStart, $lte: monthEnd } },
      { createdAt: { $exists: false }, date: { $gte: monthStart, $lte: monthEnd } },
    ],
  };

  // Run all aggregations in parallel for speed
  const [
    singleAll,
    singleToday,
    singleMonth,
    splitAll,
    splitToday,
    splitMonth,
    recentSingle,
    recentSplit,
  ] = await Promise.all([
    // --- ALL TIME ---
    SalesInvoice.aggregate([
      { $match: singleMethodMatch },
      { $group: { _id: null, total: { $sum: "$grandTotal" }, count: { $sum: 1 } } },
    ]),
    SalesInvoice.aggregate([
      { $match: { ...singleMethodMatch, ...todayDateMatch } },
      { $group: { _id: null, total: { $sum: "$grandTotal" }, count: { $sum: 1 } } },
    ]),
    SalesInvoice.aggregate([
      { $match: { ...singleMethodMatch, ...monthDateMatch } },
      { $group: { _id: null, total: { $sum: "$grandTotal" }, count: { $sum: 1 } } },
    ]),

    // --- SPLIT PAYMENTS (use individual sub-payment amount) ---
    SalesInvoice.aggregate([
      { $match: splitMethodMatch },
      { $unwind: "$payments" },
      {
        $match: {
          "payments.paymentQrId": qrObjId,
          "payments.amount": { $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$payments.amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    SalesInvoice.aggregate([
      { $match: { ...splitMethodMatch, ...todayDateMatch } },
      { $unwind: "$payments" },
      { $match: { "payments.paymentQrId": qrObjId, "payments.amount": { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$payments.amount" }, count: { $sum: 1 } } },
    ]),
    SalesInvoice.aggregate([
      { $match: { ...splitMethodMatch, ...monthDateMatch } },
      { $unwind: "$payments" },
      { $match: { "payments.paymentQrId": qrObjId, "payments.amount": { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$payments.amount" }, count: { $sum: 1 } } },
    ]),

    // --- RECENT TRANSACTIONS (last 15, single-method) ---
    SalesInvoice.find(singleMethodMatch)
      .sort({ createdAt: -1 })
      .limit(15)
      .select("invoiceNo date createdAt grandTotal paymentMethod customerId status")
      .populate({ path: "customerId", select: "name mobile" })
      .lean(),

    // --- RECENT TRANSACTIONS (last 15, split-method) ---
    SalesInvoice.aggregate([
      { $match: splitMethodMatch },
      { $unwind: "$payments" },
      { $match: { "payments.paymentQrId": qrObjId, "payments.amount": { $gt: 0 } } },
      { $sort: { createdAt: -1 } },
      { $limit: 15 },
      {
        $project: {
          invoiceNo: 1,
          date: 1,
          createdAt: 1,
          grandTotal: "$payments.amount",
          paymentMethod: 1,
          customerId: 1,
          status: 1,
          isSplit: { $literal: true },
        },
      },
    ]),
  ]);

  // Merge single + split totals
  const allTotal   = (singleAll[0]?.total   || 0) + (splitAll[0]?.total   || 0);
  const allCount   = (singleAll[0]?.count   || 0) + (splitAll[0]?.count   || 0);
  const todayTotal = (singleToday[0]?.total || 0) + (splitToday[0]?.total || 0);
  const todayCount = (singleToday[0]?.count || 0) + (splitToday[0]?.count || 0);
  const monthTotal = (singleMonth[0]?.total || 0) + (splitMonth[0]?.total || 0);
  const monthCount = (singleMonth[0]?.count || 0) + (splitMonth[0]?.count || 0);

  // Merge + sort recent transactions (deduplicate by _id, prefer single-method entry)
  const recentMap = new Map();
  for (const inv of [...recentSingle, ...recentSplit]) {
    const key = String(inv._id);
    if (!recentMap.has(key)) recentMap.set(key, inv);
  }
  const recentTransactions = [...recentMap.values()]
    .sort((a, b) => new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date))
    .slice(0, 10)
    .map((inv) => ({
      _id: inv._id,
      invoiceNo: inv.invoiceNo,
      date: inv.createdAt || inv.date,
      amount: inv.grandTotal,
      paymentMethod: inv.paymentMethod,
      status: inv.status,
      customer: inv.customerId
        ? { name: inv.customerId.name || "Walk-in", mobile: inv.customerId.mobile }
        : { name: "Walk-in", mobile: null },
    }));

  return {
    upiId: qr.upiId,
    label: qr.label,
    provider: qr.provider,
    totalTransactions: allCount,
    totalAmount: allTotal,
    todayTransactions: todayCount,
    todayAmount: todayTotal,
    thisMonthTransactions: monthCount,
    thisMonthAmount: monthTotal,
    recentTransactions,
  };
};

/**
 * Resolves the actual physical creation timestamp of a transaction
 * (when the cashier actually punched/recorded the invoice, credit settlement, or advance receipt in the system),
 * eliminating discrepancies from overnight shifts or overridden business day dates.
 */
const resolveActualDate = (docOrSubdoc, fallbackDate) => {
  if (docOrSubdoc?.createdAt) {
    const d = new Date(docOrSubdoc.createdAt);
    if (!isNaN(d.getTime())) return d;
  }
  if (docOrSubdoc?._id) {
    try {
      const hex = String(docOrSubdoc._id).substring(0, 8);
      const ts = parseInt(hex, 16) * 1000;
      if (!isNaN(ts) && ts > 0) return new Date(ts);
    } catch {
      // fallback
    }
  }
  if (fallbackDate) {
    const d = new Date(fallbackDate);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
};

/**
 * Universal Multi-Source UPI Transactions Query & Reconciliation Engine.
 * Aggregates across:
 * 1. Sales Invoices (pure UPI and Split allocations)
 * 2. Customer Credit Settlements (settlement entries via UPI)
 * 3. Customer Advance Receipts (advance payments via UPI)
 *
 * Provides pagination-independent summary totals and unified chronological feed
 * strictly tracked by actual transaction execution timestamp.
 */
const getUpiTransactions = async (workspaceId, companyId, branchId, query = {}) => {
  if (!companyId) throw new ApiError(400, "Company ID is required");

  const compObjId = new mongoose.Types.ObjectId(companyId);
  const workObjId = workspaceId ? new mongoose.Types.ObjectId(workspaceId) : null;
  const branchObjId = branchId && branchId !== "all" ? new mongoose.Types.ObjectId(branchId) : null;
  const qrObjId = query.paymentQrId && mongoose.Types.ObjectId.isValid(query.paymentQrId)
    ? new mongoose.Types.ObjectId(query.paymentQrId)
    : null;

  const sourceType = String(query.sourceType || "all").toLowerCase();
  const search = String(query.search || "").trim().toLowerCase();
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 10));
  const sortBy = String(query.sortBy || "date").toLowerCase();
  const sortOrder = String(query.sortOrder || "desc").toLowerCase();

  // Date boundaries
  const dateFrom = query.startDate ? new Date(query.startDate) : null;
  const dateTo = query.endDate ? new Date(query.endDate) : null;

  // 1. Build fast Payment QR dictionary for rich lookup
  const qrFilter = { companyId: compObjId, isDeleted: false };
  if (branchObjId) qrFilter.branchId = branchObjId;
  const allQrs = await PaymentQr.find(qrFilter)
    .populate({
      path: "bankAccountId",
      select: "accountName accountNumber bankName bankMasterId ifscCode",
      populate: { path: "bankMasterId", select: "name code logo" },
    })
    .lean();

  const qrMap = new Map();
  for (const q of allQrs) {
    const b = q.bankAccountId || {};
    const bankTitle = b.bankMasterId?.name || b.bankName || "Corporate Bank";
    const maskedAcc = b.accountNumber ? `•••• ${String(b.accountNumber).slice(-4)}` : "";
    qrMap.set(String(q._id), {
      _id: q._id,
      upiId: q.upiId,
      label: q.label,
      provider: q.provider,
      branchId: q.branchId,
      bankAccount: {
        _id: b._id || null,
        accountName: b.accountName || bankTitle,
        bankName: bankTitle,
        accountNumber: maskedAcc,
      },
    });
  }

  const resolveQrInfo = (qrIdOrObj) => {
    if (!qrIdOrObj) return null;
    const key = typeof qrIdOrObj === "object" ? String(qrIdOrObj._id || qrIdOrObj) : String(qrIdOrObj);
    if (qrMap.has(key)) return qrMap.get(key);
    if (typeof qrIdOrObj === "object" && qrIdOrObj.upiId) {
      return {
        _id: qrIdOrObj._id,
        upiId: qrIdOrObj.upiId,
        label: qrIdOrObj.label || "",
        provider: qrIdOrObj.provider || "OTHER",
        bankAccount: null,
      };
    }
    return null;
  };

  const allRecords = [];

  // =========================================================================
  // SOURCE 1: Sales Invoices (Pure UPI + Split UPI allocations)
  // =========================================================================
  if (sourceType === "all" || sourceType === "invoice") {
    const invMatch = {
      companyId: compObjId,
      isDeleted: false,
      status: { $ne: "Cancelled" },
    };
    if (workObjId) invMatch.workspaceId = workObjId;
    if (branchObjId) invMatch.branchId = branchObjId;

    const andConditions = [];

    // Filter by actual transaction creation timestamp (falling back to date if legacy)
    if (dateFrom || dateTo) {
      const dateRange = {};
      if (dateFrom) dateRange.$gte = dateFrom;
      if (dateTo) dateRange.$lte = dateTo;

      andConditions.push({
        $or: [
          { createdAt: dateRange },
          { createdAt: { $exists: false }, date: dateRange },
        ],
      });
    }

    if (qrObjId) {
      andConditions.push({
        $or: [
          { paymentQrId: qrObjId },
          { "payments.paymentQrId": qrObjId },
        ],
      });
    } else {
      andConditions.push({
        $or: [
          { paymentMethod: { $regex: /^upi$/i } },
          { "payments.paymentType": { $regex: /upi|qr/i } },
          { "payments.paymentMode": { $regex: /upi|qr/i } },
          { "payments.type": { $regex: /upi|qr/i } },
          { paymentQrId: { $ne: null } },
        ],
      });
    }

    if (andConditions.length > 0) {
      invMatch.$and = andConditions;
    }

    const invoices = await SalesInvoice.find(invMatch)
      .select("invoiceNo date grandTotal subtotal tax discount paymentMethod paymentQrId payments customerId shiftId branchId status items createdByName createdByEmail createdAt updatedAt")
      .populate({ path: "customerId", select: "name mobile phone" })
      .populate({ path: "shiftId", select: "shiftNo shiftName openPeriod status" })
      .populate({ path: "branchId", select: "name branchCode" })
      .lean();

    for (const inv of invoices) {
      const pmUpper = String(inv.paymentMethod || "").toUpperCase();
      const isSplit = pmUpper === "SPLIT";
      const payments = Array.isArray(inv.payments) ? inv.payments : [];

      let upiPortion = 0;
      let matchedQrId = inv.paymentQrId;

      if (isSplit && payments.length > 0) {
        for (const p of payments) {
          const type = String(p.paymentType || p.paymentMode || p.type || p.mode || "").toUpperCase();
          const isUpiSub = type.includes("UPI") || type.includes("QR");
          if (!isUpiSub) continue;

          if (qrObjId) {
            const subQr = p.paymentQrId ? String(p.paymentQrId) : (inv.paymentQrId ? String(inv.paymentQrId) : null);
            if (subQr === String(qrObjId)) {
              upiPortion += Number(p.amount || 0);
              matchedQrId = p.paymentQrId || matchedQrId;
            }
          } else {
            upiPortion += Number(p.amount || 0);
            if (p.paymentQrId) matchedQrId = p.paymentQrId;
          }
        }
      } else if (pmUpper === "UPI") {
        if (!qrObjId || String(inv.paymentQrId) === String(qrObjId)) {
          upiPortion = Number(inv.grandTotal || 0);
        }
      } else if (payments.length > 0) {
        // Invoice with payments array tagged with UPI
        for (const p of payments) {
          const type = String(p.paymentType || p.paymentMode || p.type || p.mode || "").toUpperCase();
          if (type.includes("UPI") || type.includes("QR")) {
            if (!qrObjId || String(p.paymentQrId || inv.paymentQrId) === String(qrObjId)) {
              upiPortion += Number(p.amount || 0);
              if (p.paymentQrId) matchedQrId = p.paymentQrId;
            }
          }
        }
      }

      if (upiPortion > 0) {
        const actualDate = resolveActualDate(inv, inv.date);
        if (dateFrom && actualDate < dateFrom) continue;
        if (dateTo && actualDate > dateTo) continue;

        const cust = inv.customerId || {};
        const custPhone = cust.mobile || cust.phone || null;
        const shiftObj = inv.shiftId || {};
        const shiftTitle = shiftObj.shiftName || (shiftObj.shiftNo ? `Shift #${shiftObj.shiftNo}` : null);

        allRecords.push({
          id: `inv-${inv._id}`,
          rawId: inv._id,
          sourceType: "INVOICE",
          referenceNo: inv.invoiceNo,
          branchId: inv.branchId || null,
          date: actualDate, // Exact actual transaction timestamp with accurate date & time
          upiAmount: upiPortion,
          totalAmount: Number(inv.grandTotal || 0),
          isSplit,
          paymentQr: resolveQrInfo(matchedQrId),
          customer: {
            _id: cust._id || null,
            name: cust.name || "Walk-in Retail Customer",
            mobile: custPhone,
          },
          shift: {
            _id: shiftObj._id || null,
            shiftNo: shiftObj.shiftNo || null,
            shiftName: shiftTitle,
          },
          narration: `Retail Sale Invoice payment via UPI`,
          status: inv.status || "Paid",
          details: {
            billDate: inv.date, // Retained for display/audit
            itemsCount: (inv.items || []).length,
            items: inv.items || [],
            subtotal: inv.subtotal,
            tax: inv.tax,
            discount: inv.discount,
            payments: inv.payments || [],
            createdByName: inv.createdByName || (inv.createdByEmail ? inv.createdByEmail.split("@")[0] : "Cashier"),
          },
        });
      }
    }
  }

  // =========================================================================
  // SOURCE 2: Customer Credit Settlements
  // =========================================================================
  if (sourceType === "all" || sourceType === "credit_settlement") {
    const creditMatch = { companyId: compObjId };
    if (workObjId) creditMatch.workspaceId = workObjId;
    if (branchObjId) {
      creditMatch.$or = [{ branchId: branchObjId }, { branchId: null }];
    }

    const creditDocs = await CustomerCreditTransaction.find(creditMatch)
      .select("customerId invoiceNo invoiceAmount balanceDue settlements branchId")
      .populate({ path: "customerId", select: "name mobile phone" })
      .populate({ path: "settlements.shiftId", select: "shiftNo shiftName" })
      .populate({ path: "settlements.createdBy", select: "name email" })
      .populate({ path: "branchId", select: "name branchCode" })
      .lean();

    for (const doc of creditDocs) {
      const settlements = Array.isArray(doc.settlements) ? doc.settlements : [];
      for (const s of settlements) {
        if (String(s.paymentMethod || "").toUpperCase() !== "UPI") continue;

        if (qrObjId && String(s.paymentQrId) !== String(qrObjId)) {
          continue;
        }

        const actualDate = resolveActualDate(s, s.settledDate);
        if (dateFrom && actualDate < dateFrom) continue;
        if (dateTo && actualDate > dateTo) continue;

        const cust = doc.customerId || {};
        const custPhone = cust.mobile || cust.phone || null;
        const shiftObj = s.shiftId || {};
        const shiftTitle = shiftObj.shiftName || (shiftObj.shiftNo ? `Shift #${shiftObj.shiftNo}` : null);
        const cashierName = s.createdBy?.name || (s.createdBy?.email ? s.createdBy.email.split("@")[0] : "Cashier");

        allRecords.push({
          id: `credit-${s._id}`,
          rawId: s._id,
          sourceType: "CREDIT_SETTLEMENT",
          referenceNo: doc.invoiceNo ? `SETTLE-${doc.invoiceNo}` : `SETTLE-${String(s._id).slice(-6).toUpperCase()}`,
          branchId: doc.branchId || null,
          date: actualDate, // Exact actual settlement execution timestamp
          upiAmount: Number(s.settledAmount || 0),
          totalAmount: Number(doc.invoiceAmount || s.settledAmount || 0),
          isSplit: false,
          paymentQr: resolveQrInfo(s.paymentQrId),
          customer: {
            _id: cust._id || null,
            name: cust.name || "Customer",
            mobile: custPhone,
          },
          shift: {
            _id: shiftObj._id || null,
            shiftNo: shiftObj.shiftNo || null,
            shiftName: shiftTitle,
          },
          narration: s.narration || `Credit settlement for Invoice ${doc.invoiceNo || ""}`,
          status: "SETTLED",
          details: {
            invoiceNo: doc.invoiceNo,
            invoiceAmount: doc.invoiceAmount,
            balanceDue: doc.balanceDue,
            settledAmount: s.settledAmount,
            settledDate: s.settledDate, // Retained for display/audit
            createdByName: cashierName,
          },
        });
      }
    }
  }

  // =========================================================================
  // SOURCE 3: Customer Advance Receipts
  // =========================================================================
  if (sourceType === "all" || sourceType === "advance") {
    const advMatch = {
      companyId: compObjId,
      status: "ACTIVE",
      paymentMethod: { $regex: /^upi$/i },
    };
    if (workObjId) advMatch.workspaceId = workObjId;

    const advAndConditions = [];

    // Advance receipt documents have type "ADVANCE_RECEIVED", or legacy "RECEIPT"
    advAndConditions.push({
      $or: [
        { type: "ADVANCE_RECEIVED" },
        { type: "RECEIPT" },
        { referenceType: "RECEIPT", type: { $ne: "CREDIT_SETTLED" } },
      ],
    });

    if (branchObjId) {
      advAndConditions.push({
        $or: [{ branchId: branchObjId }, { branchId: null }],
      });
    }

    if (qrObjId) {
      advAndConditions.push({
        $or: [
          { paymentQrId: qrObjId },
          { "paymentDetails.paymentQrId": qrObjId },
        ],
      });
    }

    if (dateFrom || dateTo) {
      const advDateRange = {};
      if (dateFrom) advDateRange.$gte = dateFrom;
      if (dateTo) advDateRange.$lte = dateTo;
      advMatch.createdAt = advDateRange;
    }

    if (advAndConditions.length > 0) {
      advMatch.$and = advAndConditions;
    }

    const advances = await CustomerAdvanceTransaction.find(advMatch)
      .select("customerId amount balanceAfter referenceType referenceId referenceNumber paymentQrId paymentDetails shiftId branchId narration status createdBy createdAt")
      .populate({ path: "customerId", select: "name mobile phone" })
      .populate({ path: "shiftId", select: "shiftNo shiftName" })
      .populate({ path: "createdBy", select: "name email" })
      .populate({ path: "branchId", select: "name branchCode" })
      .lean();

    for (const adv of advances) {
      const actualDate = resolveActualDate(adv, adv.createdAt);
      if (dateFrom && actualDate < dateFrom) continue;
      if (dateTo && actualDate > dateTo) continue;

      const cust = adv.customerId || {};
      const custPhone = cust.mobile || cust.phone || null;
      const shiftObj = adv.shiftId || {};
      const shiftTitle = shiftObj.shiftName || (shiftObj.shiftNo ? `Shift #${shiftObj.shiftNo}` : null);
      const cashierName = adv.createdBy?.name || (adv.createdBy?.email ? adv.createdBy.email.split("@")[0] : "Cashier");
      const matchedQr = adv.paymentQrId || adv.paymentDetails?.paymentQrId;

      allRecords.push({
        id: `adv-${adv._id}`,
        rawId: adv._id,
        sourceType: "ADVANCE_RECEIPT",
        referenceNo: adv.referenceNumber || `ADV-${String(adv._id).slice(-6).toUpperCase()}`,
        branchId: adv.branchId || null,
        date: actualDate, // Exact actual advance deposit timestamp
        upiAmount: Number(adv.amount || 0),
        totalAmount: Number(adv.amount || 0),
        isSplit: false,
        paymentQr: resolveQrInfo(matchedQr),
        customer: {
          _id: cust._id || null,
          name: cust.name || "Customer",
          mobile: custPhone,
        },
        shift: {
          _id: shiftObj._id || null,
          shiftNo: shiftObj.shiftNo || null,
          shiftName: shiftTitle,
        },
        narration: adv.narration || "Customer advance deposit via UPI",
        status: adv.status || "ACTIVE",
        details: {
          referenceNumber: adv.referenceNumber,
          referenceType: adv.referenceType,
          balanceAfter: adv.balanceAfter,
          createdByName: cashierName,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Filtering (Search query: referenceNo, customer name, mobile, narration, UPI ID)
  // -------------------------------------------------------------------------
  let filteredRecords = allRecords;
  if (search) {
    filteredRecords = allRecords.filter((r) => {
      const ref = String(r.referenceNo || "").toLowerCase();
      const cName = String(r.customer?.name || "").toLowerCase();
      const cPhone = String(r.customer?.mobile || "").toLowerCase();
      const narr = String(r.narration || "").toLowerCase();
      const upi = String(r.paymentQr?.upiId || "").toLowerCase();
      return (
        ref.includes(search) ||
        cName.includes(search) ||
        cPhone.includes(search) ||
        narr.includes(search) ||
        upi.includes(search)
      );
    });
  }

  // -------------------------------------------------------------------------
  // Compute UPI Tally Statistics (Strictly independent of pagination)
  // -------------------------------------------------------------------------
  let totalTransactions = filteredRecords.length;
  let totalAmount = 0;
  let invoiceCount = 0;
  let invoiceAmount = 0;
  let creditSettlementCount = 0;
  let creditSettlementAmount = 0;
  let advanceCount = 0;
  let advanceAmount = 0;
  let matchingSplitCount = 0;

  for (const r of filteredRecords) {
    const amt = Number(r.upiAmount || 0);
    totalAmount += amt;

    if (r.sourceType === "INVOICE") {
      invoiceCount += 1;
      invoiceAmount += amt;
      if (r.isSplit) matchingSplitCount += 1;
    } else if (r.sourceType === "CREDIT_SETTLEMENT") {
      creditSettlementCount += 1;
      creditSettlementAmount += amt;
    } else if (r.sourceType === "ADVANCE_RECEIPT") {
      advanceCount += 1;
      advanceAmount += amt;
    }
  }

  // -------------------------------------------------------------------------
  // Sorting
  // -------------------------------------------------------------------------
  filteredRecords.sort((a, b) => {
    if (sortBy === "amount") {
      return sortOrder === "asc" ? a.upiAmount - b.upiAmount : b.upiAmount - a.upiAmount;
    }
    if (sortBy === "referenceno") {
      return sortOrder === "asc"
        ? String(a.referenceNo).localeCompare(String(b.referenceNo))
        : String(b.referenceNo).localeCompare(String(a.referenceNo));
    }
    // Default: date
    const timeA = new Date(a.date).getTime();
    const timeB = new Date(b.date).getTime();
    return sortOrder === "asc" ? timeA - timeB : timeB - timeA;
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------
  const total = filteredRecords.length;
  const startIndex = (page - 1) * limit;
  const pagedData = filteredRecords.slice(startIndex, startIndex + limit);

  return {
    summary: {
      totalTransactions,
      totalAmount,
      invoiceCount,
      invoiceAmount,
      creditSettlementCount,
      creditSettlementAmount,
      advanceCount,
      advanceAmount,
      matchingSplitCount,
    },
    data: pagedData,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      hasMore: startIndex + pagedData.length < total,
    },
  };
};

export default { getPaymentQrStats, getUpiTransactions };

