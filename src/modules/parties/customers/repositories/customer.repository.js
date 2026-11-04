import Ledger from "../../../finance/ledger/models/ledger.model.js";
import mongoose from "mongoose";
import Customer from "../models/customer.model.js";
import { CUSTOMER_STATUS } from "../constants/customer.constant.js";

const findCustomerById = async (customerId, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(customerId)) {
    return null;
  }
  return Customer.findOne({
    _id: customerId,
    isDeleted: false,
  })
    .populate("branchId", "name")
    .select(options.select || "");
};

const findCustomerByIdCompanyAndWorkspace = async (
  customerId,
  companyId,
  workspaceId,
  options = {}
) => {
  if (
    !mongoose.Types.ObjectId.isValid(customerId) ||
    !mongoose.Types.ObjectId.isValid(companyId) ||
    !mongoose.Types.ObjectId.isValid(workspaceId)
  ) {
    return null;
  }

  return Customer.findOne({
    _id: customerId,
    companyId,
    workspaceId,
    isDeleted: false,
  })
    .populate("branchId", "name")
    .select(options.select || "");
};

const findCustomerByCode = async (customerCode, companyId = null, options = {}) => {
  if (!customerCode) {
    return null;
  }
  const query = {
    customerCode: String(customerCode).trim().toUpperCase(),
    isDeleted: false,
  };
  if (companyId) {
    query.companyId = companyId;
  }
  return Customer.findOne(query)
    .populate("branchId", "name")
    .select(options.select || "");
};

const findWalkInCustomer = async (companyId, workspaceId, options = {}) => {
  if (!companyId || !workspaceId) return null;
  return Customer.findOne({
    companyId,
    workspaceId,
    isWalkIn: true,
    isDeleted: false,
  })
    .populate("branchId", "name")
    .select(options.select || "")
    .session(options.session || null);
};

const createCustomer = async (payload, options = {}) => {
  const [customer] = await Customer.create([payload], { session: options.session || null });
  return customer;
};

const saveCustomer = async (customer) => {
  return customer.save();
};

