import mongoose from "mongoose";
import BankAccount from "../models/bankAccount.model.js";

const findBankAccountById = async (id, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return BankAccount.findOne({ _id: id, isDeleted: false }).session(options.session || null);
};

const findBankAccountByIdCompanyAndWorkspace = async (id, companyId, workspaceId, options = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(id) ||
    !mongoose.Types.ObjectId.isValid(companyId) ||
    !mongoose.Types.ObjectId.isValid(workspaceId)
  ) {
    return null;
  }
  return BankAccount.findOne({
    _id: id,
    companyId,
    workspaceId,
    isDeleted: false,
  })
    .populate("bankMasterId", "name logoUrl")
    .populate("ledgerAccountId", "accountName accountCode status openingBalance openingBalanceType")
    .session(options.session || null);
};

const createBankAccount = async (payload, options = {}) => {
  const [bankAccount] = await BankAccount.create([payload], { session: options.session || null });
  return bankAccount;
};

const getBankAccounts = async (workspaceId, companyId, filters = {}, options = {}) => {
  const query = {
    workspaceId,
    isDeleted: false,
  };

  if (companyId) {
    query.companyId = companyId;
  }

  if (filters.isActive !== undefined) {
    query.isActive = filters.isActive === "true" || filters.isActive === true;
  }
  if (filters.isPrimary !== undefined) {
    query.isPrimary = filters.isPrimary === "true" || filters.isPrimary === true;
  }
  if (filters.bankMasterId) {
    query.bankMasterId = filters.bankMasterId;
  }

  if (filters.search) {
    const searchRegex = new RegExp(filters.search.trim(), "i");
    query.$or = [
      { accountName: searchRegex },
      { accountHolderName: searchRegex },
      { accountNumber: searchRegex },
      { branchName: searchRegex },
    ];
  }

  const sort = options.sort || { isPrimary: -1, createdAt: -1 };

  if (options.all === true) {
    const bankAccounts = await BankAccount.find(query)
      .populate("companyId", "name legalName code")
      .populate("bankMasterId", "name logoUrl")
      .populate("ledgerAccountId", "accountName accountCode status openingBalance openingBalanceType")
      .sort(sort)
      .session(options.session || null);
    return { bankAccounts, total: bankAccounts.length };
  }

  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const skip = (page - 1) * limit;

  const [bankAccounts, total] = await Promise.all([
    BankAccount.find(query)
      .populate("companyId", "name legalName code")
      .populate("bankMasterId", "name logoUrl")
      .populate("ledgerAccountId", "accountName accountCode status openingBalance openingBalanceType")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .session(options.session || null),
    BankAccount.countDocuments(query).session(options.session || null),
  ]);

  return { bankAccounts, total, page, limit };
};

const setPrimaryBankAccount = async (bankAccountId, companyId, workspaceId, options = {}) => {
  const session = options.session;
  // Set all other bank accounts to isPrimary = false
  await BankAccount.updateMany(
    { companyId, workspaceId, _id: { $ne: bankAccountId }, isDeleted: false },
    { $set: { isPrimary: false } },
    { session }
  );

  // Set this bank account to isPrimary = true
  const updated = await BankAccount.findOneAndUpdate(
    { _id: bankAccountId, companyId, workspaceId, isDeleted: false },
    { $set: { isPrimary: true } },
    { new: true, session }
  );

  return updated;
};

export default {
  findBankAccountById,
  findBankAccountByIdCompanyAndWorkspace,
  createBankAccount,
  getBankAccounts,
  setPrimaryBankAccount,
};
