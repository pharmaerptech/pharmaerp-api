import mongoose from "mongoose";
import AccountBalance from "../../account-balances/models/accountBalance.model.js";
import Account from "../../chart-of-accounts/models/account.model.js";
import Ledger from "../../ledger/models/ledger.model.js";

// ────────────────────────────────────────────────────────────────
// TRIAL BALANCE
// ────────────────────────────────────────────────────────────────

/**
 * Fetch all account balances and group them into a Trial Balance.
 * Each row: accountCode, accountName, nature, debitTotal, creditTotal, closingBalance, balanceType
 */
const getTrialBalance = async (workspaceId, companyId, filters = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    (companyId && !mongoose.Types.ObjectId.isValid(companyId))
  ) {
    return { rows: [], totalDebit: 0, totalCredit: 0, isBalanced: true };
  }

  const query = { workspaceId };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    query.companyId = companyId;
  }

  const balances = await AccountBalance.find(query)
    .populate({
      path: "accountId",
      select: "accountName accountCode accountNature accountCategory isDeleted status",
      match: { isDeleted: false },
    })
    .lean();

  const rows = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const b of balances) {
    // Skip if account was deleted or populate returned null
    if (!b.accountId) continue;

    const { includeZeroBalances } = filters;
    if (!includeZeroBalances && b.debitTotal === 0 && b.creditTotal === 0) continue;

    rows.push({
      accountId: b.accountId._id,
      accountCode: b.accountId.accountCode,
      accountName: b.accountId.accountName,
      accountNature: b.accountId.accountNature,
      accountCategory: b.accountId.accountCategory,
      debitTotal: b.debitTotal,
      creditTotal: b.creditTotal,
      closingBalance: b.balance,
      balanceType: b.balanceType,
    });

    totalDebit += b.debitTotal;
    totalCredit += b.creditTotal;
  }

  // Sort by accountCode for readability
  rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01;

  return { rows, totalDebit, totalCredit, isBalanced };
};

// ────────────────────────────────────────────────────────────────
// GENERAL LEDGER
// ────────────────────────────────────────────────────────────────

/**
 * Full transaction history across all accounts (or a single account).
 * Returns paginated ledger entries with running balance.
 */
const getGeneralLedger = async (workspaceId, companyId, query = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    (companyId && !mongoose.Types.ObjectId.isValid(companyId))
  ) {
    return { entries: [], total: 0, page: 1, limit: 50 };
  }

  const { accountId, startDate, endDate, page, limit, all } = query;

  const filter = { workspaceId };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    filter.companyId = companyId;
  }

  if (accountId && mongoose.Types.ObjectId.isValid(accountId)) {
    filter.accountId = accountId;
  }

  if (startDate || endDate) {
    filter.voucherDate = {};
    if (startDate) filter.voucherDate.$gte = new Date(startDate);
    if (endDate) filter.voucherDate.$lte = new Date(endDate);
  }

  const sort = { voucherDate: 1, createdAt: 1 };

  if (all === true || all === "true") {
    const entries = await Ledger.find(filter)
      .populate("accountId", "accountName accountCode accountNature accountCategory")
      .populate("voucherId", "voucherType referenceNumber narration status")
      .sort(sort)
      .lean();
    return { entries, total: entries.length };
  }

  const pg = Math.max(1, parseInt(page) || 1);
  const lim = Math.min(200, Math.max(1, parseInt(limit) || 50));
  const skip = (pg - 1) * lim;

  const [entries, total] = await Promise.all([
    Ledger.find(filter)
      .populate("accountId", "accountName accountCode accountNature accountCategory")
      .populate("voucherId", "voucherType referenceNumber narration status")
      .sort(sort)
      .skip(skip)
      .limit(lim)
      .lean(),
    Ledger.countDocuments(filter),
  ]);

  return { entries, total, page: pg, limit: lim };
};

// ────────────────────────────────────────────────────────────────
// CUSTOMER LEDGER
// ────────────────────────────────────────────────────────────────

/**
 * Statement of a specific customer account (or all customers).
 * Filters ledger entries by accountCategory = CUSTOMER.
 */
