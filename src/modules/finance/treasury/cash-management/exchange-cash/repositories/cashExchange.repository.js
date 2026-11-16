import mongoose from "mongoose";
import CashExchange from "../models/cashExchange.model.js";

const POPULATE_CONFIG = [
  { path: "createdBy", select: "name email" },
  { path: "cancelledBy", select: "name email" },
  { path: "branchId", select: "name branchCode" },
];

// ---------------------------------------------------------------------------
// FIND BY ID (internal)
// ---------------------------------------------------------------------------
const findById = async (id, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return CashExchange.findOne({ _id: id, isDeleted: false })
    .populate(POPULATE_CONFIG)
    .session(options.session || null);
};

// ---------------------------------------------------------------------------
// FIND BY ID + COMPANY + WORKSPACE (controller-facing)
// ---------------------------------------------------------------------------
const findByIdCompanyAndWorkspace = async (
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
  return CashExchange.findOne({
    _id: id,
    companyId,
    workspaceId,
    isDeleted: false,
  })
    .populate(POPULATE_CONFIG)
    .session(options.session || null);
};

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------
const createCashExchange = async (payload, options = {}) => {
  const [cashExchange] = await CashExchange.create([payload], {
    session: options.session || null,
  });
  return cashExchange;
};

// ---------------------------------------------------------------------------
// LIST (with filters + pagination)
// ---------------------------------------------------------------------------
const getCashExchanges = async (
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

  if (filters.status) query.status = filters.status;
  if (filters.shiftId) query.shiftId = filters.shiftId;
  if (filters.branchId && filters.branchId !== "all") query.branchId = filters.branchId;

  if (filters.startDate || filters.endDate) {
    query.exchangeDate = {};
    if (filters.startDate) query.exchangeDate.$gte = new Date(filters.startDate);
    if (filters.endDate) query.exchangeDate.$lte = new Date(filters.endDate);
  }

  if (filters.search) {
    const searchRegex = new RegExp(filters.search.trim(), "i");
    query.$or = [
      { exchangeNumber: searchRegex },
      { narration: searchRegex },
      { notes: searchRegex },
    ];
  }

  const sort = options.sort || { exchangeDate: -1, createdAt: -1 };

  if (options.all === true) {
    const cashExchanges = await CashExchange.find(query)
      .populate(POPULATE_CONFIG)
      .sort(sort)
      .session(options.session || null);
    return { cashExchanges, total: cashExchanges.length };
  }

  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const skip = (page - 1) * limit;

  const [cashExchanges, total] = await Promise.all([
    CashExchange.find(query)
      .populate(POPULATE_CONFIG)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .session(options.session || null),
    CashExchange.countDocuments(query).session(options.session || null),
  ]);

  return { cashExchanges, total, page, limit };
};

// ---------------------------------------------------------------------------
// GENERATE NEXT EXCHANGE NUMBER: EX-YYYY-NNNNN
// ---------------------------------------------------------------------------
const getNextExchangeNumber = async (companyId, workspaceId, options = {}) => {
  const year = new Date().getFullYear();
  const prefix = `EX-${year}-`;

  const last = await CashExchange.findOne({
    companyId,
    workspaceId,
    exchangeNumber: { $regex: `^${prefix}` },
  })
    .sort({ exchangeNumber: -1 })
    .select("exchangeNumber")
    .session(options.session || null);

  let seq = 1;
  if (last) {
    const parts = last.exchangeNumber.split("-");
    const lastSeq = parseInt(parts[parts.length - 1]);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${String(seq).padStart(5, "0")}`;
};

export default {
  findById,
  findByIdCompanyAndWorkspace,
  createCashExchange,
  getCashExchanges,
  getNextExchangeNumber,
};
