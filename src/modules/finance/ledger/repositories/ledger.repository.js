import mongoose from "mongoose";
import Ledger from "../models/ledger.model.js";

const createLedgerEntry = async (payload, options = {}) => {
  const t = Date.now();
  const [entry] = await Ledger.create([payload], {
    session: options.session || null,
  });
  return entry;
};

const findLastLedgerEntry = async (
  workspaceId,
  companyId,
  accountId,
  options = {}
) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    !mongoose.Types.ObjectId.isValid(companyId) ||
    !mongoose.Types.ObjectId.isValid(accountId)
  ) {
    return null;
  }

  const t = Date.now();
  const res = await Ledger.findOne({
    workspaceId,
    companyId,
    accountId,
  })
    .sort({ voucherDate: -1, createdAt: -1 })
    .session(options.session || null);
  
  return res;
};

const deleteLedgerEntriesByVoucherId = async (voucherId, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(voucherId)) {
    return null;
  }

  return Ledger.deleteMany(
    { voucherId },
    {
      session: options.session || null,
    }
  );
};

const getLedgerEntries = async (
  workspaceId,
  companyId,
  accountId,
  filters = {},
  options = {}
) => {
  const Account = mongoose.model("Account");
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    (companyId && !mongoose.Types.ObjectId.isValid(companyId))
  ) {
    return { entries: [], total: 0, page: 1, limit: 20 };
  }

  const query = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
  };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    query.companyId = new mongoose.Types.ObjectId(companyId);
  }
  
  console.log("getLedgerEntries query:", query);

  if (accountId) {
    if (mongoose.Types.ObjectId.isValid(accountId)) {
      query.accountId = new mongoose.Types.ObjectId(accountId);
      console.log("getLedgerEntries adding accountId:", query.accountId);
    } else {
      console.log("getLedgerEntries invalid accountId:", accountId);
      return { entries: [], total: 0, page: 1, limit: 20 };
    }
  }

  if (filters.startDate || filters.endDate) {
    query.voucherDate = {};
    if (filters.startDate) {
      query.voucherDate.$gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      query.voucherDate.$lte = new Date(filters.endDate);
    }
  }

  // Branch isolation for Cash Accounts: STRICT whitelist approach
  if (filters.branchId) {
    const Account = mongoose.model("Account");
    const accountFilter = {
      isActive: true,
      accountCategory: "CASH",
    };
    if (query.companyId) {
      accountFilter.companyId = query.companyId;
    }
    const allCashAccounts = await Account.find(accountFilter).select("_id");
    const allCashAccountIds = allCashAccounts.map(a => a._id.toString());

    const BranchCash = mongoose.model("BranchCash");
    const targetBranchId = new mongoose.Types.ObjectId(filters.branchId);
    const branchCashFilter = {
      isActive: true,
      branchId: targetBranchId,
    };
    if (query.companyId) {
      branchCashFilter.companyId = query.companyId;
    }
    const validBranchCashAccounts = await BranchCash.find(branchCashFilter).select("ledgerAccountId");
    const validLedgerIds = validBranchCashAccounts
      .map(c => c.ledgerAccountId?.toString())
      .filter(Boolean);

    const invalidLedgerIds = allCashAccountIds
      .filter(id => !validLedgerIds.includes(id))
      .map(id => new mongoose.Types.ObjectId(id));

    if (invalidLedgerIds.length > 0) {
      if (query.accountId) {
        // If accountId is already requested, but it belongs to another branch, return empty!
        const requestedId = query.accountId.toString();
        if (invalidLedgerIds.some(id => id.toString() === requestedId)) {
          return { entries: [], total: 0, page: 1, limit: 20, totalDebit: 0, totalCredit: 0 };
        }
      } else {
        query.accountId = { $nin: invalidLedgerIds };
      }
    }
  }

  // Chronological sorting is default for ledgers
  const sort = options.sort || { voucherDate: 1, createdAt: 1 };

  if (options.all === true) {
    const entries = await Ledger.find(query)
      .populate("accountId", "accountName accountCode accountNature accountCategory")
      .populate("voucherId", "voucherType referenceNumber narration status")
      .sort(sort)
      .session(options.session || null);
    const aggregate = await Ledger.aggregate([
      { $match: query },
      { $group: { _id: null, totalDebit: { $sum: "$debit" }, totalCredit: { $sum: "$credit" } } }
    ]);
    const totalDebit = aggregate[0]?.totalDebit || 0;
    const totalCredit = aggregate[0]?.totalCredit || 0;
    
    if (entries.length > 0 && query.accountId) {
      let currentBalance = 0;
      const account = await Account.findById(query.accountId).session(options.session || null);
      if (account) {
        const isAssetOrExpense = ["ASSET", "EXPENSE"].includes(account.accountNature);
        const hasOB = entries.some(e => e.voucherNumber && e.voucherNumber.startsWith("OB-"));
        const opBal = hasOB ? 0 : (account.openingBalance || 0);
        
        if (isAssetOrExpense) {
          currentBalance = account.openingBalanceType === "dr" ? opBal : -opBal;
        } else {
          currentBalance = account.openingBalanceType === "cr" ? opBal : -opBal;
        }
        
        for (const entry of entries) {
          if (isAssetOrExpense) {
            currentBalance += (entry.debit || 0) - (entry.credit || 0);
          } else {
            currentBalance += (entry.credit || 0) - (entry.debit || 0);
          }
          entry.runningBalance = currentBalance;
        }
      }
    }

    return { entries, total: entries.length, totalDebit, totalCredit };
  }

  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const skip = (page - 1) * limit;

  const [entries, total, aggregate] = await Promise.all([
    Ledger.find(query)
      .populate("accountId", "accountName accountCode accountNature accountCategory")
      .populate("voucherId", "voucherType referenceNumber narration status")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .session(options.session || null),
    Ledger.countDocuments(query).session(options.session || null),
    Ledger.aggregate([
      { $match: query },
      { $group: { _id: null, totalDebit: { $sum: "$debit" }, totalCredit: { $sum: "$credit" } } }
    ])
  ]);

  const totalDebit = aggregate[0]?.totalDebit || 0;
  const totalCredit = aggregate[0]?.totalCredit || 0;

  if (entries.length > 0 && query.accountId) {
    const firstEntry = entries[0];
    const beforeQuery = { ...query };
    beforeQuery.$or = [
      { voucherDate: { $lt: firstEntry.voucherDate } },
      { voucherDate: firstEntry.voucherDate, createdAt: { $lt: firstEntry.createdAt } }
    ];
    
    const beforeAgg = await Ledger.aggregate([
      { $match: beforeQuery },
      { $group: { _id: null, totalDebit: { $sum: "$debit" }, totalCredit: { $sum: "$credit" } } }
    ]).session(options.session || null);
    
    let currentBalance = 0;
    const account = await Account.findById(query.accountId).session(options.session || null);
    
    if (account) {
      const isAssetOrExpense = ["ASSET", "EXPENSE"].includes(account.accountNature);
      
      const hasOB = entries.some(e => e.voucherNumber && e.voucherNumber.startsWith("OB-"));
      // if OB is on this page, or was in before entries... wait, this is tricky.
      // Better to check if OB exists in DB before this point.
      const obEntry = await Ledger.findOne({ ...query, voucherNumber: { $regex: /^OB-/ } }).session(options.session || null);
      const opBal = obEntry ? 0 : (account.openingBalance || 0);
      
      if (isAssetOrExpense) {
        currentBalance = account.openingBalanceType === "dr" ? opBal : -opBal;
      } else {
        currentBalance = account.openingBalanceType === "cr" ? opBal : -opBal;
      }
      
      if (beforeAgg.length > 0) {
        if (isAssetOrExpense) {
          currentBalance += (beforeAgg[0].totalDebit || 0) - (beforeAgg[0].totalCredit || 0);
        } else {
          currentBalance += (beforeAgg[0].totalCredit || 0) - (beforeAgg[0].totalDebit || 0);
        }
      }
      
      for (const entry of entries) {
        if (isAssetOrExpense) {
          currentBalance += (entry.debit || 0) - (entry.credit || 0);
        } else {
          currentBalance += (entry.credit || 0) - (entry.debit || 0);
        }
        entry.runningBalance = currentBalance;
      }
    }
  }

  return { entries, total, page, limit, totalDebit, totalCredit };
};

export default {
  createLedgerEntry,
  findLastLedgerEntry,
  deleteLedgerEntriesByVoucherId,
  getLedgerEntries,
};