const getCustomerLedger = async (workspaceId, companyId, query = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    (companyId && !mongoose.Types.ObjectId.isValid(companyId))
  ) {
    return { entries: [], total: 0, page: 1, limit: 50 };
  }

  const { accountId, startDate, endDate, page, limit, all } = query;

  // Find all CUSTOMER accounts in this company/workspace
  const accountFilter = {
    workspaceId,
    accountCategory: "CUSTOMER",
    isDeleted: false,
  };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    accountFilter.companyId = companyId;
  }

  if (accountId && mongoose.Types.ObjectId.isValid(accountId)) {
    accountFilter._id = accountId;
  }

  const customerAccounts = await Account.find(accountFilter).select("_id").lean();
  const customerAccountIds = customerAccounts.map((a) => a._id);

  if (customerAccountIds.length === 0) {
    return { entries: [], total: 0, page: 1, limit: 50 };
  }

  const filter = { workspaceId, accountId: { $in: customerAccountIds } };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    filter.companyId = companyId;
  }

  if (startDate || endDate) {
    filter.voucherDate = {};
    if (startDate) filter.voucherDate.$gte = new Date(startDate);
    if (endDate) filter.voucherDate.$lte = new Date(endDate);
  }

  const sort = { voucherDate: 1, createdAt: 1 };

  if (all === true || all === "true") {
    const entries = await Ledger.find(filter)
      .populate("accountId", "accountName accountCode accountNature accountCategory")
      .populate("voucherId", "voucherType referenceNumber narration status")
      .sort(sort)
      .lean();
    return { entries, total: entries.length };
  }

  const pg = Math.max(1, parseInt(page) || 1);
  const lim = Math.min(200, Math.max(1, parseInt(limit) || 50));
  const skip = (pg - 1) * lim;

  const [entries, total] = await Promise.all([
    Ledger.find(filter)
      .populate("accountId", "accountName accountCode accountNature accountCategory")
      .populate("voucherId", "voucherType referenceNumber narration status")
      .sort(sort)
      .skip(skip)
      .limit(lim)
      .lean(),
    Ledger.countDocuments(filter),
  ]);

  return { entries, total, page: pg, limit: lim };
};

// ────────────────────────────────────────────────────────────────
// SUPPLIER LEDGER
// ────────────────────────────────────────────────────────────────

/**
 * Statement of a specific supplier account (or all suppliers).
 * Filters ledger entries by accountCategory = SUPPLIER.
 */
const getSupplierLedger = async (workspaceId, companyId, query = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    (companyId && !mongoose.Types.ObjectId.isValid(companyId))
  ) {
    return { entries: [], total: 0, page: 1, limit: 50 };
  }

  const { accountId, startDate, endDate, page, limit, all } = query;

  const accountFilter = {
    workspaceId,
    accountCategory: "SUPPLIER",
    isDeleted: false,
  };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    accountFilter.companyId = companyId;
  }

  if (accountId && mongoose.Types.ObjectId.isValid(accountId)) {
    accountFilter._id = accountId;
  }

  const supplierAccounts = await Account.find(accountFilter).select("_id").lean();
  const supplierAccountIds = supplierAccounts.map((a) => a._id);

  if (supplierAccountIds.length === 0) {
    return { entries: [], total: 0, page: 1, limit: 50 };
  }

  const filter = { workspaceId, accountId: { $in: supplierAccountIds } };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    filter.companyId = companyId;
  }

  if (startDate || endDate) {
    filter.voucherDate = {};
    if (startDate) filter.voucherDate.$gte = new Date(startDate);
    if (endDate) filter.voucherDate.$lte = new Date(endDate);
  }

  const sort = { voucherDate: 1, createdAt: 1 };

  if (all === true || all === "true") {
    const entries = await Ledger.find(filter)
      .populate("accountId", "accountName accountCode accountNature accountCategory")
      .populate("voucherId", "voucherType referenceNumber narration status")
      .sort(sort)
      .lean();
    return { entries, total: entries.length };
  }

  const pg = Math.max(1, parseInt(page) || 1);
  const lim = Math.min(200, Math.max(1, parseInt(limit) || 50));
  const skip = (pg - 1) * lim;

  const [entries, total] = await Promise.all([
    Ledger.find(filter)
      .populate("accountId", "accountName accountCode accountNature accountCategory")
      .populate("voucherId", "voucherType referenceNumber narration status")
      .sort(sort)
      .skip(skip)
      .limit(lim)
      .lean(),
    Ledger.countDocuments(filter),
  ]);

  return { entries, total, page: pg, limit: lim };
};

