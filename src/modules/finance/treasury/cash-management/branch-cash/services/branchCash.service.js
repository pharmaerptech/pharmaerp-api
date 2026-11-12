import mongoose from "mongoose";
import ApiError from "../../../../../../utils/ApiError.js";
import branchCashRepository from "../repositories/branchCash.repository.js";
import accountRepository from "../../../../chart-of-accounts/repositories/account.repository.js";
import {
  BRANCH_CASH_GROUP_CODE,
  BRANCH_CASH_GROUP_NAME,
} from "../constants/branchCash.constant.js";
import findOrCreateSystemAccount from "../../../shared/findOrCreateSystemAccount.js";

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get or auto-create the ledger "Branch Cash" account for a given branch.
 */
const getBranchCashLedgerAccount = async (
  workspaceId,
  companyId,
  userId,
  branchId,
  branchName,
  session,
) => {
  let resolvedBranchName = branchName;
  let branchCode = null;

  if (branchId) {
    try {
      const Branch = mongoose.models.Branch || (await import("../../../../../organization/branches/models/branch.model.js")).default;
      const branch = await Branch.findById(branchId).select("name branchCode").session(session || null);
      if (branch) {
        if (!resolvedBranchName) resolvedBranchName = branch.name;
        branchCode = branch.branchCode;
      }
    } catch {
      // fallback if Branch model query fails
    }
  }

  const accountCode = `BCASH-${String(branchId).slice(-8).toUpperCase()}`;

  // Check if an account already exists for this branch by its unique accountCode
  const existingByCode = await accountRepository.findAccountByCode(
    companyId,
    accountCode,
    { session },
  );
  if (existingByCode) return existingByCode;

  // Build a distinct, descriptive account name for this branch
  const suffix = resolvedBranchName || branchCode || String(branchId).slice(-6).toUpperCase();
  let candidateName = `Branch Cash - ${suffix}`;

  // Check if an account with this name already exists under this company
  let existingByName = await accountRepository.findAccountByName(
    companyId,
    candidateName,
    { session },
  );

  if (existingByName && existingByName.accountCode !== accountCode) {
    const disambiguator = branchCode || String(branchId).slice(-4).toUpperCase();
    candidateName = `${candidateName} (${disambiguator})`;
  }

  return findOrCreateSystemAccount(
    workspaceId,
    companyId,
    userId,
    accountCode,
    candidateName,
    "ASSET",
    "CASH",
    BRANCH_CASH_GROUP_CODE,
    BRANCH_CASH_GROUP_NAME,
    session,
  );
};

/**
 * Resolve the current open shift for a branch.
 */
const getOpenShift = async (branchId, companyId, session) => {
  const { Shift } = await import(
    "../../../../../operations/shifts/shift.model.js"
  );
  return Shift.findOne({ branchId, companyId, status: "open" })
    .select("_id")
    .session(session);
};

import BranchCashBalance from "../models/branchCashBalance.model.js";

/**
 * Build the combined response object from a BranchCash + BranchCashBalance pair.
 * Running/frozen totals are computed from denomination sums — never from scalar fields.
 */
