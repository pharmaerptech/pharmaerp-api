import mongoose from "mongoose";
import BankDepositSlip from "../models/bankDepositSlip.model.js";
import {
  BANK_DEPOSIT_SLIP_NUMBER_PREFIX,
} from "../constants/bankDepositSlip.constant.js";

// ── Populate helpers ──────────────────────────────────────────────────────────

const POPULATE_ACCOUNTS = [
  {
    path: "toBankAccountId",
    select: "accountName accountNumber bankMasterId",
    populate: { path: "bankMasterId", select: "name code" },
  },
];

const POPULATE_DAY_CLOSING = [
  { path: "dayClosingId", select: "dayClosingNo date status" },
  { path: "businessDayId", select: "businessDayNo businessDate status" },
];

const POPULATE_JOURNALS = [
  { path: "preparationJournalVoucherId", select: "voucherNumber voucherDate status" },
  { path: "depositJournalVoucherId", select: "voucherNumber voucherDate status" },
];

const POPULATE_USERS = [
  { path: "createdBy", select: "name email" },
  { path: "depositedBy", select: "name email" },
  { path: "cancelledBy", select: "name email" },
];

const POPULATE_BRANCH = [
  { path: "branchId", select: "name code branchCode" },
];

const buildPopulate = () => [
  ...POPULATE_ACCOUNTS,
  ...POPULATE_BRANCH,
  ...POPULATE_DAY_CLOSING,
  ...POPULATE_JOURNALS,
  ...POPULATE_USERS,
];

// ── Find ──────────────────────────────────────────────────────────────────────

const findSlipById = async (id, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return BankDepositSlip.findOne({ _id: id, isDeleted: false })
    .populate(buildPopulate())
    .session(options.session || null);
};

const findSlipByIdCompanyAndWorkspace = async (
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
  return BankDepositSlip.findOne({
    _id: id,
    companyId,
    workspaceId,
    isDeleted: false,
  })
    .populate(buildPopulate())
    .session(options.session || null);
};

// ── Create ────────────────────────────────────────────────────────────────────

const createSlip = async (payload, options = {}) => {
  const [slip] = await BankDepositSlip.create([payload], {
    session: options.session || null,
  });
  return slip;
};

// ── List ──────────────────────────────────────────────────────────────────────

const getSlips = async (workspaceId, companyId, filters = {}, options = {}) => {
  const query = {
    workspaceId,
    companyId,
    isDeleted: false,
  };

  if (filters.status) query.status = filters.status;
  if (filters.fromCashAccountId) query.fromCashAccountId = filters.fromCashAccountId;
  if (filters.toBankAccountId) query.toBankAccountId = filters.toBankAccountId;
  if (filters.branchId && filters.branchId !== "all") query.branchId = filters.branchId;
  if (filters.dayClosingId) query.dayClosingId = filters.dayClosingId;
  if (filters.businessDayId) query.businessDayId = filters.businessDayId;

  if (filters.startDate || filters.endDate) {
    query.slipDate = {};
    if (filters.startDate) query.slipDate.$gte = new Date(filters.startDate);
    if (filters.endDate) query.slipDate.$lte = new Date(filters.endDate);
  }

  if (filters.search) {
    const searchRegex = new RegExp(filters.search.trim(), "i");
    query.$or = [
      { slipNumber: searchRegex },
      { depositBagReference: searchRegex },
      { bankBranchName: searchRegex },
      { bankReferenceNumber: searchRegex },
      { narration: searchRegex },
    ];
  }

  const sort = options.sort || { slipDate: -1, createdAt: -1 };

  if (options.all === true) {
    const slips = await BankDepositSlip.find(query)
      .populate(buildPopulate())
      .sort(sort)
      .session(options.session || null);
    return { slips, total: slips.length };
  }

  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const skip = (page - 1) * limit;

  const [slips, total] = await Promise.all([
    BankDepositSlip.find(query)
      .populate(buildPopulate())
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .session(options.session || null),
    BankDepositSlip.countDocuments(query).session(options.session || null),
  ]);

  return { slips, total, page, limit };
};

// ── Slip number generator ─────────────────────────────────────────────────────

const getNextSlipNumber = async (companyId, workspaceId, options = {}) => {
  const year = new Date().getFullYear();
  const prefix = `${BANK_DEPOSIT_SLIP_NUMBER_PREFIX}-${year}-`;

  const last = await BankDepositSlip.findOne({
    companyId,
    workspaceId,
    slipNumber: { $regex: `^${prefix}` },
  })
    .sort({ slipNumber: -1 })
    .select("slipNumber")
    .session(options.session || null);

  let seq = 1;
  if (last) {
    const parts = last.slipNumber.split("-");
    const lastSeq = parseInt(parts[parts.length - 1]);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${String(seq).padStart(5, "0")}`;
};

export default {
  findSlipById,
  findSlipByIdCompanyAndWorkspace,
  createSlip,
  getSlips,
  getNextSlipNumber,
};