// ────────────────────────────────────────────────────────────────
// CASH BOOK
// ────────────────────────────────────────────────────────────────

/**
 * All cash inflows and outflows.
 * Filters ledger entries by accountCategory = CASH.
 */
const getCashBook = async (workspaceId, companyId, query = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    (companyId && !mongoose.Types.ObjectId.isValid(companyId))
  ) {
    return { entries: [], total: 0, page: 1, limit: 50, cashAccounts: [] };
  }

  const { accountId, startDate, endDate, page, limit, all } = query;

  const accountFilter = {
    workspaceId,
    accountCategory: "CASH",
    isDeleted: false,
  };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    accountFilter.companyId = companyId;
  }

  if (accountId && mongoose.Types.ObjectId.isValid(accountId)) {
    accountFilter._id = accountId;
  }

  const cashAccounts = await Account.find(accountFilter)
    .select("_id accountName accountCode")
    .lean();
  const cashAccountIds = cashAccounts.map((a) => a._id);

  if (cashAccountIds.length === 0) {
    return { entries: [], total: 0, page: 1, limit: 50, cashAccounts: [] };
  }

  const filter = { workspaceId, accountId: { $in: cashAccountIds } };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    filter.companyId = companyId;
  }

  if (startDate || endDate) {
    filter.voucherDate = {};
    if (startDate) filter.voucherDate.$gte = new Date(startDate);
    if (endDate) filter.voucherDate.$lte = new Date(endDate);
  }

  const sort = { voucherDate: 1, createdAt: 1 };

  if (all === true || all === "true") {
    const entries = await Ledger.find(filter)
      .populate("accountId", "accountName accountCode accountNature accountCategory")
      .populate("voucherId", "voucherType referenceNumber narration status")
      .sort(sort)
      .lean();
    return { entries, total: entries.length, cashAccounts };
  }

  const pg = Math.max(1, parseInt(page) || 1);
  const lim = Math.min(200, Math.max(1, parseInt(limit) || 50));
  const skip = (pg - 1) * lim;

  const [entries, total] = await Promise.all([
    Ledger.find(filter)
      .populate("accountId", "accountName accountCode accountNature accountCategory")
      .populate("voucherId", "voucherType referenceNumber narration status")
      .sort(sort)
      .skip(skip)
      .limit(lim)
      .lean(),
    Ledger.countDocuments(filter),
  ]);

  return { entries, total, page: pg, limit: lim, cashAccounts };
};

// ────────────────────────────────────────────────────────────────
// BANK BOOK
// ────────────────────────────────────────────────────────────────

/**
 * All bank transactions.
 * Filters ledger entries by accountCategory = BANK.
 */
const getBankBook = async (workspaceId, companyId, query = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    (companyId && !mongoose.Types.ObjectId.isValid(companyId))
  ) {
    return { entries: [], total: 0, page: 1, limit: 50, bankAccounts: [] };
  }

  const { accountId, startDate, endDate, page, limit, all } = query;

  const accountFilter = {
    workspaceId,
    accountCategory: "BANK",
    isDeleted: false,
  };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    accountFilter.companyId = companyId;
  }

  if (accountId && mongoose.Types.ObjectId.isValid(accountId)) {
    accountFilter._id = accountId;
  }

  const bankAccounts = await Account.find(accountFilter)
    .select("_id accountName accountCode")
    .lean();
  const bankAccountIds = bankAccounts.map((a) => a._id);

  if (bankAccountIds.length === 0) {
    return { entries: [], total: 0, page: 1, limit: 50, bankAccounts: [] };
  }

  const filter = { workspaceId, accountId: { $in: bankAccountIds } };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    filter.companyId = companyId;
  }

  if (startDate || endDate) {
    filter.voucherDate = {};
    if (startDate) filter.voucherDate.$gte = new Date(startDate);
    if (endDate) filter.voucherDate.$lte = new Date(endDate);
  }

  const sort = { voucherDate: 1, createdAt: 1 };

  if (all === true || all === "true") {
    const entries = await Ledger.find(filter)
      .populate("accountId", "accountName accountCode accountNature accountCategory")
      .populate("voucherId", "voucherType referenceNumber narration status")
      .sort(sort)
      .lean();
    return { entries, total: entries.length, bankAccounts };
  }

  const pg = Math.max(1, parseInt(page) || 1);
  const lim = Math.min(200, Math.max(1, parseInt(limit) || 50));
  const skip = (pg - 1) * lim;

  const [entries, total] = await Promise.all([
    Ledger.find(filter)
      .populate("accountId", "accountName accountCode accountNature accountCategory")
      .populate("voucherId", "voucherType referenceNumber narration status")
      .sort(sort)
      .skip(skip)
      .limit(lim)
      .lean(),
    Ledger.countDocuments(filter),
  ]);

  return { entries, total, page: pg, limit: lim, bankAccounts };
};

