import mongoose from "mongoose";
import FundTransfer from "../models/fundTransfer.model.js";

const POPULATE_FROM = [
  { path: "fromBankAccountId", select: "accountName accountNumber bankMasterId" },
];

const POPULATE_TO = [
  { path: "toBankAccountId", select: "accountName accountNumber bankMasterId" },
];

const POPULATE_META = [
  { path: "journalVoucherId", select: "voucherNumber voucherDate status" },
  { path: "createdBy", select: "name email" },
  { path: "postedBy", select: "name email" },
  { path: "cancelledBy", select: "name email" },
];

const buildPopulate = () => [
  ...POPULATE_FROM,
  ...POPULATE_TO,
  ...POPULATE_META,
];

const findFundTransferById = async (id, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return FundTransfer.findOne({ _id: id, isDeleted: false })
    .populate(buildPopulate())
    .session(options.session || null);
};

const findFundTransferByIdCompanyAndWorkspace = async (
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
  return FundTransfer.findOne({
    _id: id,
    companyId,
    workspaceId,
    isDeleted: false,
  })
    .populate(buildPopulate())
    .session(options.session || null);
};

const createFundTransfer = async (payload, options = {}) => {
  const [fundTransfer] = await FundTransfer.create([payload], {
    session: options.session || null,
  });
  return fundTransfer;
};

const getFundTransfers = async (
  workspaceId,
  companyId,
  filters = {},
  options = {},
) => {
  const query = {
    workspaceId,
    isDeleted: false,
  };

  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    query.companyId = companyId;
  }

  if (filters.transferType) query.transferType = filters.transferType;
  if (filters.status) query.status = filters.status;

  if (filters.fromAccountType) query.fromAccountType = filters.fromAccountType;
  if (filters.toAccountType) query.toAccountType = filters.toAccountType;

  if (filters.startDate || filters.endDate) {
    query.transferDate = {};
    if (filters.startDate) query.transferDate.$gte = new Date(filters.startDate);
    if (filters.endDate) query.transferDate.$lte = new Date(filters.endDate);
  }

  if (filters.search) {
    const searchRegex = new RegExp(filters.search.trim(), "i");
    query.$or = [
      { transferNumber: searchRegex },
      { referenceNumber: searchRegex },
      { narration: searchRegex },
    ];
  }

  const sort = options.sort || { transferDate: -1, createdAt: -1 };

  if (options.all === true) {
    const fundTransfers = await FundTransfer.find(query)
      .populate(buildPopulate())
      .sort(sort)
      .session(options.session || null);
    return { fundTransfers, total: fundTransfers.length };
  }

  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const skip = (page - 1) * limit;

  const [fundTransfers, total] = await Promise.all([
    FundTransfer.find(query)
      .populate(buildPopulate())
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .session(options.session || null),
    FundTransfer.countDocuments(query).session(options.session || null),
  ]);

  return { fundTransfers, total, page, limit };
};

const getNextTransferNumber = async (companyId, workspaceId, options = {}) => {
  const year = new Date().getFullYear();
  const prefix = `FT-${year}-`;

  const last = await FundTransfer.findOne({
    companyId,
    workspaceId,
    transferNumber: { $regex: `^${prefix}` },
  })
    .sort({ transferNumber: -1 })
    .select("transferNumber")
    .session(options.session || null);

  let seq = 1;
  if (last) {
    const parts = last.transferNumber.split("-");
    const lastSeq = parseInt(parts[parts.length - 1]);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${String(seq).padStart(5, "0")}`;
};

export default {
  findFundTransferById,
  findFundTransferByIdCompanyAndWorkspace,
  createFundTransfer,
  getFundTransfers,
  getNextTransferNumber,
};
