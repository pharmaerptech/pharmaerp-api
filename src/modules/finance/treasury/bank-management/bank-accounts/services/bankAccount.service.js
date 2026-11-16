import mongoose from "mongoose";
import ApiError from "../../../../../../utils/ApiError.js";
import bankAccountRepository from "../repositories/bankAccount.repository.js";
import BankMaster from "../../../../../platform/global-catalog/bank-master/models/bankMaster.model.js";
import accountGroupRepository from "../../../../chart-of-accounts/repositories/accountGroup.repository.js";
import accountRepository from "../../../../chart-of-accounts/repositories/account.repository.js";
import Account from "../../../../chart-of-accounts/models/account.model.js";
import JournalLine from "../../../../journal-vouchers/models/journalLine.model.js";
import openingBalanceService from "../../../../opening-balances/services/openingBalance.service.js";
import accountBalanceRepository from "../../../../account-balances/repositories/accountBalance.repository.js";

const createBankAccount = async (workspaceId, companyId, userId, payload) => {
  const {
    bankMasterId,
    accountName,
    accountHolderName,
    accountNumber,
    ifscCode,
    branchName,
    branchAddress,
    registeredMobile,
    accountType,
    isPrimary,
    openingBalance = 0,
    openingBalanceType = "dr",
  } = payload;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Verify BankMaster exists and is active
    const bankMaster = await BankMaster.findOne({
      _id: bankMasterId,
      isActive: true,
    }).session(session);
    if (!bankMaster) {
      throw new ApiError(400, "Invalid or inactive Bank Master specified");
    }

    // 2. Check duplicate account number for active bank accounts in this company
    const existingBankAccount = await mongoose
      .model("BankAccount")
      .findOne({
        companyId,
        accountNumber: String(accountNumber).trim(),
        isDeleted: false,
      })
      .session(session);

    if (existingBankAccount) {
      throw new ApiError(
        400,
        "Bank account number already registered for this company",
      );
    }

    // 3. Find or create standard "Bank Accounts" group under Assets
    let bankGroup = await accountGroupRepository.findGroupByCode(
      companyId,
      "BANK_ACCOUNTS",
      { session },
    );
    if (!bankGroup) {
      bankGroup = await accountGroupRepository.createGroup(
        {
          workspaceId,
          companyId,
          groupCode: "BANK_ACCOUNTS",
          groupName: "Bank Accounts",
          parentGroupId: null,
          nature: "ASSET",
          isSystemGroup: true,
          createdBy: userId,
        },
        { session },
      );
    }

    // 4. Generate unique accountCode for Ledger Account
    const baseCode = `BNK-${accountNumber.slice(-6).toUpperCase()}`;
    let accountCode = baseCode;
    let counter = 1;
    let existingAccount = await accountRepository.findAccountByCode(
      companyId,
      accountCode,
      { session },
    );
    while (existingAccount) {
      accountCode = `${baseCode}-${counter}`;
      existingAccount = await accountRepository.findAccountByCode(
        companyId,
        accountCode,
        { session },
      );
      counter++;
    }

    // 5. Create the system Asset account in the Chart of Accounts
    const ledgerAccount = await accountRepository.createAccount(
      {
        workspaceId,
        companyId,
        accountCode,
        accountName: `${bankMaster.name} - ${accountName} (${accountNumber.slice(-4)})`,
        accountGroupId: bankGroup._id,
        accountNature: "ASSET",
        accountCategory: "BANK",
        openingBalance: openingBalance || 0,
        openingBalanceType: openingBalanceType || "dr",
        status: "active",
        isSystemAccount: true,
        createdBy: userId,
      },
      { session },
    );

    // 6. Save Bank Account
    const bankAccountPayload = {
      workspaceId,
      companyId,
      bankMasterId,
      accountName,
      accountHolderName,
      accountNumber: String(accountNumber).trim(),
      ifscCode,
      branchName,
      branchAddress: branchAddress || null,
      registeredMobile: registeredMobile || null,
      accountType: accountType || "CURRENT",
      ledgerAccountId: ledgerAccount._id,
      isPrimary: !!isPrimary,
      createdBy: userId,
    };

    const bankAccount = await bankAccountRepository.createBankAccount(
      bankAccountPayload,
      { session },
    );

    // 7. If isPrimary is true, update other bank accounts in the company to false
    if (isPrimary) {
      await bankAccountRepository.setPrimaryBankAccount(
        bankAccount._id,
        companyId,
        workspaceId,
        { session },
      );
      bankAccount.isPrimary = true;
    } else {
      // If this is the only active bank account, automatically make it primary
      const activeCount = await mongoose
        .model("BankAccount")
        .countDocuments({
          companyId,
          isDeleted: false,
        })
        .session(session);

      if (activeCount === 1) {
        bankAccount.isPrimary = true;
        await bankAccountRepository.setPrimaryBankAccount(
          bankAccount._id,
          companyId,
          workspaceId,
          { session },
        );
      }
    }

    // 8. If opening balance is provided, post an opening balance journal entry
    //    This will create ledger entries + update account balance for the linked ledger account
    if (openingBalance && openingBalance > 0) {
      await openingBalanceService.postOpeningBalanceJournal(
        workspaceId,
        companyId,
        userId,
        ledgerAccount._id,
        openingBalance,
        openingBalanceType,
        { session },
      );
    }

    await session.commitTransaction();
    session.endSession();

    return getBankAccountById(bankAccount._id, companyId, workspaceId);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

const getBankAccounts = async (workspaceId, companyId, query = {}) => {
  const { page, limit, sort, all, ...filters } = query;
  const result = await bankAccountRepository.getBankAccounts(
    workspaceId,
    companyId,
    filters,
    { page, limit, sort, all: all === "true" || all === true },
  );

  const bankAccountsWithBalance = await Promise.all(
    result.bankAccounts.map(async (b) => {
      const ledgerAccountId = b.ledgerAccountId?._id || b.ledgerAccountId;
      let balance = 0;
      if (ledgerAccountId) {
        const targetCompanyId = b.companyId?._id || b.companyId || companyId;
        const accountBalanceObj = await accountBalanceRepository.findBalanceByAccountId(
          ledgerAccountId,
          targetCompanyId,
          workspaceId
        );
        if (accountBalanceObj) {
          const bal = accountBalanceObj.balance || 0;
          const balType = (accountBalanceObj.balanceType || "dr").toLowerCase();
          balance = balType === "dr" ? bal : -bal;
        } else {
          // Fallback to opening balance
          const ledgerAccount = b.ledgerAccountId;
          if (ledgerAccount && typeof ledgerAccount === "object") {
            const opBal = ledgerAccount.openingBalance || 0;
            const opType = (ledgerAccount.openingBalanceType || "dr").toLowerCase();
            balance = opType === "dr" ? opBal : -opBal;
          }
        }
      }
      return {
        ...b.toSafeObject(),
        balance,
      };
    })
  );

  return {
    bankAccounts: bankAccountsWithBalance,
    total: result.total,
    page: result.page,
    limit: result.limit,
  };
};

const getBankAccountById = async (id, companyId, workspaceId) => {
  const bankAccount =
    await bankAccountRepository.findBankAccountByIdCompanyAndWorkspace(
      id,
      companyId,
      workspaceId,
    );
  if (!bankAccount) {
    throw new ApiError(404, "Bank Account not found");
  }

  const ledgerAccountId = bankAccount.ledgerAccountId?._id || bankAccount.ledgerAccountId;
  let balance = 0;
  if (ledgerAccountId) {
    const accountBalanceObj = await accountBalanceRepository.findBalanceByAccountId(
      ledgerAccountId,
      companyId,
      workspaceId
    );
    if (accountBalanceObj) {
      const bal = accountBalanceObj.balance || 0;
      const balType = (accountBalanceObj.balanceType || "dr").toLowerCase();
      balance = balType === "dr" ? bal : -bal;
    } else {
      // Fallback to opening balance
      const ledgerAccount = bankAccount.ledgerAccountId;
      if (ledgerAccount && typeof ledgerAccount === "object") {
        const opBal = ledgerAccount.openingBalance || 0;
        const opType = (ledgerAccount.openingBalanceType || "dr").toLowerCase();
        balance = opType === "dr" ? opBal : -opBal;
      }
    }
  }

  return {
    ...bankAccount.toSafeObject(),
    balance,
  };
};

const updateBankAccount = async (
  id,
  companyId,
  workspaceId,
  userId,
  payload,
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const bankAccount = await mongoose
      .model("BankAccount")
      .findOne({
        _id: id,
        companyId,
        workspaceId,
        isDeleted: false,
      })
      .session(session);

    if (!bankAccount) {
      throw new ApiError(404, "Bank Account not found");
    }

    const {
      accountName,
      accountHolderName,
      ifscCode,
      branchName,
      branchAddress,
      registeredMobile,
      accountType,
      isActive,
      isPrimary,
    } = payload;

    if (accountName !== undefined) {
      bankAccount.accountName = accountName;
      // Sync name of ledger account as well
      const bankMaster = await BankMaster.findById(
        bankAccount.bankMasterId,
      ).session(session);
      await Account.updateOne(
        { _id: bankAccount.ledgerAccountId },
        {
          $set: {
            accountName: `${bankMaster.name} - ${accountName} (${bankAccount.accountNumber.slice(-4)})`,
          },
        },
      ).session(session);
    }

    if (accountHolderName !== undefined)
      bankAccount.accountHolderName = accountHolderName;
    if (ifscCode !== undefined) bankAccount.ifscCode = ifscCode;
    if (branchName !== undefined) bankAccount.branchName = branchName;
    if (branchAddress !== undefined)
      bankAccount.branchAddress = branchAddress || null;
    if (registeredMobile !== undefined)
      bankAccount.registeredMobile = registeredMobile || null;
    if (accountType !== undefined) bankAccount.accountType = accountType;

    if (isActive !== undefined) {
      bankAccount.isActive = !!isActive;
      // Sync status to the ledger account
      const ledgerStatus = !!isActive ? "active" : "inactive";
      await Account.updateOne(
        { _id: bankAccount.ledgerAccountId },
        { $set: { status: ledgerStatus } },
      ).session(session);
    }

    await bankAccount.save({ session });

    if (isPrimary === true) {
      await bankAccountRepository.setPrimaryBankAccount(
        bankAccount._id,
        companyId,
        workspaceId,
        { session },
      );
      bankAccount.isPrimary = true;
    }

    await session.commitTransaction();
    session.endSession();

    return getBankAccountById(bankAccount._id, companyId, workspaceId);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

const deleteBankAccount = async (id, companyId, workspaceId, userId) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const bankAccount = await mongoose
      .model("BankAccount")
      .findOne({
        _id: id,
        companyId,
        workspaceId,
        isDeleted: false,
      })
      .session(session);

    if (!bankAccount) {
      throw new ApiError(404, "Bank Account not found");
    }

    // 1. Audit check: Ensure there are no posted entries referencing the linked ledger account
    const transactionExists = await JournalLine.exists({
      accountId: bankAccount.ledgerAccountId,
    }).session(session);
    if (transactionExists) {
      throw new ApiError(
        400,
        "Cannot delete bank account because it has active ledger transactions",
      );
    }

    // 2. Soft-delete the bank account record
    bankAccount.isDeleted = true;
    bankAccount.deletedAt = new Date();
    bankAccount.deletedBy = userId;
    bankAccount.isPrimary = false; // Cannot be primary if deleted
    await bankAccount.save({ session });

    // 3. Soft-delete the associated system ledger account
    await Account.updateOne(
      { _id: bankAccount.ledgerAccountId },
      {
        $set: {
          isDeleted: true,
          status: "inactive",
          deletedAt: new Date(),
          deletedBy: userId,
        },
      },
    ).session(session);

    // 4. Auto-resolve primary toggle if we just deleted the primary bank account
    if (bankAccount.isPrimary) {
      const nextBankAccount = await mongoose
        .model("BankAccount")
        .findOne({
          companyId,
          isDeleted: false,
        })
        .session(session);

      if (nextBankAccount) {
        await bankAccountRepository.setPrimaryBankAccount(
          nextBankAccount._id,
          companyId,
          workspaceId,
          { session },
        );
      }
    }

    await session.commitTransaction();
    session.endSession();

    return { success: true };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

export default {
  createBankAccount,
  getBankAccounts,
  getBankAccountById,
  updateBankAccount,
  deleteBankAccount,
};