// ────────────────────────────────────────────────────────────────
// PROFIT & LOSS STATEMENT
// ────────────────────────────────────────────────────────────────

/**
 * Revenue minus Expenses = Net Profit or Net Loss.
 * Reads AccountBalance for INCOME and EXPENSE nature accounts.
 * If a date range is provided, sums ledger entries within the range instead.
 */
const getProfitLoss = async (workspaceId, companyId, filters = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    (companyId && !mongoose.Types.ObjectId.isValid(companyId))
  ) {
    return { income: [], expenses: [], totalIncome: 0, totalExpenses: 0, netProfit: 0 };
  }

  const { startDate, endDate } = filters;

  // Fetch INCOME and EXPENSE accounts
  const accountQuery = {
    workspaceId,
    accountNature: { $in: ["INCOME", "EXPENSE"] },
    isDeleted: false,
  };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    accountQuery.companyId = companyId;
  }
  const accounts = await Account.find(accountQuery)
    .select("_id accountName accountCode accountNature accountCategory")
    .lean();

  const accountIds = accounts.map((a) => a._id);

  if (accountIds.length === 0) {
    return { income: [], expenses: [], totalIncome: 0, totalExpenses: 0, netProfit: 0 };
  }

  let amountMap = {};

  if (startDate || endDate) {
    // Date-range mode: aggregate from Ledger
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    const matchQuery = {
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      accountId: { $in: accountIds },
      ...(Object.keys(dateFilter).length ? { voucherDate: dateFilter } : {}),
    };
    if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
      matchQuery.companyId = new mongoose.Types.ObjectId(companyId);
    }

    const aggregation = await Ledger.aggregate([
      {
        $match: matchQuery,
      },
      {
        $group: {
          _id: "$accountId",
          totalDebit: { $sum: "$debit" },
          totalCredit: { $sum: "$credit" },
        },
      },
    ]);

    for (const row of aggregation) {
      amountMap[row._id.toString()] = {
        debitTotal: row.totalDebit,
        creditTotal: row.totalCredit,
      };
    }
  } else {
    // No date range: use account balances (lifetime totals)
    const balanceQuery = {
      workspaceId,
      accountId: { $in: accountIds },
    };
    if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
      balanceQuery.companyId = companyId;
    }
    const balances = await AccountBalance.find(balanceQuery)
      .select("accountId debitTotal creditTotal")
      .lean();

    for (const b of balances) {
      amountMap[b.accountId.toString()] = {
        debitTotal: b.debitTotal,
        creditTotal: b.creditTotal,
      };
    }
  }

  const income = [];
  const expenses = [];
  let totalIncome = 0;
  let totalExpenses = 0;

  for (const account of accounts) {
    const amounts = amountMap[account._id.toString()] || { debitTotal: 0, creditTotal: 0 };
    // INCOME accounts: credit-nature → net = creditTotal - debitTotal
    // EXPENSE accounts: debit-nature → net = debitTotal - creditTotal
    let netAmount = 0;

    if (account.accountNature === "INCOME") {
      netAmount = amounts.creditTotal - amounts.debitTotal;
      income.push({
        accountId: account._id,
        accountCode: account.accountCode,
        accountName: account.accountName,
        accountCategory: account.accountCategory,
        amount: netAmount,
      });
      totalIncome += netAmount;
    } else if (account.accountNature === "EXPENSE") {
      netAmount = amounts.debitTotal - amounts.creditTotal;
      expenses.push({
        accountId: account._id,
        accountCode: account.accountCode,
        accountName: account.accountName,
        accountCategory: account.accountCategory,
        amount: netAmount,
      });
      totalExpenses += netAmount;
    }
  }

  income.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  expenses.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const netProfit = totalIncome - totalExpenses;

  return {
    income,
    expenses,
    totalIncome,
    totalExpenses,
    netProfit,
    isProfit: netProfit >= 0,
  };
};

