import mongoose from "mongoose";
import PurchaseBill from "../models/purchaseBill.model.js";

const createPurchaseBill = async (payload) => {
  return PurchaseBill.create(payload);
};

const findPurchaseBillById = async (billId, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(billId)) {
    return null;
  }
  return PurchaseBill.findOne({
    _id: billId,
    isDeleted: false,
  })
    .populate("supplierId", "businessName contactPerson mobile gstNumber")
    .select(options.select || "");
};

const findPurchaseBillByIdAndWorkspace = async (
  billId,
  workspaceId,
  companyId,
  options = {}
) => {
  if (
    !mongoose.Types.ObjectId.isValid(billId) ||
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    !mongoose.Types.ObjectId.isValid(companyId)
  ) {
    return null;
  }

  return PurchaseBill.findOne({
    _id: billId,
    workspaceId,
    companyId,
    isDeleted: false,
  })
    .populate("supplierId", "businessName contactPerson mobile gstNumber")
    .select(options.select || "");
};

const updatePurchaseBill = async (billId, workspaceId, companyId, payload) => {
  return PurchaseBill.findOneAndUpdate(
    { _id: billId, workspaceId, companyId, isDeleted: false },
    { $set: payload },
    { new: true }
  );
};

const getPurchaseBills = async (
  workspaceId,
  companyId,
  filters = {},
  pagination = {}
) => {
  const { page = 1, limit = 25, sort = "-createdAt" } = pagination;
  const skip = (Number(page) - 1) * Number(limit);

  const query = {
    workspaceId,
    companyId,
    isDeleted: false,
  };

  if (filters.supplierId) {
    query.supplierId = filters.supplierId;
  }

  if (filters.branchId && mongoose.Types.ObjectId.isValid(filters.branchId)) {
    query.branchId = filters.branchId;
  }

  if (filters.status) {
    query.status = filters.status;
  }

  if (filters.search) {
    query.invoiceNo = { $regex: filters.search, $options: "i" };
  }

  const [bills, total] = await Promise.all([
    PurchaseBill.find(query)
      .populate("supplierId", "businessName contactPerson mobile")
      .populate("branchId", "name branchCode")
      .sort(sort)
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    PurchaseBill.countDocuments(query),
  ]);

  return {
    bills,
    total,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(total / Number(limit)),
  };
};

const softDeletePurchaseBill = async (billId) => {
  return PurchaseBill.findByIdAndUpdate(
    billId,
    { isDeleted: true },
    { new: true }
  );
};

const getPurchaseHistory = async (productId, workspaceId, companyId, pagination = {}) => {
  const { page = 1, limit = 5 } = pagination;
  const skip = (Number(page) - 1) * Number(limit);

  const query = {
    workspaceId,
    companyId,
    isDeleted: false,
    "items.productId": new mongoose.Types.ObjectId(productId)
  };

  const [bills, total] = await Promise.all([
    PurchaseBill.find(query)
      .sort("-createdAt")
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    PurchaseBill.countDocuments(query),
  ]);

  // Extract just the item history for that product from the bills
  const history = bills.map((bill) => {
    const item = bill.items.find(i => String(i.productId) === String(productId));
    if (!item) return null;
    return {
      billId: bill._id,
      purchaseBillNo: bill.purchaseBillNo,
      invoiceDate: bill.invoiceDate,
      supplierId: bill.supplierId,
      ...item
    };
  }).filter(Boolean);

  return {
    data: history,
    total,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(total / Number(limit)),
  };
};

const getLatestBillByPrefix = async (companyId, workspaceId, prefix) => {
  return PurchaseBill.findOne({
    companyId: new mongoose.Types.ObjectId(companyId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    purchaseBillNo: { $regex: `^${prefix}` },
    isDeleted: false,
  })
    .sort({ purchaseBillNo: -1 })
    .select("purchaseBillNo")
    .lean();
};

const purchaseBillRepository = {
  createPurchaseBill,
  updatePurchaseBill,
  findPurchaseBillById,
  findPurchaseBillByIdAndWorkspace,
  getPurchaseBills,
  softDeletePurchaseBill,
  getPurchaseHistory,
  getLatestBillByPrefix,
};

export default purchaseBillRepository;
