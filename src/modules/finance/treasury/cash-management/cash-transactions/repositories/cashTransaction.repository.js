import mongoose from "mongoose";
import CashTransaction from "../models/cashTransaction.model.js";
import SalesInvoice from "../../../../../sales/invoices/models/invoice.model.js";
import User from "../../../../../core/users/models/user.model.js";

const POPULATE_FIELDS = [
  { path: "counterpartyAccountId", select: "accountName accountCode accountNature accountCategory" },
  { path: "journalVoucherId", select: "voucherNumber voucherDate status" },
  { path: "createdBy", select: "name email" },
  { path: "postedBy", select: "name email" },
  { path: "cancelledBy", select: "name email" },
];

const attachInvoiceDetails = async (cashTransactions, companyId) => {
  if (!Array.isArray(cashTransactions) || cashTransactions.length === 0) return cashTransactions;

  const candidateInvNos = new Set();
  for (const ct of cashTransactions) {
    if (ct.referenceNumber) {
      candidateInvNos.add(ct.referenceNumber.trim());
    }
    if (ct.narration) {
      const match = ct.narration.match(/Invoice\s+([A-Za-z0-9\-_]+)/i);
      if (match && match[1]) {
        candidateInvNos.add(match[1].trim());
      }
    }
  }

  if (candidateInvNos.size === 0) return cashTransactions;

  try {
    const compObjId = mongoose.Types.ObjectId.isValid(companyId)
      ? new mongoose.Types.ObjectId(companyId)
      : companyId;

    const invoices = await SalesInvoice.find({
      companyId: compObjId,
      invoiceNo: { $in: Array.from(candidateInvNos) },
      isDeleted: false,
    })
      .select("invoiceNo date grandTotal subtotal tax discount paymentMethod payments customerId shiftId status items createdByName createdByEmail createdAt")
      .populate("customerId", "name mobile phone code")
      .lean();

    const invoiceMap = new Map();
    for (const inv of invoices) {
      invoiceMap.set(inv.invoiceNo, inv);
    }

    for (const ct of cashTransactions) {
      let matchedInv = null;
      if (ct.referenceNumber && invoiceMap.has(ct.referenceNumber.trim())) {
        matchedInv = invoiceMap.get(ct.referenceNumber.trim());
      } else if (ct.narration) {
        const match = ct.narration.match(/Invoice\s+([A-Za-z0-9\-_]+)/i);
        if (match && match[1] && invoiceMap.has(match[1].trim())) {
          matchedInv = invoiceMap.get(match[1].trim());
        }
      }

      if (matchedInv) {
        if (ct._doc) {
          ct._doc.invoice = matchedInv;
        } else {
          ct.invoice = matchedInv;
        }
      }
    }
  } catch (err) {
    console.warn("Could not attach invoice details to cash transactions:", err.message);
  }

  return cashTransactions;
};

const findCashTransactionById = async (id, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const doc = await CashTransaction.findOne({ _id: id, isDeleted: false })
    .populate(POPULATE_FIELDS)
    .session(options.session || null);
  if (doc) {
    await attachInvoiceDetails([doc], doc.companyId);
  }
  return doc;
};

const findCashTransactionByIdCompanyAndWorkspace = async (
  id,
  companyId,
  workspaceId,
  options = {},
) => {
  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !mongoose.Types.ObjectId.isValid(companyId) ||
    !mongoose.Types.ObjectId.isValid(workspaceId)
  ) {
    return null;
  }
  const doc = await CashTransaction.findOne({
    _id: id,
    companyId,
    workspaceId,
    isDeleted: false,
  })
    .populate(POPULATE_FIELDS)
    .session(options.session || null);
  if (doc) {
    await attachInvoiceDetails([doc], doc.companyId);
  }
  return doc;
};

const createCashTransaction = async (payload, options = {}) => {
  const [cashTransaction] = await CashTransaction.create([payload], {
    session: options.session || null,
  });
  return cashTransaction;
};