// ────────────────────────────────────────────────────────────────
// BALANCE SHEET
// ────────────────────────────────────────────────────────────────

/**
 * Snapshot of Assets, Liabilities, and Equity as of a given date.
 * Assets = Liabilities + Equity + Retained Earnings (Net Profit)
 */
const getBalanceSheet = async (workspaceId, companyId, filters = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    (companyId && !mongoose.Types.ObjectId.isValid(companyId))
  ) {
    return { assets: [], liabilities: [], equity: [], totalAssets: 0, totalLiabilitiesAndEquity: 0 };
  }

  // Fetch ASSET, LIABILITY, EQUITY accounts
  const accountQuery = {
    workspaceId,
    accountNature: { $in: ["ASSET", "LIABILITY", "EQUITY"] },
    isDeleted: false,
  };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    accountQuery.companyId = companyId;
  }
  const accounts = await Account.find(accountQuery)
    .select("_id accountName accountCode accountNature accountCategory")
    .lean();

  const accountIds = accounts.map((a) => a._id);

  const balanceQuery = {
    workspaceId,
    accountId: { $in: accountIds },
  };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    balanceQuery.companyId = companyId;
  }
  const balances = await AccountBalance.find(balanceQuery)
    .select("accountId debitTotal creditTotal balance balanceType")
    .lean();

  const balanceMap = {};
  for (const b of balances) {
    balanceMap[b.accountId.toString()] = b;
  }

  const assets = [];
  const liabilities = [];
  const equity = [];
  let totalAssets = 0;
  let totalLiabilitiesAndEquity = 0;

  for (const account of accounts) {
    const b = balanceMap[account._id.toString()] || { debitTotal: 0, creditTotal: 0, balance: 0, balanceType: "dr" };

    let netAmount = 0;

    if (account.accountNature === "ASSET") {
      // Assets are debit-nature: debitTotal - creditTotal
      netAmount = b.debitTotal - b.creditTotal;
      assets.push({
        accountId: account._id,
        accountCode: account.accountCode,
        accountName: account.accountName,
        accountCategory: account.accountCategory,
        amount: netAmount,
      });
      totalAssets += netAmount;
    } else if (account.accountNature === "LIABILITY") {
      // Liabilities are credit-nature: creditTotal - debitTotal
      netAmount = b.creditTotal - b.debitTotal;
      liabilities.push({
        accountId: account._id,
        accountCode: account.accountCode,
        accountName: account.accountName,
        accountCategory: account.accountCategory,
        amount: netAmount,
      });
      totalLiabilitiesAndEquity += netAmount;
    } else if (account.accountNature === "EQUITY") {
      // Equity accounts: credit-nature
      netAmount = b.creditTotal - b.debitTotal;
      equity.push({
        accountId: account._id,
        accountCode: account.accountCode,
        accountName: account.accountName,
        accountCategory: account.accountCategory,
        amount: netAmount,
      });
      totalLiabilitiesAndEquity += netAmount;
    }
  }

  // Add Retained Earnings (Net Profit) to Equity side
  const plResult = await getProfitLoss(workspaceId, companyId, filters);
  const retainedEarnings = plResult.netProfit;
  totalLiabilitiesAndEquity += retainedEarnings;

  assets.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  liabilities.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  equity.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const isBalanced = Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.01;

  return {
    assets,
    liabilities,
    equity,
    retainedEarnings,
    totalAssets,
    totalLiabilitiesAndEquity,
    isBalanced,
  };
};

