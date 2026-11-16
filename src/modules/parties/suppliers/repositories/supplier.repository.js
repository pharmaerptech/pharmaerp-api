import Ledger from "../../../finance/ledger/models/ledger.model.js";
import mongoose from "mongoose";
import Supplier from "../models/supplier.model.js";
import { SUPPLIER_STATUS } from "../constants/supplier.constant.js";

const findSupplierById = async (supplierId, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(supplierId)) {
    return null;
  }
  return Supplier.findOne({
    _id: supplierId,
    isDeleted: false,
  })
    .populate("branchId", "name")
    .select(options.select || "");
};

const findSupplierByIdCompanyAndWorkspace = async (
  supplierId,
  companyId,
  workspaceId,
  options = {}
) => {
  if (
    !mongoose.Types.ObjectId.isValid(supplierId) ||
    !mongoose.Types.ObjectId.isValid(companyId) ||
    !mongoose.Types.ObjectId.isValid(workspaceId)
  ) {
    return null;
  }

  return Supplier.findOne({
    _id: supplierId,
    companyId,
    workspaceId,
    isDeleted: false,
  })
    .populate("branchId", "name")
    .select(options.select || "");
};

const findSupplierByCode = async (supplierCode, options = {}) => {
  if (!supplierCode) {
    return null;
  }
  return Supplier.findOne({
    supplierCode: String(supplierCode).trim().toUpperCase(),
    isDeleted: false,
  })
    .populate("branchId", "name")
    .select(options.select || "");
};

const createSupplier = async (payload) => {
  return Supplier.create(payload);
};

const saveSupplier = async (supplier) => {
  return supplier.save();
};

const buildSupplierQuery = (workspaceId, companyId, filters) => {
  const query = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
  };

  if (companyId) {
    query.companyId = new mongoose.Types.ObjectId(companyId);
  }

  if (filters.status) {
    query.status = filters.status;
  }

  if (filters.supplierType) {
    query.supplierType = filters.supplierType;
  }

  if (filters.supplierCode) {
    query.supplierCode = { $regex: new RegExp(filters.supplierCode.trim(), "i") };
  }

  if (filters.gstNumber) {
    query.gstNumber = { $regex: new RegExp(filters.gstNumber.trim(), "i") };
  }

  if (filters.mobile) {
    query.mobile = { $regex: new RegExp(filters.mobile.trim(), "i") };
  }

  if (filters.businessName) {
    query.businessName = { $regex: new RegExp(filters.businessName.trim(), "i") };
  }

  if (filters.search) {
    const searchRegex = new RegExp(filters.search.trim(), "i");
    query.$or = [
      { businessName: searchRegex },
      { mobile: searchRegex },
      { supplierCode: searchRegex },
    ];
  }
  
  return query;
};

const getSuppliers = async (workspaceId, companyId, filters = {}, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
    return { suppliers: [], total: 0, page: 1, limit: 20 };
  }
  if (companyId && !mongoose.Types.ObjectId.isValid(companyId)) {
    return { suppliers: [], total: 0, page: 1, limit: 20 };
  }

  const query = buildSupplierQuery(workspaceId, companyId, filters);

  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const skip = (page - 1) * limit;
  const sort = options.sort || { createdAt: -1 };

  const [suppliers, total] = await Promise.all([
    Supplier.find(query)
      .populate("branchId", "name")
      .populate("companyId", "name legalName code")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select(options.select || ""),
    Supplier.countDocuments(query),
  ]);

  return { suppliers, total, page, limit };
};

const getSuppliersStats = async (workspaceId, companyId, filters = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    !mongoose.Types.ObjectId.isValid(companyId)
  ) {
    return { total: 0, active: 0, inactive: 0, blocked: 0, totalCr: 0, totalDr: 0, netRunning: 0, runningType: "Cr" };
  }
  
  const query = buildSupplierQuery(workspaceId, companyId, filters);

  const suppliers = await Supplier.find(query)
    .select("ledgerAccountId status openingBalance openingBalanceType")
    .lean();

  const ledgerAccountIds = suppliers
    .map(s => s.ledgerAccountId)
    .filter(id => id != null);

  
  
  
  let ledgerStats = [];
  if (ledgerAccountIds.length > 0) {
    ledgerStats = await Ledger.aggregate([
      { $match: { accountId: { $in: ledgerAccountIds } } },
      {
        $group: {
          _id: "$accountId",
          totalDebit: { $sum: "$debit" },
          totalCredit: { $sum: "$credit" }
        }
      }
    ]);
  }

  const ledgerMap = {};
  ledgerStats.forEach(stat => {
    ledgerMap[stat._id.toString()] = stat;
  });

  let totalCr = 0;
  let totalDr = 0;
  let active = 0;
  let inactive = 0;
  let blocked = 0;

  suppliers.forEach(supplier => {
    const s = (supplier.status || "active").toLowerCase();
    if (s === "active") active++;
    else if (s === "inactive") inactive++;
    else if (s === "blocked") blocked++;

    const l = ledgerMap[supplier.ledgerAccountId?.toString()] || { totalDebit: 0, totalCredit: 0 };
    
    let totalDebit = l.totalDebit;
    let totalCredit = l.totalCredit;

    const opBal = Number(supplier.openingBalance) || 0;
    const opBalType = (supplier.openingBalanceType || "cr").toLowerCase();

    if (opBalType === "dr") {
      totalDebit += opBal;
    } else {
      totalCredit += opBal;
    }

    const net = totalCredit - totalDebit;
    if (net >= 0) {
      totalCr += net;
    } else {
      totalDr += Math.abs(net);
    }
  });

  const netRunning = totalCr - totalDr;
  return {
    total: suppliers.length,
    active,
    inactive,
    blocked,
    totalCr,
    totalDr,
    netRunning: Math.abs(netRunning),
    runningType: netRunning >= 0 ? "Cr" : "Dr"
  };
};

const deleteSupplierById = async (supplierId, companyId, workspaceId, deletedBy) => {
  if (
    !mongoose.Types.ObjectId.isValid(supplierId) ||
    !mongoose.Types.ObjectId.isValid(companyId) ||
    !mongoose.Types.ObjectId.isValid(workspaceId)
  ) {
    return null;
  }

  return Supplier.findOneAndUpdate(
    {
      _id: supplierId,
      companyId,
      workspaceId,
      isDeleted: false,
    },
    {
      isDeleted: true,
      status: SUPPLIER_STATUS.INACTIVE,
      deletedAt: new Date(),
      deletedBy,
    },
    {
      new: true,
      runValidators: true,
    }
  );
};


const insertManySuppliers = async (payloads) => {
  return Supplier.insertMany(payloads, { ordered: false });
};

export default {
  insertManySuppliers,
  findSupplierById,
  findSupplierByIdCompanyAndWorkspace,
  findSupplierByCode,
  createSupplier,
  saveSupplier,
  getSuppliers,
  getSuppliersStats,
  deleteSupplierById,
};