const getCashTransactions = async (
  workspaceId,
  companyId,
  filters = {},
  options = {},
) => {
  const query = {
    workspaceId,
    companyId,
    isDeleted: false,
  };

  if (filters.branchId) query.branchId = filters.branchId;
  if (filters.partition && filters.partition !== "all") query.cashPartition = filters.partition;
  if (filters.cashPartition && filters.cashPartition !== "all") query.cashPartition = filters.cashPartition;
  if (filters.transactionType && filters.transactionType !== "all") query.transactionType = filters.transactionType;
  if (filters.direction && filters.direction !== "all") query.direction = filters.direction;
  if (filters.status && filters.status !== "all") query.status = filters.status;

  if (filters.startDate || filters.endDate) {
    query.transactionDate = {};
    if (filters.startDate) query.transactionDate.$gte = new Date(filters.startDate);
    if (filters.endDate) query.transactionDate.$lte = new Date(filters.endDate);
  }

  if (filters.search) {
    const searchRegex = new RegExp(filters.search.trim(), "i");
    query.$or = [
      { transactionNumber: searchRegex },
      { referenceNumber: searchRegex },
      { narration: searchRegex },
    ];
  }

  let sort = { transactionDate: -1, createdAt: -1 };
  if (options.sortBy) {
    const sOrder = options.sortOrder === "asc" ? 1 : -1;
    if (options.sortBy === "amount") sort = { amount: sOrder };
    else if (options.sortBy === "date") sort = { transactionDate: sOrder, createdAt: sOrder };
    else if (options.sortBy === "number" || options.sortBy === "transactionnumber") sort = { transactionNumber: sOrder };
    else if (options.sortBy === "status") sort = { status: sOrder };
  } else if (options.sort) {
    sort = options.sort;
  }

  // Build aggregation query with explicit ObjectId casting for MongoDB aggregate pipeline
  const aggQuery = { isDeleted: false };
  if (workspaceId && mongoose.Types.ObjectId.isValid(workspaceId)) {
    aggQuery.workspaceId = new mongoose.Types.ObjectId(workspaceId);
  }
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    aggQuery.companyId = new mongoose.Types.ObjectId(companyId);
  }
  if (filters.branchId && mongoose.Types.ObjectId.isValid(filters.branchId)) {
    aggQuery.branchId = new mongoose.Types.ObjectId(filters.branchId);
  }
  if (filters.partition && filters.partition !== "all") aggQuery.cashPartition = filters.partition;
  if (filters.cashPartition && filters.cashPartition !== "all") aggQuery.cashPartition = filters.cashPartition;
  if (filters.transactionType && filters.transactionType !== "all") aggQuery.transactionType = filters.transactionType;
  if (filters.direction && filters.direction !== "all") aggQuery.direction = filters.direction;
  if (filters.status && filters.status !== "all") aggQuery.status = filters.status;

  if (filters.startDate || filters.endDate) {
    aggQuery.transactionDate = {};
    if (filters.startDate) aggQuery.transactionDate.$gte = new Date(filters.startDate);
    if (filters.endDate) aggQuery.transactionDate.$lte = new Date(filters.endDate);
  }

  if (filters.search) {
    const searchRegex = new RegExp(filters.search.trim(), "i");
    aggQuery.$or = [
      { transactionNumber: searchRegex },
      { referenceNumber: searchRegex },
      { narration: searchRegex },
    ];
  }

  const summaryPromise = CashTransaction.aggregate([
    { $match: aggQuery },
    {
      $group: {
        _id: null,
        totalTransactions: { $sum: 1 },
        totalCredits: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$direction", "CREDIT"] },
                  { $eq: ["$transactionType", "CASH_IN"] },
                ],
              },
              "$amount",
              0,
            ],
          },
        },
        totalDebits: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$direction", "DEBIT"] },
                  { $eq: ["$transactionType", "CASH_OUT"] },
                  { $eq: ["$transactionType", "EXPENSE"] },
                  { $eq: ["$transactionType", "PETTY_CASH"] },
                ],
              },
              "$amount",
              0,
            ],
          },
        },
        inwardCount: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$direction", "CREDIT"] },
                  { $eq: ["$transactionType", "CASH_IN"] },
                ],
              },
              1,
              0,
            ],
          },
        },
        outwardCount: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ["$direction", "DEBIT"] },
                  { $eq: ["$transactionType", "CASH_OUT"] },
                  { $eq: ["$transactionType", "EXPENSE"] },
                  { $eq: ["$transactionType", "PETTY_CASH"] },
                ],
              },
              1,
              0,
            ],
          },
        },
        draftCount: {
          $sum: {
            $cond: [{ $eq: ["$status", "DRAFT"] }, 1, 0],
          },
        },
        postedCount: {
          $sum: {
            $cond: [{ $eq: ["$status", "POSTED"] }, 1, 0],
          },
        },
      },
    },
  ]).session(options.session || null);

  if (options.all === true) {
    const [cashTransactions, summaryResult] = await Promise.all([
      CashTransaction.find(query)
        .populate(POPULATE_FIELDS)
        .sort(sort)
        .session(options.session || null),
      summaryPromise,
    ]);
    await attachInvoiceDetails(cashTransactions, companyId);
    const rawSummary = summaryResult?.[0] || {};
    const totalCredits = rawSummary.totalCredits || 0;
    const totalDebits = rawSummary.totalDebits || 0;
    const summary = {
      totalTransactions: rawSummary.totalTransactions || cashTransactions.length,
      totalCredits,
      totalDebits,
      netFlow: totalCredits - totalDebits,
      inwardCount: rawSummary.inwardCount || 0,
      outwardCount: rawSummary.outwardCount || 0,
      draftCount: rawSummary.draftCount || 0,
      postedCount: rawSummary.postedCount || 0,
    };
    return { cashTransactions, total: cashTransactions.length, summary };
  }

  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const skip = (page - 1) * limit;

  const [cashTransactions, total, summaryResult] = await Promise.all([
    CashTransaction.find(query)
      .populate(POPULATE_FIELDS)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .session(options.session || null),
    CashTransaction.countDocuments(query).session(options.session || null),
    summaryPromise,
  ]);

  await attachInvoiceDetails(cashTransactions, companyId);

  const rawSummary = summaryResult?.[0] || {};
  const totalCredits = rawSummary.totalCredits || 0;
  const totalDebits = rawSummary.totalDebits || 0;

  const summary = {
    totalTransactions: rawSummary.totalTransactions || total,
    totalCredits,
    totalDebits,
    netFlow: totalCredits - totalDebits,
    inwardCount: rawSummary.inwardCount || 0,
    outwardCount: rawSummary.outwardCount || 0,
    draftCount: rawSummary.draftCount || 0,
    postedCount: rawSummary.postedCount || 0,
  };

  return { cashTransactions, total, summary, page, limit };
};

const getNextTransactionNumber = async (companyId, workspaceId, options = {}) => {
  const year = new Date().getFullYear();
  const prefix = `CT-${year}-`;

  const last = await CashTransaction.findOne({
    companyId,
    workspaceId,
    transactionNumber: { $regex: `^${prefix}` },
  })
    .sort({ transactionNumber: -1 })
    .select("transactionNumber")
    .session(options.session || null);

  let seq = 1;
  if (last) {
    const parts = last.transactionNumber.split("-");
    const lastSeq = parseInt(parts[parts.length - 1]);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${String(seq).padStart(5, "0")}`;
};

export default {
  findCashTransactionById,
  findCashTransactionByIdCompanyAndWorkspace,
  createCashTransaction,
  getCashTransactions,
  getNextTransactionNumber,
};