const getCustomers = async (workspaceId, companyId, filters = {}, options = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    !mongoose.Types.ObjectId.isValid(companyId)
  ) {
    return { customers: [], total: 0, page: 1, limit: 20 };
  }

  const query = {
    workspaceId,
    companyId,
    isDeleted: false,
  };

  if (filters.isWalkIn !== undefined) {
    query.isWalkIn = filters.isWalkIn === true || filters.isWalkIn === "true";
  }

  if (filters.status) {
    query.status = filters.status;
  }

  if (filters.customerType) {
    if (filters.customerType.includes(",")) {
      query.customerType = { $in: filters.customerType.split(",").map((t) => t.trim()) };
    } else {
      query.customerType = filters.customerType;
    }
  }

  if (filters.customerCode) {
    query.customerCode = { $regex: new RegExp(filters.customerCode.trim(), "i") };
  }

  if (filters.gstNumber) {
    query.gstNumber = { $regex: new RegExp(filters.gstNumber.trim(), "i") };
  }

  if (filters.mobile) {
    query.mobile = { $regex: new RegExp(filters.mobile.trim(), "i") };
  }

  if (filters.name) {
    query.name = { $regex: new RegExp(filters.name.trim(), "i") };
  }

  if (filters.search) {
    const searchRegex = new RegExp(filters.search.trim(), "i");
    query.$or = [
      { name: searchRegex },
      { mobile: searchRegex },
      { customerCode: searchRegex },
    ];
  }

  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const skip = (page - 1) * limit;

  // Default to recently updated descending for pharmacy workflow, with createdAt fallback
  let baseSort = { updatedAt: -1, createdAt: -1 };
  if (options.sort) {
    if (typeof options.sort === "object") {
      baseSort = options.sort;
    } else if (typeof options.sort === "string") {
      const isDesc = options.sort.startsWith("-") || options.sort.endsWith(":desc");
      const cleanField = options.sort.replace(/^-/, "").replace(/:desc$|:asc$/, "").trim();
      baseSort = { [cleanField]: isDesc ? -1 : 1 };
    }
  }
  // Prioritize Walk-in customer first whenever it matches the query filters
  const sort = { isWalkIn: -1, ...baseSort };

  const [customers, total] = await Promise.all([
    Customer.find(query)
      .populate("branchId", "name")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select(options.select || ""),
    Customer.countDocuments(query),
  ]);

  // Calculate overall stats for the filtered query (ignoring pagination)
  const allFilteredCustomers = await Customer.find(query)
    .select('ledgerAccountId status openingBalance openingBalanceType advanceBalance creditOutstanding')
    .lean();
  
  const ledgerAccountIds = allFilteredCustomers
    .map(c => c.ledgerAccountId)
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
  let totalAdvance = 0;
  let active = 0;
  let inactive = 0;
  let blocked = 0;

  allFilteredCustomers.forEach(customer => {
    const s = (customer.status || "active").toLowerCase();
    if (s === "active") active++;
    else if (s === "inactive") inactive++;
    else if (s === "blocked") blocked++;

    totalAdvance += Number(customer.advanceBalance || 0);

    const l = ledgerMap[customer.ledgerAccountId?.toString()] || { totalDebit: 0, totalCredit: 0 };
    
    let totalDebit = l.totalDebit;
    let totalCredit = l.totalCredit;

    const opBal = Number(customer.openingBalance) || 0;
    const opBalType = (customer.openingBalanceType || "dr").toLowerCase(); // Customers usually have Dr balance

    if (opBalType === "dr") {
      totalDebit += opBal;
    } else {
      totalCredit += opBal;
    }

    // For customers (Sundry Debtors), Debit is positive balance, Credit is negative
    // But we just want the absolute totals of Cr and Dr
    const net = totalDebit - totalCredit; 
    if (net >= 0) {
      totalDr += net; // Positive means Dr
    } else {
      totalCr += Math.abs(net); // Negative means Cr
    }
  });

  const netRunning = totalDr - totalCr;
  const stats = { 
    totalCr, 
    totalDr, 
    totalAdvance,
    active, 
    inactive, 
    blocked,
    netRunning: Math.abs(netRunning),
    runningType: netRunning >= 0 ? "Dr" : "Cr"
  };

  const enrichedCustomers = customers.map(c => {
    const doc = c.toObject ? c.toObject() : c;
    const l = ledgerMap[doc.ledgerAccountId?.toString()] || { totalDebit: 0, totalCredit: 0 };
    const opBal = Number(doc.openingBalance) || 0;
    const opBalType = (doc.openingBalanceType || "dr").toLowerCase();

    let totalDebit = l.totalDebit;
    let totalCredit = l.totalCredit;

    if (opBalType === "dr") {
      totalDebit += opBal;
    } else {
      totalCredit += opBal;
    }

    const net = totalDebit - totalCredit;
    doc.outstandingAmount = Math.abs(net);
    doc.balanceType = net >= 0 ? "dr" : "cr";
    doc.advanceBalance = Number(doc.advanceBalance || 0);
    doc.creditOutstanding = Number(doc.creditOutstanding || 0);
    
    // We also attach a 'toSafeObject' mock if the service expects it, but since we return plain objects, we can just delete __v
    delete doc.__v;
    return doc;
  });

  return { customers: enrichedCustomers, total, page, limit, stats };
};

const deleteCustomerById = async (customerId, companyId, workspaceId, deletedBy) => {
  if (
    !mongoose.Types.ObjectId.isValid(customerId) ||
    !mongoose.Types.ObjectId.isValid(companyId) ||
    !mongoose.Types.ObjectId.isValid(workspaceId)
  ) {
    return null;
  }

  return Customer.findOneAndUpdate(
    {
      _id: customerId,
      companyId,
      workspaceId,
      isDeleted: false,
    },
    {
      isDeleted: true,
      status: CUSTOMER_STATUS.INACTIVE,
      deletedAt: new Date(),
      deletedBy,
    },
    {
      new: true,
      runValidators: true,
    }
  );
};

const insertManyCustomers = async (payloads) => {
  const BATCH_SIZE = 1000;
  let successful = 0;
  const writeErrors = [];
  
  for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
    const batch = payloads.slice(i, i + BATCH_SIZE);
    try {
      await Customer.insertMany(batch, { ordered: false });
      successful += batch.length;
    } catch (err) {
      if (err.writeErrors) {
        successful += (batch.length - err.writeErrors.length);
        writeErrors.push(...err.writeErrors);
      } else {
        throw err;
      }
    }
  }

  if (writeErrors.length > 0) {
    const error = new Error("Bulk insert failed for some records");
    error.writeErrors = writeErrors;
    throw error;
  }
  
  return { success: true };
};

export default {
  insertManyCustomers,
  findCustomerById,
  findCustomerByIdCompanyAndWorkspace,
  findCustomerByCode,
  createCustomer,
  saveCustomer,
  getCustomers,
  deleteCustomerById,
  findWalkInCustomer,
};