const buildCashResponse = (cash, balance, currentShiftId = null) => {
  const runningDenominations = balance?.runningDenominations || [];
  const frozenDenominations = balance?.frozenDenominations || [];

  const runningCash = runningDenominations.reduce(
    (s, d) => s + (Number(d.denomination) || 0) * (Number(d.quantity) || 0),
    0,
  );
  const frozenCash = frozenDenominations.reduce(
    (s, d) => s + (Number(d.denomination) || 0) * (Number(d.quantity) || 0),
    0,
  );

  const denomBalance = balance
    ? {
        runningTotal: runningCash,
        runningDenominations,
        frozenTotal: frozenCash,
        frozenDenominations,
        lastUpdatedAt: balance.lastUpdatedAt,
      }
    : null;

  return {
    ...cash.toSafeObject(),
    isInitialized: true,
    currentShiftId,
    // Computed totals (denomination-derived, never stale)
    runningCash,
    frozenCash,
    balance: denomBalance,
    denominationBalance: denomBalance,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// INITIALIZE (called by branch.service.js on branch creation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates the BranchCash + BranchCashBalance documents for a new branch.
 * Also auto-creates the branch's cash ledger account in the Chart of Accounts.
 */
const initializeBranchCash = async (
  workspaceId,
  companyId,
  userId,
  branchId,
  branchName,
  options = {},
) => {
  const { session } = options;

  // Idempotent: if already initialised, return existing
  const existing = await branchCashRepository.findByBranchId(
    branchId,
    companyId,
    { session },
  );
  if (existing) return existing;

  // Create ledger account
  const ledgerAccount = await getBranchCashLedgerAccount(
    workspaceId,
    companyId,
    userId,
    branchId,
    branchName,
    session,
  );

  // Create BranchCash (no scalar amounts — only linkage)
  const branchCash = await branchCashRepository.createBranchCash(
    {
      workspaceId,
      companyId,
      branchId,
      ledgerAccountId: ledgerAccount._id,
      isActive: true,
      createdBy: userId,
    },
    { session },
  );

  // Create BranchCashBalance (denomination-based — starts at zero)
  await branchCashRepository.createBranchCashBalance(
    {
      workspaceId,
      companyId,
      branchId,
      runningTotal: 0,
      runningDenominations: [],
      frozenTotal: 0,
      frozenDenominations: [],
      lastUpdatedAt: new Date(),
      lastUpdatedBy: userId,
    },
    { session },
  );

  return branchCash;
};

// ─────────────────────────────────────────────────────────────────────────────
// INITIALIZE WITH OPENING BALANCE (user-triggered, pre-shift, denominations required)

/**
 * Explicitly initialize BranchCash with an opening balance.
 * Called from the "Initialize Branch Cash" UI flow after branch creation.
 *
 * Guardrails:
 *   - NO shift check (pre-shift financial setup).
 *   - Opening balance goes to RUNNING only. Frozen starts at 0.
 *   - Denominations REQUIRED.
 *   - All DB + journal ops in one MongoDB transaction.
 *   - Throws 409 if already initialized.
 */
const initializeBranchCashWithOpeningBalance = async (
  workspaceId,
  companyId,
  userId,
  payload,
) => {
  const { branchId, openingAmount, openingDenominations = [], narration } = payload;

  const normalizedOpeningAmount = Number(openingAmount ?? 0);
  if (!Number.isFinite(normalizedOpeningAmount) || normalizedOpeningAmount < 0) {
    throw new ApiError(400, "Opening amount cannot be negative.");
  }

  const processedDenoms = (Array.isArray(openingDenominations) ? openingDenominations : [])
    .map((d) => ({
      denomination: Number(d.denomination),
      quantity:     Number(d.quantity) || 0,
      subtotal:     Number(d.denomination) * (Number(d.quantity) || 0),
    }))
    .filter((d) => d.quantity > 0);

  if (normalizedOpeningAmount > 0 && processedDenoms.length === 0) {
    throw new ApiError(
      400,
      "Denomination breakdown is required to initialize branch cash with a positive opening balance.",
    );
  }

  const denomSum = processedDenoms.reduce((s, d) => s + d.subtotal, 0);
  if (Math.abs(denomSum - normalizedOpeningAmount) > 0.01) {
    throw new ApiError(
      400,
      `Denomination sum (Rs.${denomSum}) does not match declared opening amount (Rs.${normalizedOpeningAmount}).`,
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const existing = await branchCashRepository.findByBranchId(branchId, companyId, { session });
    if (existing) {
      throw new ApiError(409, "Branch cash is already initialized for this branch.");
    }

    const ledgerAccount = await getBranchCashLedgerAccount(
      workspaceId, companyId, userId, branchId, payload.branchName || null, session,
    );

    const branchCash = await branchCashRepository.createBranchCash(
      { workspaceId, companyId, branchId, ledgerAccountId: ledgerAccount._id, isActive: true, createdBy: userId },
      { session },
    );

    await branchCashRepository.createBranchCashBalance(
      {
        workspaceId, companyId, branchId,
        runningTotal: denomSum,
        runningDenominations: processedDenoms,
        frozenTotal: 0,
        frozenDenominations: [],
        lastUpdatedAt: new Date(),
        lastUpdatedBy: userId,
      },
      { session },
    );

    if (denomSum > 0) {
      const openingBalanceAccount = await findOrCreateSystemAccount(
        workspaceId, companyId, userId,
        "SYS-OPENING-BAL", "Opening Balances", "EQUITY", "EQUITY",
        "SYS-EQUITY", "Owner Equity", session,
      );

      const { default: journalVoucherRepository } = await import(
        "../../../../journal-vouchers/repositories/journalVoucher.repository.js"
      );
      const { default: journalLineRepository } = await import(
        "../../../../journal-vouchers/repositories/journalLine.repository.js"
      );
      const { default: journalPostingService } = await import(
        "../../../../journal-vouchers/services/journalPosting.service.js"
      );
      const { default: voucherNumberService } = await import(
        "../../../../journal-vouchers/services/voucherNumber.service.js"
      );
      const { VOUCHER_TYPE } = await import(
        "../../../../journal-vouchers/constants/voucherType.constant.js"
      );

      const voucherNumber = await voucherNumberService.generateVoucherNumber(
        companyId, workspaceId, VOUCHER_TYPE.JOURNAL, { session },
      );
      const voucher = await journalVoucherRepository.createVoucher(
        {
          workspaceId, companyId, voucherNumber,
          voucherDate: new Date(),
          voucherType: VOUCHER_TYPE.JOURNAL,
          narration: narration || "Branch cash opening balance",
          totalDebit: denomSum, totalCredit: denomSum, createdBy: userId,
        },
        { session },
      );
      await journalLineRepository.createLines(
        [
          { workspaceId, companyId, voucherId: voucher._id, accountId: ledgerAccount._id, debit: denomSum, credit: 0, narration: narration || "Branch cash opening balance" },
          { workspaceId, companyId, voucherId: voucher._id, accountId: openingBalanceAccount._id, debit: 0, credit: denomSum, narration: narration || "Branch cash opening balance" },
        ],
        { session },
      );
      await journalPostingService.postJournalVoucher(voucher._id, companyId, workspaceId, userId, { session });
    }

    await session.commitTransaction();
    session.endSession();
    return getByBranchId(branchId, companyId);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

// READ
// ─────────────────────────────────────────────────────────────────────────────

const getByBranchId = async (branchId, companyId) => {
  const cash = await branchCashRepository.findByBranchId(branchId, companyId);
  if (!cash) throw new ApiError(404, "Branch cash not found for this branch");

  const balance = await branchCashRepository.findBalanceByBranchId(
    branchId,
    companyId,
  );

  const openShift = await getOpenShift(branchId, companyId);
  const currentShiftId = openShift ? openShift._id.toString() : null;

  return buildCashResponse(cash, balance, currentShiftId);
};

const getAllByCompany = async (workspaceId, companyId) => {
  const cashDocs = await branchCashRepository.findAllByCompany(
    workspaceId,
    companyId,
  );
  const balances = await BranchCashBalance.find({ workspaceId, companyId });
  const balanceMap = new Map(balances.map((b) => [b.branchId.toString(), b]));

  // Optional: We can resolve open shifts for all branches if needed, but for now we'll just return null
  // or resolve them in a batch. For simplicity, we just pass null here since getAllByCompany is for overview.

  return cashDocs.map((c) => {
    const balance = balanceMap.get(c.branchId.toString());
    return buildCashResponse(c, balance, null);
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL MUTATIONS (called by other services in the same transaction)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add cash to running partition (denomination-based).
 * Used by: invoice cash payment, shift open float, manual deposit.
 */
const addToRunning = async (
  branchId,
  companyId,
  userId,
  amount,
  denominations = [],
  options = {},
) => {
  const { session } = options;

  if (denominations.length === 0) {
    throw new ApiError(
      400,
      "Denomination breakdown is required for all cash movements. Amount alone cannot be stored.",
    );
  }

  // Validate that denomination sum matches declared amount
  const denomSum = denominations.reduce(
    (s, d) => s + (Number(d.denomination) || 0) * (Number(d.quantity) || 0),
    0,
  );
  if (Math.abs(denomSum - amount) > 0.01) {
    throw new ApiError(
      400,
      `Denomination sum (₹${denomSum}) does not match declared amount (₹${amount}).`,
    );
  }

  const updated = await branchCashRepository.addRunningDenominations(
    branchId,
    companyId,
    denominations,
    userId,
    { session },
  );

  if (!updated) {
    throw new ApiError(404, "Branch cash not found. Cannot add to running.");
  }

  return updated;
};

/**
 * Deduct from frozen partition (denomination-based).
 * Used by: bank deposit slip, manual withdrawal.
 */
const deductFromFrozen = async (
  branchId,
  companyId,
  userId,
  amount,
  denominations = [],
  options = {},
) => {
  const { session } = options;

  if (denominations.length > 0) {
    // Validate denomination sufficiency in frozen partition
    await branchCashRepository.validateSufficientFrozenDenominations(
      branchId,
      companyId,
      denominations,
      { session },
    );

    // Validate denomination sum matches declared amount
    const denomSum = denominations.reduce(
      (s, d) => s + (Number(d.denomination) || 0) * (Number(d.quantity) || 0),
      0,
    );
    if (Math.abs(denomSum - amount) > 0.01) {
      throw new ApiError(
        400,
        `Denomination sum (₹${denomSum}) does not match requested deduction amount (₹${amount}).`,
      );
    }

    const updated = await branchCashRepository.subtractFrozenDenominations(
      branchId,
      companyId,
      denominations,
      userId,
      { session },
    );

    if (!updated) {
      throw new ApiError(400, "Failed to deduct from frozen cash.");
    }

    return updated;
  } else {
    // Scalar-only path: check balance from denomination sum
    const balance = await branchCashRepository.findBalanceByBranchId(
      branchId,
      companyId,
      { session },
    );
    const frozenTotal = (balance?.frozenDenominations || []).reduce(
      (s, d) => s + (Number(d.denomination) || 0) * (Number(d.quantity) || 0),
      0,
    );
    if (frozenTotal < amount) {
      throw new ApiError(
        400,
        `Insufficient frozen cash. Available: ₹${frozenTotal}, Requested: ₹${amount}`,
      );
    }

    // Cannot deduct without denominations — this path should not be used in production
    throw new ApiError(
      400,
      "Denomination breakdown is required to deduct from frozen cash.",
    );
  }
};

/**
 * Move specific denominations from running → frozen (used exclusively at shift close).
 *
 * New behaviour (reversed UX):
 *   The cashier selects WHICH denominations go to frozen.
 *   The remainder (not selected) stays in running as carry-forward for next shift.
 *
 * @param {string} branchId
 * @param {string} companyId
 * @param {string} userId
 * @param {number} frozenAmount           - declared frozen total (for validation)
 * @param {Array}  frozenDenominations    - breakdown of notes going to frozen
 * @param {Array}  allCountedDenominations - full count of notes in the drawer
 * @param {object} options
 */
const freezeAtShiftClose = async (
  branchId,
  companyId,
  userId,
  frozenAmount,
  frozenDenominations = [],
  allCountedDenominations = null,
  options = {},
) => {
  const { session } = options;

  if (frozenAmount <= 0 && frozenDenominations.length === 0) {
    if (allCountedDenominations !== null) {
      const runningCarryForward = allCountedDenominations.map(d => ({
        denomination: Number(d.denomination),
        quantity: Number(d.count || d.quantity) || 0
      })).filter(d => d.quantity > 0);

      return await branchCashRepository.setRunningDenominations(
        branchId,
        companyId,
        runningCarryForward,
        userId,
        { session }
      );
    }
    return null;
  }

  const balance = await branchCashRepository.findBalanceByBranchId(
    branchId,
    companyId,
    { session },
  );

  // Derive current running total from denomination sums
  const currentRunningTotal = (balance?.runningDenominations || []).reduce(
    (s, d) => s + (Number(d.denomination) || 0) * (Number(d.quantity) || 0),
    0,
  );

  if (currentRunningTotal < frozenAmount) {
    throw new ApiError(
      400,
      `Cannot freeze ₹${frozenAmount}: only ₹${currentRunningTotal} in running cash (by denomination).`,
    );
  }

  if (frozenDenominations.length > 0) {
    // Validate frozen denom sum matches frozenAmount
    const frozenDenomSum = frozenDenominations.reduce(
      (s, d) => s + (Number(d.denomination) || 0) * (Number(d.quantity) || 0),
      0,
    );
    if (Math.abs(frozenDenomSum - frozenAmount) > 0.01) {
      throw new ApiError(
        400,
        `Frozen denomination sum (₹${frozenDenomSum}) does not match frozen amount (₹${frozenAmount}).`,
      );
    }

    if (allCountedDenominations !== null) {
      // Build running carry-forward = allCounted - frozen
      const countedMap = new Map();
      for (const d of allCountedDenominations) {
        countedMap.set(Number(d.denomination), Number(d.count || d.quantity) || 0);
      }
      const frozenMap = new Map();
      for (const d of frozenDenominations) {
        frozenMap.set(Number(d.denomination), Number(d.quantity) || 0);
      }

      const runningCarryForward = [];
      for (const [denom, countedQty] of countedMap.entries()) {
        const frozenQty = frozenMap.get(denom) || 0;
        const carryQty = Math.max(0, countedQty - frozenQty);
        if (carryQty > 0) {
          runningCarryForward.push({ denomination: denom, quantity: carryQty });
        }
      }

      // Replace running denominations with carry-forward
      await branchCashRepository.setRunningDenominations(
        branchId,
        companyId,
        runningCarryForward,
        userId,
        { session },
      );

      // Add frozen denominations to frozen partition
      const updated = await branchCashRepository.addFrozenDenominations(
        branchId,
        companyId,
        frozenDenominations,
        userId,
        { session },
      );

      return updated;
    } else {
      // Fallback: just move denoms running→frozen (old behaviour)
      const updated = await branchCashRepository.moveDenominationsRunningToFrozen(
        branchId,
        companyId,
        frozenDenominations,
        userId,
        { session },
      );
      return updated;
    }
  }

  return null;
};

// Push a frozenLedger entry after freeze operations
// (called by the shift.service after freezeAtShiftClose succeeds, passing shiftId)
const pushFreezeAuditEntry = async (
  branchId,
  companyId,
  { frozenAmount, shiftId, userId },
  options = {},
) => {
  if (!frozenAmount || frozenAmount <= 0) return;
  await branchCashRepository.pushFrozenLedgerEntry(
    branchId,
    companyId,
    {
      action: "freeze",
      amount: frozenAmount,
      note: "Shift close — cash moved to frozen reserve",
      shiftId: shiftId || null,
      userId: userId || null,
      date: new Date(),
    },
    options,
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL DEPOSIT (external cash IN → running partition)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deposit external cash into the running partition.
 * Denominations are REQUIRED — no amount-only deposits allowed.
 */
const manualDeposit = async (workspaceId, companyId, userId, payload) => {
  const { branchId, amount, denominations = [], narration } = payload;

  if (!amount || amount <= 0) {
    throw new ApiError(400, "Deposit amount must be greater than zero");
  }
  if (!denominations || denominations.length === 0) {
    throw new ApiError(
      400,
      "Denomination breakdown is required. A cash amount without denomination verification cannot be accepted.",
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate open shift
    const openShift = await getOpenShift(branchId, companyId, session);
    if (!openShift) {
      throw new ApiError(
        400,
        "Cannot deposit cash: no open shift for this branch. Open a shift first.",
      );
    }

    const processedDenoms = denominations.map((d) => ({
      denomination: Number(d.denomination),
      quantity: Number(d.quantity) || 0,
      subtotal: Number(d.denomination) * (Number(d.quantity) || 0),
    }));

    // Validate denomination sum matches declared amount
    const denomSum = processedDenoms.reduce((s, d) => s + d.subtotal, 0);
    if (Math.abs(denomSum - amount) > 0.01) {
      throw new ApiError(
        400,
        `Denomination sum (₹${denomSum}) does not match declared amount (₹${amount}).`,
      );
    }

    // Update denomination balance only
    await branchCashRepository.addRunningDenominations(
      branchId,
      companyId,
      processedDenoms,
      userId,
      { session },
    );

    // Update shift with this deposit
    const { Shift } = await import("../../../../../operations/shifts/shift.model.js");
    await Shift.updateOne(
      { _id: openShift._id },
      { 
        $inc: { totalFundDeposits: amount },
        $push: { 
          manualDeposits: {
            amount,
            narration: narration || "Manual cash deposit",
            createdBy: userId
          }
        }
      },
      { session }
    );

    // Post journal entry
    const branchCash = await branchCashRepository.findByBranchId(
      branchId,
      companyId,
      { session },
    );

    if (branchCash?.ledgerAccountId) {
      const { default: journalVoucherRepository } = await import(
        "../../../../journal-vouchers/repositories/journalVoucher.repository.js"
      );
      const { default: journalLineRepository } = await import(
        "../../../../journal-vouchers/repositories/journalLine.repository.js"
      );
      const { default: journalPostingService } = await import(
        "../../../../journal-vouchers/services/journalPosting.service.js"
      );
      const { default: voucherNumberService } = await import(
        "../../../../journal-vouchers/services/voucherNumber.service.js"
      );
      const { VOUCHER_TYPE } = await import(
        "../../../../journal-vouchers/constants/voucherType.constant.js"
      );

      const cashReceiptsAccount = await findOrCreateSystemAccount(
        workspaceId,
        companyId,
        userId,
        "SYS-CASH-RECEIPTS",
        "Cash Receipts",
        "INCOME",
        "INCOME",
        "SYS-MISC-INCOME",
        "Miscellaneous Income",
        session,
      );

      const voucherNumber = await voucherNumberService.generateVoucherNumber(
        companyId,
        workspaceId,
        VOUCHER_TYPE.RECEIPT,
        { session },
      );

      const voucher = await journalVoucherRepository.createVoucher(
        {
          workspaceId,
          companyId,
          voucherNumber,
          voucherDate: new Date(),
          voucherType: VOUCHER_TYPE.RECEIPT,
          narration: narration || "Manual cash deposit to running cash",
          totalDebit: amount,
          totalCredit: amount,
          createdBy: userId,
        },
        { session },
      );

      await journalLineRepository.createLines(
        [
          {
            workspaceId,
            companyId,
            voucherId: voucher._id,
            accountId: branchCash.ledgerAccountId,
            debit: amount,
            credit: 0,
            narration: narration || "Manual cash deposit",
          },
          {
            workspaceId,
            companyId,
            voucherId: voucher._id,
            accountId: cashReceiptsAccount._id,
            debit: 0,
            credit: amount,
            narration: narration || "Manual cash deposit",
          },
        ],
        { session },
      );

      await journalPostingService.postJournalVoucher(
        voucher._id,
        companyId,
        workspaceId,
        userId,
        { session },
      );
    }

    await session.commitTransaction();
    session.endSession();

    return getByBranchId(branchId, companyId);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL WITHDRAWAL (cash OUT from frozen partition)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Withdraw cash from the frozen partition.
 * Denominations are REQUIRED — no amount-only withdrawals allowed.
 */
const manualWithdraw = async (workspaceId, companyId, userId, payload) => {
  const { branchId, amount, denominations = [], narration } = payload;

  if (!amount || amount <= 0) {
    throw new ApiError(400, "Withdrawal amount must be greater than zero");
  }
  if (!denominations || denominations.length === 0) {
    throw new ApiError(
      400,
      "Denomination breakdown is required. A cash amount without denomination verification cannot be accepted.",
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // SHIFT GATE: withdrawal requires an open shift (by design — all cash operations
    // must be attributed to a shift for full audit traceability)
    const openShift = await getOpenShift(branchId, companyId, session);
    if (!openShift) {
      throw new ApiError(
        400,
        "Cannot withdraw cash: no open shift for this branch. Open a shift first.",
      );
    }

    const processedDenoms = denominations.map((d) => ({
      denomination: Number(d.denomination),
      quantity: Number(d.quantity) || 0,
      subtotal: Number(d.denomination) * (Number(d.quantity) || 0),
    }));

    // Deduct from frozen (includes denomination sufficiency check)
    await deductFromFrozen(
      branchId,
      companyId,
      userId,
      amount,
      processedDenoms,
      { session },
    );

    // Push to frozenLedger for day-closing timeline
    await branchCashRepository.pushFrozenLedgerEntry(
      branchId,
      companyId,
      {
        action: "withdrawal",
        amount,
        note: narration || "Manual cash withdrawal",
        shiftId: openShift._id,
        userId,
        date: new Date(),
      },
      { session },
    );

    // Mandatory shift logging (shift is guaranteed open at this point)
    const { Shift } = await import("../../../../../operations/shifts/shift.model.js");
    await Shift.updateOne(
      { _id: openShift._id },
      {
        $inc: { totalFundWithdrawals: amount },
        $push: {
          manualWithdrawals: {
            amount,
            narration: narration || "Manual cash withdrawal",
            date: new Date(),
            createdBy: userId,
            source: payload.source || "frozen",
          },
        },
      },
      { session },
    );

    // Post journal entry
    const branchCash = await branchCashRepository.findByBranchId(
      branchId,
      companyId,
      { session },
    );

    if (branchCash?.ledgerAccountId) {
      const { default: journalVoucherRepository } = await import(
        "../../../../journal-vouchers/repositories/journalVoucher.repository.js"
      );
      const { default: journalLineRepository } = await import(
        "../../../../journal-vouchers/repositories/journalLine.repository.js"
      );
      const { default: journalPostingService } = await import(
        "../../../../journal-vouchers/services/journalPosting.service.js"
      );
      const { default: voucherNumberService } = await import(
        "../../../../journal-vouchers/services/voucherNumber.service.js"
      );
      const { VOUCHER_TYPE } = await import(
        "../../../../journal-vouchers/constants/voucherType.constant.js"
      );

      const cashPaymentsAccount = await findOrCreateSystemAccount(
        workspaceId,
        companyId,
        userId,
        "SYS-CASH-PAYMENTS",
        "Cash Payments",
        "EXPENSE",
        "EXPENSE",
        "SYS-MISC-EXPENSE",
        "Miscellaneous Expenses",
        session,
      );

      const voucherNumber = await voucherNumberService.generateVoucherNumber(
        companyId,
        workspaceId,
        VOUCHER_TYPE.PAYMENT,
        { session },
      );

      const voucher = await journalVoucherRepository.createVoucher(
        {
          workspaceId,
          companyId,
          voucherNumber,
          voucherDate: new Date(),
          voucherType: VOUCHER_TYPE.PAYMENT,
          narration: narration || "Manual cash withdrawal from frozen reserve",
          totalDebit: amount,
          totalCredit: amount,
          createdBy: userId,
        },
        { session },
      );

      await journalLineRepository.createLines(
        [
          {
            workspaceId,
            companyId,
            voucherId: voucher._id,
            accountId: cashPaymentsAccount._id,
            debit: amount,
            credit: 0,
            narration: narration || "Manual cash withdrawal",
          },
          {
            workspaceId,
            companyId,
            voucherId: voucher._id,
            accountId: branchCash.ledgerAccountId,
            debit: 0,
            credit: amount,
            narration: narration || "Manual cash withdrawal",
          },
        ],
        { session },
      );

      await journalPostingService.postJournalVoucher(
        voucher._id,
        companyId,
        workspaceId,
        userId,
        { session },
      );
    }

    await session.commitTransaction();
    session.endSession();

    return getByBranchId(branchId, companyId);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

// WITHDRAW CASH (source-aware: running / frozen / bankslip)

/**
 * Withdraw cash from one of three sources:
 *   "running"   - Running partition. Shift MUST be OPEN (checked inside the transaction).
 *   "frozen"    - Frozen partition. No shift check required.
 *   "bankslip"  - Partial withdrawal from a PREPARED BDS. No shift check.
 *
 * Denominations are ALWAYS required.
 */
const withdrawCash = async (workspaceId, companyId, userId, payload) => {
  const { branchId, source, slipId, amount, denominations = [], narration } = payload;

  if (!source || !["running", "frozen", "bankslip"].includes(source)) {
    throw new ApiError(400, 'Withdrawal source must be one of: "running", "frozen", "bankslip".');
  }
  if (!amount || amount <= 0) {
    throw new ApiError(400, "Withdrawal amount must be greater than zero.");
  }
  if (!denominations || denominations.length === 0) {
    throw new ApiError(
      400,
      "Denomination breakdown is required. A cash amount without denomination verification cannot be accepted.",
    );
  }

  // BANKSLIP source: delegate to BDS service
  if (source === "bankslip") {
    if (!slipId) {
      throw new ApiError(400, "slipId is required when withdrawing from a bank slip.");
    }
    const { default: bankDepositSlipService } = await import(
      "../../../bank-deposit-slips/services/bankDepositSlip.service.js"
    );
    return bankDepositSlipService.withdrawFromBankDepositSlip(
      workspaceId, companyId, userId,
      { slipId, branchId, amount, denominations, narration },
    );
  }

  // RUNNING or FROZEN: operate on BranchCashBalance
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const processedDenoms = denominations.map((d) => ({
      denomination: Number(d.denomination),
      quantity:     Number(d.quantity) || 0,
      subtotal:     Number(d.denomination) * (Number(d.quantity) || 0),
    }));

    const denomSum = processedDenoms.reduce((s, d) => s + d.subtotal, 0);
    if (Math.abs(denomSum - amount) > 0.01) {
      throw new ApiError(
        400,
        `Denomination sum (Rs.${denomSum}) does not match declared withdrawal amount (Rs.${amount}).`,
      );
    }

    if (source === "running") {
      const openShift = await getOpenShift(branchId, companyId, session);
      if (!openShift) {
        throw new ApiError(
          400,
          "Cannot withdraw from running cash: no open shift for this branch. Open a shift first.",
        );
      }
      await branchCashRepository.validateSufficientRunningDenominations(
        branchId, companyId, processedDenoms, { session },
      );
      await branchCashRepository.subtractRunningDenominations(
        branchId, companyId, processedDenoms, userId, { session },
      );
    } else {
      await branchCashRepository.validateSufficientFrozenDenominations(
        branchId, companyId, processedDenoms, { session },
      );
      await branchCashRepository.subtractFrozenDenominations(
        branchId, companyId, processedDenoms, userId, { session },
      );
    }

    // Log the withdrawal on the open shift (if any)
    const activeShift = await getOpenShift(branchId, companyId, session);
    if (activeShift) {
      const { Shift } = await import("../../../../../operations/shifts/shift.model.js");
      await Shift.updateOne(
        { _id: activeShift._id },
        { 
          $inc: { totalFundWithdrawals: amount },
          $push: { 
            manualWithdrawals: {
              amount,
              narration: narration || "Manual cash withdrawal",
              createdBy: userId,
              source: source // "running" or "frozen"
            }
          }
        },
        { session }
      );
    }

    const branchCash = await branchCashRepository.findByBranchId(branchId, companyId, { session });

    if (branchCash?.ledgerAccountId) {
      const { default: journalVoucherRepository } = await import(
        "../../../../journal-vouchers/repositories/journalVoucher.repository.js"
      );
      const { default: journalLineRepository } = await import(
        "../../../../journal-vouchers/repositories/journalLine.repository.js"
      );
      const { default: journalPostingService } = await import(
        "../../../../journal-vouchers/services/journalPosting.service.js"
      );
      const { default: voucherNumberService } = await import(
        "../../../../journal-vouchers/services/voucherNumber.service.js"
      );
      const { VOUCHER_TYPE } = await import(
        "../../../../journal-vouchers/constants/voucherType.constant.js"
      );

      const cashPaymentsAccount = await findOrCreateSystemAccount(
        workspaceId, companyId, userId,
        "SYS-CASH-PAYMENTS", "Cash Payments", "EXPENSE", "EXPENSE",
        "SYS-MISC-EXPENSE", "Miscellaneous Expenses", session,
      );

      const voucherNumber = await voucherNumberService.generateVoucherNumber(
        companyId, workspaceId, VOUCHER_TYPE.PAYMENT, { session },
      );

      const defaultNarration = source === "running"
        ? "Cash withdrawal from running cash"
        : "Cash withdrawal from frozen reserve";

      const voucher = await journalVoucherRepository.createVoucher(
        {
          workspaceId, companyId, voucherNumber,
          voucherDate: new Date(), voucherType: VOUCHER_TYPE.PAYMENT,
          narration: narration || defaultNarration,
          totalDebit: amount, totalCredit: amount, createdBy: userId,
        },
        { session },
      );

      await journalLineRepository.createLines(
        [
          { workspaceId, companyId, voucherId: voucher._id, accountId: cashPaymentsAccount._id, debit: amount, credit: 0, narration: narration || defaultNarration },
          { workspaceId, companyId, voucherId: voucher._id, accountId: branchCash.ledgerAccountId, debit: 0, credit: amount, narration: narration || defaultNarration },
        ],
        { session },
      );

      await journalPostingService.postJournalVoucher(
        voucher._id, companyId, workspaceId, userId, { session },
      );
    }

    await session.commitTransaction();
    session.endSession();
    return getByBranchId(branchId, companyId);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

/**
 * Post an adjustment (shortage/overage) during shift close.
 * Creates a Journal Voucher to keep the ledger in sync with the physical cash.
 */
const postShiftAdjustment = async (
  workspaceId,
  companyId,
  userId,
  branchId,
  differenceAmount,
  shiftId,
  options = {}
) => {
  const { session } = options;
  if (differenceAmount === null || differenceAmount === undefined) return;

  const isShortage = differenceAmount < 0;
  const absAmount = Math.abs(differenceAmount);
  
  const branchCash = await branchCashRepository.findByBranchId(branchId, companyId, { session });
  if (!branchCash?.ledgerAccountId) return;

  let voucherId = null;
  const narration = `Shift ${shiftId} Cash Adjustment: ${absAmount === 0 ? 'Denominations' : (isShortage ? 'Shortage' : 'Overage')}`;

  if (absAmount > 0) {
    const { default: journalVoucherRepository } = await import(
      "../../../../journal-vouchers/repositories/journalVoucher.repository.js"
    );
    const { default: journalLineRepository } = await import(
      "../../../../journal-vouchers/repositories/journalLine.repository.js"
    );
    const { default: journalPostingService } = await import(
      "../../../../journal-vouchers/services/journalPosting.service.js"
    );
    const { default: voucherNumberService } = await import(
      "../../../../journal-vouchers/services/voucherNumber.service.js"
    );
    const { VOUCHER_TYPE } = await import(
      "../../../../journal-vouchers/constants/voucherType.constant.js"
    );

    // Use a system account for Cash Adjustment (EXPENSE)
    const cashAdjustmentAccount = await findOrCreateSystemAccount(
      workspaceId, companyId, userId,
      "SYS-CASH-ADJ", "Cash Shortage/Overage", "EXPENSE", "EXPENSE",
      "SYS-MISC-EXPENSE", "Miscellaneous Expenses", session,
    );

    const voucherNumber = await voucherNumberService.generateVoucherNumber(
      companyId, workspaceId, VOUCHER_TYPE.JOURNAL, { session },
    );

    const voucher = await journalVoucherRepository.createVoucher(
      {
        workspaceId, companyId, voucherNumber,
        voucherDate: new Date(), voucherType: VOUCHER_TYPE.JOURNAL,
        narration,
        totalDebit: absAmount, totalCredit: absAmount, createdBy: userId,
      },
      { session },
    );

    // If shortage (difference < 0): Debit Adjustment Expense, Credit Branch Cash (decreasing cash)
    // If overage (difference > 0): Debit Branch Cash (increasing cash), Credit Adjustment Expense (decreasing expense / income)
    const debitAccountId = isShortage ? cashAdjustmentAccount._id : branchCash.ledgerAccountId;
    const creditAccountId = isShortage ? branchCash.ledgerAccountId : cashAdjustmentAccount._id;

    await journalLineRepository.createLines(
      [
        { workspaceId, companyId, voucherId: voucher._id, accountId: debitAccountId, debit: absAmount, credit: 0, narration },
        { workspaceId, companyId, voucherId: voucher._id, accountId: creditAccountId, debit: 0, credit: absAmount, narration },
      ],
      { session },
    );

    await journalPostingService.postJournalVoucher(
      voucher._id, companyId, workspaceId, userId, { session },
    );
    voucherId = voucher._id;
  }
  
  // Also create a CashTransaction record
  const { default: CashTransaction } = await import("../../cash-transactions/models/cashTransaction.model.js");
  const { CASH_TRANSACTION_TYPE, CASH_TRANSACTION_DIRECTION, CASH_TRANSACTION_STATUS } = await import("../../cash-transactions/constants/cashTransaction.constant.js");

  await CashTransaction.create([{
    workspaceId,
    companyId,
    branchId,
    transactionNumber: `ADJ-${Date.now()}`,
    transactionDate: new Date(),
    cashPartition: "running",
    transactionType: CASH_TRANSACTION_TYPE.ADJUSTMENT,
    direction: isShortage ? CASH_TRANSACTION_DIRECTION.DEBIT : CASH_TRANSACTION_DIRECTION.CREDIT,
    amount: absAmount,
    narration,
    status: CASH_TRANSACTION_STATUS.POSTED,
    journalVoucherId: voucherId,
    createdBy: userId,
    postedAt: new Date(),
    postedBy: userId
  }], { session });
};

// ─────────────────────────────────────────────────────────────────────────────

export default {
  initializeBranchCash,
  initializeBranchCashWithOpeningBalance,
  getByBranchId,
  getAllByCompany,
  // Internal partition mutations (used by other services)
  addToRunning,
  deductFromFrozen,
  freezeAtShiftClose,
  pushFreezeAuditEntry,
  postShiftAdjustment,
  // Manual operations
  manualDeposit,
  manualWithdraw,   // backward compat alias
  withdrawCash,     // source-aware: "running" | "frozen" | "bankslip"
};
