import mongoose from "mongoose";
import Cheque from "../models/cheque.model.js";

const POPULATE_FIELDS = [
  {
    path: "bankAccountId",
    select: "accountName accountNumber bankMasterId",
    populate: { path: "bankMasterId", select: "name shortName" },
  },
  {
    path: "counterpartyAccountId",
    select: "accountName accountCode accountNature",
  },
  { path: "createdBy", select: "name email" },
  { path: "depositedBy", select: "name email" },
  { path: "clearedBy", select: "name email" },
  { path: "bouncedBy", select: "name email" },
  { path: "cancelledBy", select: "name email" },
  {
    path: "pendingJournalVoucherId",
    select: "voucherNumber voucherDate status",
  },
  {
    path: "clearingJournalVoucherId",
    select: "voucherNumber voucherDate status",
  },
  {
    path: "bounceJournalVoucherId",
    select: "voucherNumber voucherDate status",
  },
];

const findChequeById = async (id, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Cheque.findOne({ _id: id, isDeleted: false })
    .populate(POPULATE_FIELDS)
    .session(options.session || null);
};

const findChequeByIdCompanyAndWorkspace = async (
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
  return Cheque.findOne({ _id: id, companyId, workspaceId, isDeleted: false })
    .populate(POPULATE_FIELDS)
    .session(options.session || null);
};

const findChequeByNumber = async (
  companyId,
  chequeNumber,
  chequeType,
  options = {},
) => {
  if (!mongoose.Types.ObjectId.isValid(companyId)) return null;
  return Cheque.findOne({
    companyId,
    chequeNumber: String(chequeNumber).trim().toUpperCase(),
    chequeType,
    isDeleted: false,
  }).session(options.session || null);
};

const createCheque = async (payload, options = {}) => {
  const [cheque] = await Cheque.create([payload], {
    session: options.session || null,
  });
  return cheque;
};

const getCheques = async (
  workspaceId,
  companyId,
  filters = {},
  options = {},
) => {
  const query = { workspaceId, isDeleted: false };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    query.companyId = companyId;
  }

  const resolvedChequeType = filters.chequeType || filters.type;
  if (resolvedChequeType) query.chequeType = resolvedChequeType;
  if (filters.status) query.status = filters.status;
  if (filters.bankAccountId) query.bankAccountId = filters.bankAccountId;
  if (filters.counterpartyAccountId)
    query.counterpartyAccountId = filters.counterpartyAccountId;

  if (filters.startDate || filters.endDate) {
    query.chequeDate = {};
    if (filters.startDate) query.chequeDate.$gte = new Date(filters.startDate);
    if (filters.endDate) query.chequeDate.$lte = new Date(filters.endDate);
  }

  if (filters.search) {
    const regex = new RegExp(filters.search.trim(), "i");
    query.$or = [
      { chequeNumber: regex },
      { partyName: regex },
      { narration: regex },
    ];
  }

  const sort = options.sort || { chequeDate: -1, createdAt: -1 };

  if (options.all === true) {
    const cheques = await Cheque.find(query)
      .populate(POPULATE_FIELDS)
      .sort(sort)
      .session(options.session || null);
    return { cheques, total: cheques.length };
  }

  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const skip = (page - 1) * limit;

  const [cheques, total] = await Promise.all([
    Cheque.find(query)
      .populate(POPULATE_FIELDS)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .session(options.session || null),
    Cheque.countDocuments(query).session(options.session || null),
  ]);

  return { cheques, total, page, limit };
};

export default {
  findChequeById,
  findChequeByIdCompanyAndWorkspace,
  findChequeByNumber,
  createCheque,
  getCheques,
};
