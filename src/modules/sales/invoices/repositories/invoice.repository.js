import mongoose from "mongoose";
import SalesInvoice from "../models/invoice.model.js";
import SalesReturn from "../../returns/models/salesReturn.model.js";
import "../../../parties/customers/models/customer.model.js";
import "../../../operations/shifts/shift.model.js";
import "../../../finance/treasury/payment-qr/models/paymentQr.model.js";
import "../../../finance/treasury/bank-management/bank-accounts/models/bankAccount.model.js";
import "../../../platform/global-catalog/bank-master/models/bankMaster.model.js";

const createInvoice = async (invoiceData, options = {}) => {
  const invoice = new SalesInvoice(invoiceData);
  return invoice.save({ session: options.session || null });
};

const formatPaymentQr = (doc) => {
  if (!doc) return null;
  const bankName =
    doc.bankAccountId?.bankMasterId?.bankName ||
    doc.bankAccountId?.accountName ||
    doc.provider ||
    "";
  const label = doc.label || "";
  const upiId = doc.upiId || "";
  let displayName = label || bankName || upiId || "UPI";
  if (label && bankName && !label.toLowerCase().includes(bankName.toLowerCase())) {
    displayName = `${bankName} (${label})`;
  } else if (label && upiId) {
    displayName = `${label} (${upiId})`;
  } else if (bankName && upiId) {
    displayName = `${bankName} (${upiId})`;
  }
  return {
    _id: doc._id,
    upiId,
    label,
    provider: doc.provider,
    bankName,
    accountName: doc.bankAccountId?.accountName || "",
    displayName,
  };
};

