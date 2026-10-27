import mongoose from "mongoose";
import BankTransaction from "../models/bankTransaction.model.js";
import { getBusinessDateRange } from "../../../../../../utils/businessDate.js";

const POPULATE_FIELDS = [
  {
    path: "bankAccountId",
    select: "accountName accountNumber bankMasterId ledgerAccountId",
    populate: { path: "bankMasterId", select: "name code logo" },
  },
  { path: "counterpartyAccountId", select: "accountName accountCode accountNature accountCategory" },
  { path: "journalVoucherId", select: "voucherNumber voucherDate status" },
  { path: "createdBy", select: "name email" },
  { path: "postedBy", select: "name email" },
  { path: "cancelledBy", select: "name email" },
];

const findBankTransactionById = async (id, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return BankTransaction.findOne({ _id: id, isDeleted: false })
    .populate(POPULATE_FIELDS)
    .session(options.session || null);
};

const findBankTransactionByIdCompanyAndWorkspace = async (
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
  return BankTransaction.findOne({
    _id: id,
    companyId,
    workspaceId,
    isDeleted: false,
  })
    .populate(POPULATE_FIELDS)
    .session(options.session || null);
};

const createBankTransaction = async (payload, options = {}) => {
  const [bankTransaction] = await BankTransaction.create([payload], {
    session: options.session || null,
  });
  return bankTransaction;
};

const getBankTransactions = async (
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

  if (filters.bankAccountId && filters.bankAccountId !== "all") query.bankAccountId = filters.bankAccountId;
  if (filters.transactionType && filters.transactionType !== "all") query.transactionType = filters.transactionType;
  if (filters.category && filters.category !== "all") query.category = filters.category;
  if (filters.direction && filters.direction !== "all") query.direction = filters.direction;
  if (filters.status && filters.status !== "all") query.status = filters.status;

  let startDt = null;
  let endDt = null;
  if (filters.startDate) {
    if (typeof filters.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(filters.startDate.trim())) {
      startDt = getBusinessDateRange(filters.startDate.trim()).startOfDay;
    } else {
      startDt = new Date(filters.startDate);
    }
  }
  if (filters.endDate) {
    if (typeof filters.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(filters.endDate.trim())) {
      endDt = getBusinessDateRange(filters.endDate.trim()).endOfDay;
    } else {
      endDt = new Date(filters.endDate);
    }
  }

  if (startDt || endDt) {
    query.transactionDate = {};
    if (startDt) query.transactionDate.$gte = startDt;
    if (endDt) query.transactionDate.$lte = endDt;
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

  // Aggregation query for statistics calculation
  const aggQuery = { isDeleted: false };
  if (workspaceId && mongoose.Types.ObjectId.isValid(workspaceId)) {
    aggQuery.workspaceId = new mongoose.Types.ObjectId(workspaceId);
  }
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    aggQuery.companyId = new mongoose.Types.ObjectId(companyId);
  }
  if (filters.bankAccountId && filters.bankAccountId !== "all" && mongoose.Types.ObjectId.isValid(filters.bankAccountId)) {
    aggQuery.bankAccountId = new mongoose.Types.ObjectId(filters.bankAccountId);
  }
  if (filters.transactionType && filters.transactionType !== "all") aggQuery.transactionType = filters.transactionType;
  if (filters.category && filters.category !== "all") aggQuery.category = filters.category;
  if (filters.direction && filters.direction !== "all") aggQuery.direction = filters.direction;
  if (filters.status && filters.status !== "all") aggQuery.status = filters.status;

  if (startDt || endDt) {
    aggQuery.transactionDate = {};
    if (startDt) aggQuery.transactionDate.$gte = startDt;
    if (endDt) aggQuery.transactionDate.$lte = endDt;
  }


  if (filters.search) {
    const searchRegex = new RegExp(filters.search.trim(), "i");
    aggQuery.$or = [
      { transactionNumber: searchRegex },
      { referenceNumber: searchRegex },
      { narration: searchRegex },
    ];
  }

  const summaryPromise = BankTransaction.aggregate([
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
                  { $eq: ["$transactionType", "DEPOSIT"] },
                  { $eq: ["$transactionType", "INTEREST"] },
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
                  { $eq: ["$transactionType", "WITHDRAWAL"] },
                  { $eq: ["$transactionType", "BANK_CHARGES"] },
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
                  { $eq: ["$transactionType", "DEPOSIT"] },
                  { $eq: ["$transactionType", "INTEREST"] },
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
                  { $eq: ["$transactionType", "WITHDRAWAL"] },
                  { $eq: ["$transactionType", "BANK_CHARGES"] },
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
  ]);

  if (options.all === true) {
    const [bankTransactions, summaryAgg] = await Promise.all([
      BankTransaction.find(query)
        .populate(POPULATE_FIELDS)
        .sort(sort)
        .session(options.session || null),
      summaryPromise,
    ]);
    const summaryRaw = summaryAgg?.[0] || {};
    const totalCredits = summaryRaw.totalCredits || 0;
    const totalDebits = summaryRaw.totalDebits || 0;
    const summary = {
      totalTransactions: summaryRaw.totalTransactions || bankTransactions.length,
      totalCredits,
      totalDebits,
      netFlow: totalCredits - totalDebits,
      inwardCount: summaryRaw.inwardCount || 0,
      outwardCount: summaryRaw.outwardCount || 0,
      draftCount: summaryRaw.draftCount || 0,
      postedCount: summaryRaw.postedCount || 0,
    };
    return { bankTransactions, total: bankTransactions.length, summary };
  }

  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const skip = (page - 1) * limit;

  const [bankTransactions, total, summaryAgg] = await Promise.all([
    BankTransaction.find(query)
      .populate(POPULATE_FIELDS)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .session(options.session || null),
    BankTransaction.countDocuments(query).session(options.session || null),
    summaryPromise,
  ]);

  const summaryRaw = summaryAgg?.[0] || {};
  const totalCredits = summaryRaw.totalCredits || 0;
  const totalDebits = summaryRaw.totalDebits || 0;
  const summary = {
    totalTransactions: summaryRaw.totalTransactions || total,
    totalCredits,
    totalDebits,
    netFlow: totalCredits - totalDebits,
    inwardCount: summaryRaw.inwardCount || 0,
    outwardCount: summaryRaw.outwardCount || 0,
    draftCount: summaryRaw.draftCount || 0,
    postedCount: summaryRaw.postedCount || 0,
  };

  return { bankTransactions, total, page, limit, summary };
};

const getNextTransactionNumber = async (companyId, workspaceId, options = {}) => {
  const year = new Date().getFullYear();
  const prefix = `BT-${year}-`;

  const last = await BankTransaction.findOne({
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
  findBankTransactionById,
  findBankTransactionByIdCompanyAndWorkspace,
  createBankTransaction,
  getBankTransactions,
  getNextTransactionNumber,
};