// ────────────────────────────────────────────────────────────────
// GST REPORT
// ────────────────────────────────────────────────────────────────

/**
 * GST summary from ledger entries on GST accounts.
 * GSTR1 = Output GST (Sales side)
 * GSTR2 = Input GST (Purchase side)
 * SUMMARY = Both combined
 */
const getGstReport = async (workspaceId, companyId, filters = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    (companyId && !mongoose.Types.ObjectId.isValid(companyId))
  ) {
    return { outputGst: [], inputGst: [], totalOutputGst: 0, totalInputGst: 0, netGstPayable: 0 };
  }

  const { startDate, endDate, type = "SUMMARY" } = filters;

  // Find all GST category accounts
  const accountQuery = {
    workspaceId,
    accountCategory: "GST",
    isDeleted: false,
  };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    accountQuery.companyId = companyId;
  }
  const gstAccounts = await Account.find(accountQuery)
    .select("_id accountName accountCode accountNature")
    .lean();

  if (gstAccounts.length === 0) {
    return { outputGst: [], inputGst: [], totalOutputGst: 0, totalInputGst: 0, netGstPayable: 0 };
  }

  const gstAccountIds = gstAccounts.map((a) => a._id);

  const dateFilter = {};
  if (startDate) dateFilter.$gte = new Date(startDate);
  if (endDate) dateFilter.$lte = new Date(endDate);

  const ledgerFilter = {
    workspaceId,
    accountId: { $in: gstAccountIds },
  };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    ledgerFilter.companyId = companyId;
  }

  if (Object.keys(dateFilter).length) {
    ledgerFilter.voucherDate = dateFilter;
  }

  const gstEntries = await Ledger.find(ledgerFilter)
    .populate("accountId", "accountName accountCode accountNature")
    .populate("voucherId", "voucherType referenceNumber narration status voucherDate voucherNumber")
    .sort({ voucherDate: 1, createdAt: 1 })
    .lean();

  const outputGst = []; // creditTotal > debitTotal → liability (collected from customer)
  const inputGst = [];  // debitTotal > creditTotal → asset (paid to supplier)

  // Aggregate per account
  const accountSummary = {};
  for (const entry of gstEntries) {
    const accId = entry.accountId._id.toString();
    if (!accountSummary[accId]) {
      accountSummary[accId] = {
        accountId: entry.accountId._id,
        accountCode: entry.accountId.accountCode,
        accountName: entry.accountId.accountName,
        accountNature: entry.accountId.accountNature,
        totalDebit: 0,
        totalCredit: 0,
        entries: [],
      };
    }
    accountSummary[accId].totalDebit += entry.debit || 0;
    accountSummary[accId].totalCredit += entry.credit || 0;
    accountSummary[accId].entries.push(entry);
  }

  let totalOutputGst = 0;
  let totalInputGst = 0;

  for (const summary of Object.values(accountSummary)) {
    const netCredit = summary.totalCredit - summary.totalDebit;

    if (netCredit >= 0) {
      // Output GST: credit-side dominant (LIABILITY)
      outputGst.push({ ...summary, netAmount: netCredit });
      totalOutputGst += netCredit;
    } else {
      // Input GST: debit-side dominant (ASSET / recoverable)
      const netDebit = summary.totalDebit - summary.totalCredit;
      inputGst.push({ ...summary, netAmount: netDebit });
      totalInputGst += netDebit;
    }
  }

  const netGstPayable = totalOutputGst - totalInputGst;

  const result = {
    totalOutputGst,
    totalInputGst,
    netGstPayable,
    netGstPayableType: netGstPayable >= 0 ? "PAYABLE" : "REFUNDABLE",
  };

  if (type === "GSTR1") {
    return { ...result, outputGst };
  } else if (type === "GSTR2") {
    return { ...result, inputGst };
  }

  return { ...result, outputGst, inputGst };
};

// ────────────────────────────────────────────────────────────────
export default {
  getTrialBalance,
  getGeneralLedger,
  getCustomerLedger,
  getSupplierLedger,
  getCashBook,
  getBankBook,
  getProfitLoss,
  getBalanceSheet,
  getGstReport,
};