const getInvoiceById = async (invoiceId, companyId, workspaceId, session = null) => {
  const isObjectId = mongoose.Types.ObjectId.isValid(invoiceId);
  const query = {
    companyId: new mongoose.Types.ObjectId(companyId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
    ...(isObjectId
      ? { $or: [{ _id: new mongoose.Types.ObjectId(invoiceId) }, { invoiceNo: invoiceId }] }
      : { invoiceNo: invoiceId }),
  };

  const queryBuilder = SalesInvoice.findOne(query)
    .populate("customerId", "name mobile alternateMobile phone contactNumber contact customerCode customerType gstNumber panNumber billingAddress creditLimit creditDays advanceBalance creditOutstanding")
    .populate("doctorId", "name doctorCode qualification specialty mobile phone clinicHospitalName")
    .populate("shiftId", "status shiftNo shiftName shiftNumber openPeriod openedAt closedAt branchId")
    .populate({
      path: "paymentQrId",
      select: "upiId label provider bankAccountId",
      populate: {
        path: "bankAccountId",
        select: "accountName accountHolderName accountNumber branchName",
        populate: { path: "bankMasterId", select: "bankName" },
      },
    })
    .populate({
      path: "payments.paymentQrId",
      select: "upiId label provider bankAccountId",
      populate: {
        path: "bankAccountId",
        select: "accountName accountHolderName accountNumber branchName",
        populate: { path: "bankMasterId", select: "bankName" },
      },
    })
    .lean();
  if (session) queryBuilder.session(session);

  const inv = await queryBuilder.exec();
  if (!inv) return null;

  // Fallback / legacy sync: if invoice doesn't have returnInvoices embedded, check SalesReturn collection
  if (!inv.returnInvoices || inv.returnInvoices.length === 0) {
    try {
      const linkedReturns = await SalesReturn.find({
        workspaceId: inv.workspaceId,
        companyId: inv.companyId,
        $or: [
          { originalInvoiceId: inv._id },
          { originalInvoiceNo: inv.invoiceNo },
        ],
        isDeleted: false,
      })
        .select("returnNo invoiceNo date grandTotal returnType refundMethod paymentMethod items")
        .sort({ date: 1, createdAt: 1 })
        .lean();

      if (linkedReturns.length > 0) {
        inv.returnInvoices = linkedReturns.map((r) => ({
          returnId: r._id,
          returnNo: r.returnNo || r.invoiceNo,
          date: r.date,
          returnAmount: r.grandTotal,
          returnType: r.returnType,
          refundMethod: r.refundMethod || r.paymentMethod,
          items: r.items,
        }));
        inv.returnInvoiceIds = linkedReturns.map((r) => r._id);
        inv.totalReturnedAmount = linkedReturns.reduce((sum, r) => sum + Number(r.grandTotal || 0), 0);
        inv.isReturned = true;

        if (Array.isArray(inv.items)) {
          inv.items = inv.items.map((item) => {
            let retQty = Number(item.returnedQty || 0);
            if (retQty === 0) {
              for (const ret of linkedReturns) {
                for (const rIt of (ret.items || [])) {
                  const matchById = rIt.productId && item.productId && rIt.productId.toString() === item.productId.toString();
                  const matchByName = rIt.name && item.name && rIt.name.trim().toLowerCase() === item.name.trim().toLowerCase();
                  const matchBatch = !rIt.batchNo || !item.batch || rIt.batchNo === item.batch;
                  if ((matchById || matchByName) && matchBatch) {
                    retQty += Number(rIt.qty || rIt.quantity || 0);
                  }
                }
              }
            }
            const soldQty = Number(item.qty || 1);
            return {
              ...item,
              returnedQty: retQty,
              isReturned: retQty >= soldQty,
              returnStatus: retQty >= soldQty ? "FULL" : (retQty > 0 ? "PARTIAL" : "NONE"),
            };
          });

          const isAllFullyReturned = inv.items.length > 0 && inv.items.every((it) => (Number(it.returnedQty) || 0) >= Number(it.qty || 1));
          inv.returnStatus = isAllFullyReturned ? "FULL" : "PARTIAL";
          inv.isFullyReturned = isAllFullyReturned;
        }
      }
    } catch (retFetchErr) {
      console.warn("[InvoiceRepository] Error fetching linked sales returns for invoice:", retFetchErr.message);
    }
  }

  const resolvedPaymentQr = inv.paymentQrId ? formatPaymentQr(inv.paymentQrId) : null;
  const mappedPayments = (Array.isArray(inv.payments) ? inv.payments : []).map((p) => {
    const subQr = p.paymentQrId ? formatPaymentQr(p.paymentQrId) : resolvedPaymentQr;
    return {
      ...p,
      paymentQr: subQr,
    };
  });

  return {
    ...inv,
    paymentQr: resolvedPaymentQr,
    payments: mappedPayments,
  };
};

const getLatestInvoiceByPrefix = async (companyId, workspaceId, prefix, branchId = null) => {
  const query = {
    companyId: new mongoose.Types.ObjectId(companyId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    invoiceNo: { $regex: `^${prefix}` },
    isDeleted: false,
  };

  if (branchId) {
    query.branchId = new mongoose.Types.ObjectId(branchId);
  }

  return SalesInvoice.findOne(query)
    .sort({ invoiceNo: -1, createdAt: -1 })
    .select("invoiceNo")
    .lean();
};

const getInvoiceByInvoiceNo = async (companyId, workspaceId, invoiceNo, branchId = null) => {
  const query = {
    companyId: new mongoose.Types.ObjectId(companyId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    invoiceNo,
    isDeleted: false,
  };

  if (branchId) {
    query.branchId = new mongoose.Types.ObjectId(branchId);
  }

  return SalesInvoice.findOne(query)
    .select("invoiceNo")
    .lean();
};


const getInvoicesByCustomerId = async (customerId, companyId, workspaceId, filters = {}, pagination = {}) => {
  const page = Math.max(1, parseInt(pagination.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(pagination.limit) || 10));
  const skip = (page - 1) * limit;

  const query = {
    companyId: new mongoose.Types.ObjectId(companyId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
  };

  if (Array.isArray(customerId)) {
    query.customerId = { $in: customerId.map((id) => new mongoose.Types.ObjectId(id)) };
  } else {
    query.customerId = new mongoose.Types.ObjectId(customerId);
  }

  if (filters.branchId && mongoose.Types.ObjectId.isValid(filters.branchId)) {
    query.branchId = new mongoose.Types.ObjectId(filters.branchId);
  }

  const [invoices, total, aggregate] = await Promise.all([
    SalesInvoice.find(query)
      .select("invoiceNo date billingMode subtotal discount tax grandTotal paymentMethod status items customerId branchId createdAt returnInvoiceIds returnInvoices returnStatus isReturned totalReturnedAmount isFullyReturned")
      .populate("customerId", "name mobile customerCode gender")
      .populate("branchId", "name branchCode")
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SalesInvoice.countDocuments(query),
    SalesInvoice.aggregate([{ $match: query }, { $group: { _id: null, totalAmount: { $sum: "$grandTotal" } } }]),
  ]);

  const totalSalesAmount = aggregate[0]?.totalAmount || 0;

  return { sales: invoices, total, page, limit, totalSalesAmount };
};

const getAllInvoices = async (companyId, workspaceId, filters = {}, pagination = {}) => {
  const page = Math.max(1, parseInt(pagination.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(pagination.limit) || 10));
  const skip = (page - 1) * limit;

  const query = {
    companyId: new mongoose.Types.ObjectId(companyId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
  };

  if (filters.branchId) {
    query.branchId = new mongoose.Types.ObjectId(filters.branchId);
  }

  if (filters.shiftId) {
    query.shiftId = new mongoose.Types.ObjectId(filters.shiftId);
  }

  if (filters.status && filters.status !== "all") {
    query.status = filters.status;
  }

  if (filters.startDate || filters.endDate) {
    query.date = {};
    if (filters.startDate) {
      query.date.$gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      const end = new Date(filters.endDate);
      end.setHours(23, 59, 59, 999);
      query.date.$lte = end;
    }
  }

  const andConditions = [];

  // Inclusive Invoice Number Range filter (supports numeric 35-55, 1-20, as well as full string serials)
  if (filters.fromInvoice || filters.toInvoice) {
    const fromStr = String(filters.fromInvoice || "").trim();
    const toStr = String(filters.toInvoice || "").trim();

    const parseInvoiceNoInput = (str) => {
      if (!str) return { seq: null, prefix: null };
      const parts = str.split("-");
      if (parts.length > 1) {
        const lastPart = parts[parts.length - 1].trim();
        const num = parseInt(lastPart, 10);
        const prefix = parts.slice(0, -1).join("-") + "-";
        return { seq: !isNaN(num) ? num : null, prefix };
      }
      const num = parseInt(str, 10);
      return { seq: !isNaN(num) ? num : null, prefix: null };
    };

    const fromInfo = parseInvoiceNoInput(fromStr);
    const toInfo = parseInvoiceNoInput(toStr);
    const resolvedPrefix = fromInfo.prefix || toInfo.prefix || null;

    if (fromInfo.seq !== null || toInfo.seq !== null) {
      const rangeConditions = [];
      if (resolvedPrefix) {
        rangeConditions.push({ invoiceNo: { $regex: `^${resolvedPrefix}`, $options: "i" } });
      }

      // Extract trailing segment after last hyphen and convert to integer safely
      const seqExpr = {
        $convert: {
          input: { $arrayElemAt: [{ $split: ["$invoiceNo", "-"] }, -1] },
          to: "int",
          onError: 0,
          onNull: 0,
        },
      };

      if (fromInfo.seq !== null) {
        rangeConditions.push({ $expr: { $gte: [seqExpr, fromInfo.seq] } });
      }
      if (toInfo.seq !== null) {
        rangeConditions.push({ $expr: { $lte: [seqExpr, toInfo.seq] } });
      }

      if (rangeConditions.length === 1) {
        andConditions.push(rangeConditions[0]);
      } else if (rangeConditions.length > 1) {
        andConditions.push({ $and: rangeConditions });
      }
    } else {
      // Direct string comparison fallback
      const strRange = {};
      if (fromStr) strRange.$gte = fromStr;
      if (toStr) strRange.$lte = toStr;
      andConditions.push({ invoiceNo: strRange });
    }
  }

  // Payment filtering: include Split invoices that contain Cash or UPI allocations
  if (filters.paymentMethod && filters.paymentMethod !== "all") {
    const pm = String(filters.paymentMethod).trim();
    if (pm.toLowerCase() === "cash") {
      andConditions.push({
        $or: [
          { paymentMethod: { $regex: /^cash$/i } },
          {
            $and: [
              {
                $or: [
                  { paymentMethod: { $regex: /^split$/i } },
                  { "payments.1": { $exists: true } },
                ],
              },
              {
                $or: [
                  { "payments.paymentType": { $regex: /cash/i } },
                  { "payments.paymentMode": { $regex: /cash/i } },
                  { "payments.type": { $regex: /cash/i } },
                  { cashTendered: { $gt: 0 } },
                ],
              },
            ],
          },
        ],
      });
    } else if (pm.toLowerCase() === "upi") {
      andConditions.push({
        $or: [
          { paymentMethod: { $regex: /^upi$/i } },
          {
            $and: [
              {
                $or: [
                  { paymentMethod: { $regex: /^split$/i } },
                  { "payments.1": { $exists: true } },
                ],
              },
              {
                $or: [
                  { "payments.paymentType": { $regex: /upi|qr/i } },
                  { "payments.paymentMode": { $regex: /upi|qr/i } },
                  { "payments.type": { $regex: /upi|qr/i } },
                  { paymentQrId: { $ne: null } },
                ],
              },
            ],
          },
        ],
      });
    } else if (pm.toLowerCase() === "split") {
      andConditions.push({
        $or: [
          { paymentMethod: { $regex: /^split$/i } },
          { "payments.1": { $exists: true } },
        ],
      });
    } else if (pm.toLowerCase() === "credit") {
      andConditions.push({
        $or: [
          { paymentMethod: { $regex: /^credit$/i } },
          { "payments.paymentType": { $regex: /credit/i } },
          { "payments.paymentMode": { $regex: /credit/i } },
          { "payments.type": { $regex: /credit/i } },
          { creditStatus: { $in: ["PENDING", "PARTIAL", "SETTLED"] } },
          { creditTransactionId: { $ne: null } },
        ],
      });
    } else if (pm.toLowerCase() === "advance") {
      andConditions.push({
        $or: [
          { paymentMethod: { $regex: /^advance$/i } },
          { "payments.paymentType": { $regex: /advance/i } },
          { "payments.paymentMode": { $regex: /advance/i } },
          { "payments.type": { $regex: /advance/i } },
        ],
      });
    } else {
      andConditions.push({
        paymentMethod: { $regex: new RegExp(`^${pm}$`, "i") },
      });
    }
  }

  // Filter by specific UPI QR code (matches root paymentQrId or inside payments[])
  if (filters.paymentQrId && filters.paymentQrId !== "all") {
    const qrIdStr = String(filters.paymentQrId).trim();
    const qrConditions = [
      { paymentQrId: qrIdStr },
      { "payments.paymentQrId": qrIdStr },
    ];
    if (mongoose.Types.ObjectId.isValid(qrIdStr)) {
      const qrObjId = new mongoose.Types.ObjectId(qrIdStr);
      qrConditions.push({ paymentQrId: qrObjId });
      qrConditions.push({ "payments.paymentQrId": qrObjId });
    }
    andConditions.push({ $or: qrConditions });
  }

  if (filters.searchQuery) {
    const rawSearch = filters.searchQuery.trim();
    // Lookup matching customers
    const matchingCustomers = await mongoose.model("Customer").find({
      companyId: new mongoose.Types.ObjectId(companyId),
      $or: [
        { name: { $regex: rawSearch, $options: "i" } },
        { mobile: { $regex: rawSearch, $options: "i" } },
        { alternateMobile: { $regex: rawSearch, $options: "i" } },
        { phone: { $regex: rawSearch, $options: "i" } },
      ],
    }).select("_id").lean();

    const customerIds = matchingCustomers.map((c) => c._id);
    const searchOr = [
      { invoiceNo: { $regex: rawSearch, $options: "i" } },
      { customerName: { $regex: rawSearch, $options: "i" } },
      { customerPhone: { $regex: rawSearch, $options: "i" } },
    ];
    if (customerIds.length > 0) {
      searchOr.push({ customerId: { $in: customerIds } });
    }
    andConditions.push({ $or: searchOr });
  }

  if (andConditions.length > 0) {
    if (andConditions.length === 1) {
      Object.assign(query, andConditions[0]);
    } else {
      query.$and = andConditions;
    }
  }

  let sortObj = { createdAt: -1 };
  if (filters.sortBy) {
    const order = (String(filters.sortOrder).toLowerCase() === "asc" || filters.sortOrder === "1" || filters.sortOrder === 1) ? 1 : -1;
    if (filters.sortBy === "date") {
      sortObj = { date: order, createdAt: order };
    } else if (filters.sortBy === "amount" || filters.sortBy === "grandTotal") {
      sortObj = { grandTotal: order, createdAt: -1 };
    } else if (filters.sortBy === "invoiceNo") {
      sortObj = { invoiceNo: order };
    } else if (filters.sortBy === "createdAt") {
      sortObj = { createdAt: order };
    }
  }

  const [invoices, total, summaryRows] = await Promise.all([
    SalesInvoice.find(query)
      .populate("customerId", "name mobile alternateMobile phone contactNumber contact")
      .populate("shiftId", "status shiftNo shiftName shiftNumber openPeriod openedAt closedAt branchId")
      .populate({
        path: "paymentQrId",
        select: "upiId label provider bankAccountId",
        populate: {
          path: "bankAccountId",
          select: "accountName accountHolderName accountNumber branchName",
          populate: { path: "bankMasterId", select: "bankName" },
        },
      })
      .sort(sortObj)
      .skip(skip)
      .limit(limit)
      .lean(),
    SalesInvoice.countDocuments(query),
    SalesInvoice.find(query)
      .select("status grandTotal paymentMethod payments cashTendered paymentQrId")
      .lean(),
  ]);

  // Global summary statistics across all matching records for the active filters
  let totalAmount = 0;
  let pureCashInvoices = 0;
  let pureUpiInvoices = 0;
  let pureSplitInvoices = 0;
  let pureCashAmount = 0;
  let splitCashAmount = 0;
  let pureUpiAmount = 0;
  let splitUpiAmount = 0;
  let matchingSplitInvoices = 0;

  for (const inv of summaryRows) {
    const isCancelled = String(inv.status || "").toLowerCase() === "cancelled";
    // If invoice is cancelled, skip its monetary amounts unless user specifically filtered for Cancelled
    if (isCancelled && String(filters.status || "").toLowerCase() !== "cancelled") {
      continue;
    }

    const grandTotal = Number(inv.grandTotal || 0);
    const methodUpper = String(inv.paymentMethod || "").trim().toUpperCase();
    const isSplit = methodUpper === "SPLIT" || (Array.isArray(inv.payments) && inv.payments.length > 1);

    if (isSplit) {
      pureSplitInvoices += 1;
      totalAmount += grandTotal;
      let hasCash = false;
      let hasUpi = false;
      let invoiceCashPortion = 0;
      let invoiceUpiPortion = 0;

      if (Array.isArray(inv.payments) && inv.payments.length > 0) {
        for (const p of inv.payments) {
          const type = String(p.paymentType || p.paymentMode || p.type || p.mode || "").toUpperCase();
          const amt = Number(p.amount || 0);
          if (type.includes("UPI") || type.includes("QR")) {
            invoiceUpiPortion += amt;
            hasUpi = true;
          } else if (type.includes("CASH")) {
            invoiceCashPortion += amt;
            hasCash = true;
          } else if (!type.includes("CARD") && !type.includes("WALLET") && !type.includes("CREDIT")) {
            invoiceCashPortion += amt;
            hasCash = true;
          }
        }
      } else if (Number(inv.cashTendered || 0) > 0) {
        invoiceCashPortion = Math.min(grandTotal, Number(inv.cashTendered));
        invoiceUpiPortion = Math.max(0, grandTotal - invoiceCashPortion);
        hasCash = invoiceCashPortion > 0;
        hasUpi = invoiceUpiPortion > 0;
      }

      splitCashAmount += invoiceCashPortion;
      splitUpiAmount += invoiceUpiPortion;

      const filterPm = String(filters.paymentMethod || "").trim().toLowerCase();
      if (filterPm === "cash" && hasCash) {
        matchingSplitInvoices += 1;
      } else if (filterPm === "upi" && hasUpi) {
        matchingSplitInvoices += 1;
      } else if (filterPm === "split" || filterPm === "all" || !filters.paymentMethod) {
        matchingSplitInvoices += 1;
      }
    } else if (methodUpper === "CASH") {
      pureCashInvoices += 1;
      pureCashAmount += grandTotal;
      totalAmount += grandTotal;
    } else if (methodUpper === "UPI") {
      pureUpiInvoices += 1;
      pureUpiAmount += grandTotal;
      totalAmount += grandTotal;
    } else {
      // Other single payment methods (e.g. Card, Credit)
      totalAmount += grandTotal;
    }
  }

  const cashAmount = pureCashAmount + splitCashAmount;
  const upiAmount = pureUpiAmount + splitUpiAmount;

  const summary = {
    totalInvoices: total,
    totalAmount,
    cashAmount,
    upiAmount,
    pureCashInvoices,
    pureUpiInvoices,
    pureSplitInvoices,
    pureCashAmount,
    splitCashAmount,
    pureUpiAmount,
    splitUpiAmount,
    matchingSplitInvoices,
  };

  // Pre-load all referenced Payment QR details for UPI identification
  const allQrIds = new Set();
  invoices.forEach((inv) => {
    if (inv.paymentQrId) {
      const qId = inv.paymentQrId._id || inv.paymentQrId;
      if (qId) allQrIds.add(String(qId));
    }
    if (Array.isArray(inv.payments)) {
      inv.payments.forEach((p) => {
        if (p.paymentQrId) {
          const qId = p.paymentQrId._id || p.paymentQrId;
          if (qId) allQrIds.add(String(qId));
        }
      });
    }
  });

  const qrMap = new Map();
  if (allQrIds.size > 0) {
    const qrDocs = await mongoose
      .model("PaymentQr")
      .find({ _id: { $in: Array.from(allQrIds) } })
      .populate({
        path: "bankAccountId",
        select: "accountName accountHolderName accountNumber branchName",
        populate: { path: "bankMasterId", select: "bankName" },
      })
      .lean();

    qrDocs.forEach((doc) => {
      qrMap.set(String(doc._id), formatPaymentQr(doc));
    });
  }

  // Format to match expectations: accurately resolve customerName, customerPhone, shift, and paymentQr
  const mappedData = invoices.map((inv) => {
    const custObj = (inv.customerId && typeof inv.customerId === "object") ? inv.customerId : {};
    const resolvedPhone =
      custObj.mobile ||
      custObj.phone ||
      custObj.alternateMobile ||
      custObj.contactNumber ||
      custObj.contact ||
      inv.customerPhone ||
      inv.customerMobile ||
      inv.phone ||
      null;

    const resolvedName =
      custObj.name ||
      custObj.customerName ||
      inv.customerName ||
      inv.customer ||
      null;

    const shiftObj = (inv.shiftId && typeof inv.shiftId === "object") ? inv.shiftId : {};

    const invQrId = inv.paymentQrId?._id ? String(inv.paymentQrId._id) : (inv.paymentQrId ? String(inv.paymentQrId) : null);
    const resolvedPaymentQr = invQrId ? (qrMap.get(invQrId) || (typeof inv.paymentQrId === "object" ? inv.paymentQrId : null)) : null;

    const mappedPayments = (Array.isArray(inv.payments) ? inv.payments : []).map((p) => {
      const pQrId = p.paymentQrId?._id ? String(p.paymentQrId._id) : (p.paymentQrId ? String(p.paymentQrId) : null);
      const subQr = pQrId ? (qrMap.get(pQrId) || (typeof p.paymentQrId === "object" ? p.paymentQrId : null)) : resolvedPaymentQr;
      return {
        ...p,
        paymentQr: subQr,
      };
    });

    return {
      ...inv,
      customerName: resolvedName,
      customerPhone: resolvedPhone,
      customerId: custObj._id || inv.customerId,
      shift: shiftObj._id ? shiftObj : null,
      shiftStatus: shiftObj.status || (inv.shiftStatus || null),
      paymentQr: resolvedPaymentQr,
      payments: mappedPayments,
    };
  });

  return { sales: mappedData, total, page, limit, summary };
};

export default {
  createInvoice,
  getInvoiceById,
  getInvoicesByCustomerId,
  getAllInvoices,
  getLatestInvoiceByPrefix,
  getInvoiceByInvoiceNo,
};
