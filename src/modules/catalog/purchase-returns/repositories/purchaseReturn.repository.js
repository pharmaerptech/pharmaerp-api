import mongoose from "mongoose";
import PurchaseReturn from "../models/purchaseReturn.model.js";
import "../../../parties/suppliers/models/supplier.model.js";
import "../../../organization/branches/models/branch.model.js";

/**
 * Create a new purchase return record
 */
const createPurchaseReturn = async (returnData, options = {}) => {
  const purchaseReturn = new PurchaseReturn(returnData);
  return purchaseReturn.save({ session: options.session || null });
};

/**
 * Find single purchase return by ID or return number
 */
const findPurchaseReturnById = async (
  returnId,
  companyId,
  workspaceId,
  session = null
) => {
  const isObjectId = mongoose.Types.ObjectId.isValid(returnId);
  const targetIdFilter = isObjectId
    ? {
        $or: [
          { _id: new mongoose.Types.ObjectId(returnId) },
          { returnNo: returnId },
          { debitNoteNo: returnId },
          { creditNoteNo: returnId },
        ],
      }
    : {
        $or: [
          { returnNo: returnId },
          { debitNoteNo: returnId },
          { creditNoteNo: returnId },
        ],
      };

  const query = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
    $and: [
      {
        $or: [
          { companyId: new mongoose.Types.ObjectId(companyId) },
          { "shippingDetails.destinationCompanyId": new mongoose.Types.ObjectId(companyId) },
        ],
      },
      targetIdFilter,
    ],
  };

  const queryBuilder = PurchaseReturn.findOne(query)
    .populate("companyId", "name legalName gstin code")
    .populate(
      "supplierId",
      "businessName contactPerson mobile email gstNumber address drugLicenseNumber"
    )
    .populate("branchId", "name branchCode address")
    .populate("sourceBranchId", "name branchCode address")
    .populate("shippingDetails.destinationCompanyId", "name legalName gstin")
    .populate("shippingDetails.destinationBranchId", "name branchCode address phone")
    .populate("shippingDetails.destinationSupplierId", "businessName name contactPerson mobile phone gstNumber address")
    .populate("shippingDetails.dispatchedBy", "name email")
    .populate("shippingDetails.receivedBy", "name email")
    .populate("createdBy", "name email")
    .lean();

  if (session) {
    queryBuilder.session(session);
  }

  return queryBuilder.exec();
};

/**
 * Query purchase returns with pagination, filters, and sorting
 */
const findPurchaseReturns = async (query = {}, options = {}) => {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.max(1, parseInt(options.limit, 10) || 50);
  const skip = (page - 1) * limit;
  const sort = options.sort || { returnDate: -1, createdAt: -1 };

  const [data, total] = await Promise.all([
    PurchaseReturn.find(query)
      .populate("companyId", "name legalName gstin code")
      .populate(
        "supplierId",
        "businessName contactPerson mobile gstNumber drugLicenseNumber"
      )
      .populate("branchId", "name branchCode address")
      .populate("sourceBranchId", "name branchCode address")
      .populate("shippingDetails.destinationCompanyId", "name legalName gstin")
      .populate("shippingDetails.destinationBranchId", "name branchCode address phone")
    .populate("shippingDetails.destinationSupplierId", "businessName name contactPerson mobile phone gstNumber address")
      .populate("shippingDetails.receivedBy", "name")
      .populate("createdBy", "name")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    PurchaseReturn.countDocuments(query),
  ]);

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

/**
 * Update purchase return
 */
const updatePurchaseReturn = async (
  returnId,
  companyId,
  workspaceId,
  updateData,
  session = null
) => {
  const options = { new: true, runValidators: true };
  if (session) options.session = session;

  return PurchaseReturn.findOneAndUpdate(
    {
      _id: returnId,
      companyId: new mongoose.Types.ObjectId(companyId),
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      isDeleted: false,
    },
    { $set: updateData },
    options
  );
};

/**
 * Generate sequential return number (e.g. PR-2026-0001)
 */
const generateNextReturnNo = async (companyId, workspaceId, branchCode = "BR01") => {
  const year = new Date().getFullYear();
  const prefix = `PR-${branchCode}-${year}-`;

  const latest = await PurchaseReturn.findOne({
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    companyId: new mongoose.Types.ObjectId(companyId),
    returnNo: { $regex: `^${prefix}` },
  })
    .sort({ returnNo: -1 })
    .select("returnNo")
    .lean();

  let nextSequence = 1;
  if (latest && latest.returnNo) {
    const parts = latest.returnNo.split("-");
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) {
      nextSequence = lastSeq + 1;
    }
  }

  return `${prefix}${String(nextSequence).padStart(4, "0")}`;
};

/**
 * Generate sequential debit note number (e.g. DN-2026-0001)
 */
const generateNextDebitNoteNo = async (companyId, workspaceId, branchCode = "BR01") => {
  const year = new Date().getFullYear();
  const prefix = `DN-${branchCode}-${year}-`;

  const latest = await PurchaseReturn.findOne({
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    companyId: new mongoose.Types.ObjectId(companyId),
    debitNoteNo: { $regex: `^${prefix}` },
  })
    .sort({ debitNoteNo: -1 })
    .select("debitNoteNo")
    .lean();

  let nextSequence = 1;
  if (latest && latest.debitNoteNo) {
    const parts = latest.debitNoteNo.split("-");
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) {
      nextSequence = lastSeq + 1;
    }
  }

  return `${prefix}${String(nextSequence).padStart(4, "0")}`;
};

/**
 * Generate sequential credit note number for inter-branch returns (e.g. CN-BR01-2026-0001)
 */
const generateNextCreditNoteNo = async (companyId, workspaceId, branchCode = "BR01") => {
  const year = new Date().getFullYear();
  const prefix = `CN-${branchCode}-${year}-`;

  const latest = await PurchaseReturn.findOne({
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    companyId: new mongoose.Types.ObjectId(companyId),
    creditNoteNo: { $regex: `^${prefix}` },
  })
    .sort({ creditNoteNo: -1 })
    .select("creditNoteNo")
    .lean();

  let nextSequence = 1;
  if (latest && latest.creditNoteNo) {
    const parts = latest.creditNoteNo.split("-");
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) {
      nextSequence = lastSeq + 1;
    }
  }

  return `${prefix}${String(nextSequence).padStart(4, "0")}`;
};

/**
 * Get all confirmed returns referencing a specific purchase bill
 */
const getReturnsForBill = async (purchaseBillId, workspaceId) => {
  return PurchaseReturn.find({
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    "items.purchaseBillId": new mongoose.Types.ObjectId(purchaseBillId),
    status: { $ne: "CANCELLED" },
    isDeleted: false,
  })
    .select("items returnNo debitNoteNo returnDate status")
    .lean();
};

const purchaseReturnRepository = {
  createPurchaseReturn,
  findPurchaseReturnById,
  findPurchaseReturns,
  updatePurchaseReturn,
  generateNextReturnNo,
  generateNextDebitNoteNo,
  generateNextCreditNoteNo,
  getReturnsForBill,
};

export default purchaseReturnRepository;

