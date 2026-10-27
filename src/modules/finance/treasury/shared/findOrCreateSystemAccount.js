/**
 * Shared Treasury Utility: findOrCreateSystemAccount
 *
 * This helper is used across multiple treasury submodules:
 *   - cheque-management    (Cheques In Transit, Bounce Charges)
 *   - bank-transactions    (Bank Charges, Interest Income)
 *   - cash-transactions    (Cash Adjustment, Petty Cash)
 *   - bank-deposit-slips   (Cash In Transit)
 *
 * It finds an account by its unique code, and if not found, auto-creates
 * both the account group and account. This eliminates the need for manual
 * system account setup in the Chart of Accounts.
 *
 * NOTE: This file is the canonical implementation. The per-service copies
 * in individual service files are kept for backward compatibility and can
 * be migrated to import from here in a future cleanup task.
 */

import accountRepository from "../../chart-of-accounts/repositories/account.repository.js";
import accountGroupRepository from "../../chart-of-accounts/repositories/accountGroup.repository.js";

/**
 * Finds a system account by its unique code, or creates it (and its group) if absent.
 *
 * @param {string} workspaceId
 * @param {string} companyId
 * @param {string} userId           - User creating the account (for audit trail)
 * @param {string} accountCode      - Unique code, e.g. "SYS-CASH-IN-TRANSIT"
 * @param {string} accountName      - Human-readable name, e.g. "Cash In Transit"
 * @param {string} accountNature    - "ASSET" | "LIABILITY" | "INCOME" | "EXPENSE" | "EQUITY"
 * @param {string} accountCategory  - e.g. "CASH", "EXPENSE", "INCOME"
 * @param {string} groupCode        - Account group code, e.g. "SYS-TRANSIT-ASSETS"
 * @param {string} groupName        - Account group name, e.g. "Transit Assets"
 * @param {object} session          - Mongoose session (for transaction safety)
 * @returns {Promise<object>}       The account document
 */
const findOrCreateSystemAccount = async (
  workspaceId,
  companyId,
  userId,
  accountCode,
  accountName,
  accountNature,
  accountCategory,
  groupCode,
  groupName,
  session,
) => {
  // Fast path: account already exists by code
  let account = await accountRepository.findAccountByCode(
    companyId,
    accountCode,
    { session },
  );
  if (account) return account;

  // Defensive check: does an account with this name already exist for this company?
  const existingByName = await accountRepository.findAccountByName(
    companyId,
    accountName,
    { session },
  );

  let finalAccountName = accountName;
  if (existingByName) {
    if (accountCode && accountCode.startsWith("BCASH-")) {
      // Disambiguate for branch cash so it doesn't collide with another branch's account
      const disambiguator = accountCode.slice(-4);
      finalAccountName = `${accountName} (${disambiguator})`;
    } else {
      // For general singleton system accounts (e.g. Opening Balances, Cash in Transit),
      // reuse the existing account
      return existingByName;
    }
  }

  // Defensive normalization: map legacy "debit"/"credit" or lowercase inputs to valid enum values
  let normalizedNature = accountNature;
  if (typeof accountNature === "string") {
    const upper = accountNature.trim().toUpperCase();
    if (upper === "DEBIT") {
      normalizedNature = "ASSET";
    } else if (upper === "CREDIT") {
      normalizedNature = "LIABILITY";
    } else {
      normalizedNature = upper;
    }
  }

  // Find or create the parent group
  let group = await accountGroupRepository.findGroupByCode(
    companyId,
    groupCode,
    { session },
  );
  if (!group) {
    // Also check if groupName already exists for this company
    group = await accountGroupRepository.findGroupByName(
      companyId,
      groupName,
      { session },
    );
  }
  
  if (!group) {
    try {
      group = await accountGroupRepository.createGroup(
        {
          workspaceId,
          companyId,
          groupCode,
          groupName,
          parentGroupId: null,
          nature: normalizedNature,
          isSystemGroup: true,
          createdBy: userId,
        },
        { session },
      );
    } catch (grpErr) {
      if (
        grpErr.code === 11000 ||
        grpErr.name === "MongoServerError" ||
        String(grpErr.message).includes("E11000") ||
        String(grpErr.message).includes("duplicate key")
      ) {
        group =
          (await accountGroupRepository.findGroupByName(companyId, groupName, {
            session,
          })) ||
          (await accountGroupRepository.findGroupByCode(companyId, groupCode, {
            session,
          }));
      }
      if (!group) throw grpErr;
    }
  }

  // Create the system account
  try {
    account = await accountRepository.createAccount(
      {
        workspaceId,
        companyId,
        accountCode,
        accountName: finalAccountName,
        accountGroupId: group._id,
        accountNature: normalizedNature,
        accountCategory,
        openingBalance: 0,
        openingBalanceType: "dr",
        status: "active",
        isSystemAccount: true,
        createdBy: userId,
      },
      { session },
    );
  } catch (acctErr) {
    if (
      acctErr.code === 11000 ||
      acctErr.name === "MongoServerError" ||
      String(acctErr.message).includes("E11000") ||
      String(acctErr.message).includes("duplicate key")
    ) {
      account =
        (await accountRepository.findAccountByCode(companyId, accountCode, {
          session,
        })) ||
        (await accountRepository.findAccountByName(companyId, finalAccountName, {
          session,
        }));
    }
    if (!account) throw acctErr;
  }

  return account;
};

/**
 * Finds or creates the default Shift UPI Clearing Account (Asset / Transit).
 */
export const getUpiClearingAccount = async (
  workspaceId,
  companyId,
  userId,
  session = null,
) => {
  return findOrCreateSystemAccount(
    workspaceId,
    companyId,
    userId,
    "SYS-UPI-CLEARING",
    "UPI Clearing Account",
    "ASSET",
    "BANK",
    "SYS-TRANSIT-ASSETS",
    "Transit Assets",
    session,
  );
};

export default findOrCreateSystemAccount;
