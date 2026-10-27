import mongoose from "mongoose";
import ApiError from "../../../../../../utils/ApiError.js";
import bankTransactionRepository from "../repositories/bankTransaction.repository.js";
import {
  BANK_TRANSACTION_TYPE,
  BANK_TRANSACTION_DIRECTION,
  BANK_TRANSACTION_STATUS,
  BANK_TRANSACTION_PAYMENT_MODE,
  BANK_TRANSACTION_CATEGORY,
} from "../constants/bankTransaction.constant.js";
import accountBalanceRepository from "../../../../account-balances/repositories/accountBalance.repository.js";

import BankAccount from "../../bank-accounts/models/bankAccount.model.js";
import Account from "../../../../chart-of-accounts/models/account.model.js";
import accountGroupRepository from "../../../../chart-of-accounts/repositories/accountGroup.repository.js";
import accountRepository from "../../../../chart-of-accounts/repositories/account.repository.js";
import journalVoucherRepository from "../../../../journal-vouchers/repositories/journalVoucher.repository.js";
import journalLineRepository from "../../../../journal-vouchers/repositories/journalLine.repository.js";
import journalPostingService from "../../../../journal-vouchers/services/journalPosting.service.js";
import journalCancellationService from "../../../../journal-vouchers/services/journalCancellation.service.js";
import { VOUCHER_TYPE } from "../../../../journal-vouchers/constants/voucherType.constant.js";
import { VOUCHER_STATUS } from "../../../../journal-vouchers/constants/voucherStatus.constant.js";
import voucherNumberService from "../../../../journal-vouchers/services/voucherNumber.service.js";
import { parseISTTransactionDate } from "../../../../../../utils/businessDate.js";

/**
 * Determine the journal voucher type based on transaction direction.
 * CREDIT (money in) → RECEIPT
 * DEBIT  (money out) → PAYMENT
 * Charges/Interest  → JOURNAL
 */
const resolveVoucherType = (transactionType) => {
  const receiptTypes = [
    "DEPOSIT",
    "NEFT",
    "RTGS",
    "IMPS",
    "UPI",
    "CHEQUE",
    "INTEREST",
  ];
  const paymentTypes = ["WITHDRAWAL"];
  const journalTypes = ["BANK_CHARGES", "OTHER"];

  if (receiptTypes.includes(transactionType)) return VOUCHER_TYPE.JOURNAL;
  if (paymentTypes.includes(transactionType)) return VOUCHER_TYPE.JOURNAL;
  if (journalTypes.includes(transactionType)) return VOUCHER_TYPE.JOURNAL;
  return VOUCHER_TYPE.JOURNAL;
};

import findOrCreateSystemAccount from "../../../shared/findOrCreateSystemAccount.js";

// ---------------------------------------------------------------------------
// CREATE BANK TRANSACTION
// ---------------------------------------------------------------------------
const createBankTransaction = async (
  workspaceId,
  companyId,
  userId,
  payload,
  options = {},
) => {
  const {
    transactionDate,
    bankAccountId,
    transactionType,
    direction,
    amount,
    referenceNumber,
    narration,
    counterpartyAccountId,
  } = payload;

  const providedSession = options.session;
  const session = providedSession || await mongoose.startSession();
  
  if (!providedSession) {
    session.startTransaction();
  }

  try {
    // 1. Verify BankAccount exists and is active
    const bankAccount = await BankAccount.findOne({
      _id: bankAccountId,
      companyId,
      workspaceId,
      isDeleted: false,
      isActive: true,
    }).session(session);

    if (!bankAccount) {
      throw new ApiError(400, "Bank Account not found or inactive");
    }

    const bankLedgerAccountId = bankAccount.ledgerAccountId;

    // 2. Resolve the counterparty (offset) ledger account
    let offsetLedgerAccountId = null;

    if (counterpartyAccountId) {
      // User explicitly provided a counterparty account
      const acct = await Account.findOne({
        _id: counterpartyAccountId,
        companyId,
        isDeleted: false,
      }).session(session);
      if (!acct) throw new ApiError(400, "Counterparty account not found");
      offsetLedgerAccountId = acct._id;
    } else {
      // Auto-resolve based on transaction type
      if (transactionType === "BANK_CHARGES") {
        const chargesAccount = await findOrCreateSystemAccount(
          workspaceId,
          companyId,
          userId,
          "BANK_CHARGES",
          "Bank Charges",
          "EXPENSE",
          "EXPENSE",
          "BANK_CHARGES_GRP",
          "Bank Charges",
          session,
        );
        offsetLedgerAccountId = chargesAccount._id;
      } else if (transactionType === "INTEREST") {
        const interestAccount = await findOrCreateSystemAccount(
          workspaceId,
          companyId,
          userId,
          "BANK_INTEREST_INC",
          "Bank Interest Income",
          "INCOME",
          "INCOME",
          "BANK_INTEREST_GRP",
          "Bank Interest",
          session,
        );
        offsetLedgerAccountId = interestAccount._id;
      } else {
        // For DEPOSIT, WITHDRAWAL, NEFT, RTGS, IMPS, UPI, CHEQUE, OTHER
        // we require counterpartyAccountId from the user
        throw new ApiError(
          400,
          `counterpartyAccountId is required for transaction type: ${transactionType}`,
        );
      }
    }

    // 3. Generate unique transaction number
    const transactionNumber =
      await bankTransactionRepository.getNextTransactionNumber(
        companyId,
        workspaceId,
        { session },
      );

    // 4. Generate journal voucher number
    const voucherType = resolveVoucherType(transactionType);
    const voucherNumber = await voucherNumberService.generateVoucherNumber(
      companyId,
      workspaceId,
      voucherType,
      { session },
    );

    const txDate = parseISTTransactionDate(transactionDate);
    const txNarration =
      narration || `${transactionType} - ${transactionNumber}`;

    // 5. Build journal lines
    // CREDIT direction: Bank A/c Dr, Offset A/c Cr (money comes in to bank)
    // DEBIT  direction: Offset A/c Dr, Bank A/c Cr (money goes out of bank)
    let lines;
    if (direction === BANK_TRANSACTION_DIRECTION.CREDIT) {
      lines = [
        {
          workspaceId,
          companyId,
          accountId: bankLedgerAccountId,
          debit: amount,
          credit: 0,
          narration: txNarration,
        },
        {
          workspaceId,
          companyId,
          accountId: offsetLedgerAccountId,
          debit: 0,
          credit: amount,
          narration: txNarration,
        },
      ];
    } else {
      lines = [
        {
          workspaceId,
          companyId,
          accountId: offsetLedgerAccountId,
          debit: amount,
          credit: 0,
          narration: txNarration,
        },
        {
          workspaceId,
          companyId,
          accountId: bankLedgerAccountId,
          debit: 0,
          credit: amount,
          narration: txNarration,
        },
      ];
    }

    const isPendingShiftClose = payload.status === BANK_TRANSACTION_STATUS.PENDING_SHIFT_CLOSE;

    // 6. Create journal voucher (always created as DRAFT, then posted)
    const journalVoucher = await journalVoucherRepository.createVoucher(
      {
        workspaceId,
        companyId,
        voucherNumber,
        voucherDate: txDate,
        voucherType,
        referenceNumber: referenceNumber || null,
        narration: txNarration,
        totalDebit: amount,
        totalCredit: amount,
        createdBy: userId,
        status: VOUCHER_STATUS.DRAFT,
      },
      { session },
    );

    // 7. Add voucherId to lines and save
    const linesWithVoucher = lines.map((l) => ({
      ...l,
      voucherId: journalVoucher._id,
    }));
    await journalLineRepository.createLines(linesWithVoucher, { session });

    // 8. Post the voucher immediately ONLY if not held for shift close
    if (!isPendingShiftClose) {
      await journalPostingService.postJournalVoucher(
        journalVoucher._id,
        companyId,
        workspaceId,
        userId,
        { session },
      );
    }

    // 9. Save the Bank Transaction record
    const txPayload = {
      workspaceId,
      companyId,
      transactionNumber,
      transactionDate: txDate,
      bankAccountId,
      transactionType,
      paymentMode: payload.paymentMode || resolvePaymentMode(transactionType),
      category: payload.category || null,
      direction,
      amount,
      referenceNumber: referenceNumber || null,
      narration: narration || null,
      counterpartyAccountId: offsetLedgerAccountId,
      journalVoucherId: journalVoucher._id,
      shiftId: payload.shiftId || null,
      status: payload.status || BANK_TRANSACTION_STATUS.POSTED,
      postedAt: payload.status === BANK_TRANSACTION_STATUS.PENDING_SHIFT_CLOSE ? null : new Date(),
      postedBy: payload.status === BANK_TRANSACTION_STATUS.PENDING_SHIFT_CLOSE ? null : userId,
      createdBy: userId,
    };

    const bankTransaction =
      await bankTransactionRepository.createBankTransaction(txPayload, {
        session,
      });

    if (!providedSession) {
      await session.commitTransaction();
      session.endSession();
    }

    return getBankTransactionById(bankTransaction._id, companyId, workspaceId);
  } catch (error) {
    if (!providedSession) {
      await session.abortTransaction();
      session.endSession();
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// GET BANK TRANSACTIONS (LIST)
// ---------------------------------------------------------------------------
const getBankTransactions = async (workspaceId, companyId, query = {}) => {
  const { page, limit, sort, all, sortBy, sortOrder, ...filters } = query;
  const result = await bankTransactionRepository.getBankTransactions(
    workspaceId,
    companyId,
    filters,
    { page, limit, sort, all: all === "true" || all === true, sortBy, sortOrder },
  );

  return {
    bankTransactions: result.bankTransactions.map((bt) =>
      bt.toSafeObject ? bt.toSafeObject() : bt,
    ),
    total: result.total,
    page: result.page,
    limit: result.limit,
    summary: result.summary,
  };
};

// ---------------------------------------------------------------------------
// GET BANK TRANSACTION BY ID
// ---------------------------------------------------------------------------
const getBankTransactionById = async (id, companyId, workspaceId) => {
  const bankTransaction =
    await bankTransactionRepository.findBankTransactionByIdCompanyAndWorkspace(
      id,
      companyId,
      workspaceId,
    );
  if (!bankTransaction) {
    throw new ApiError(404, "Bank Transaction not found");
  }
  return bankTransaction.toSafeObject();
};

// ---------------------------------------------------------------------------
// CANCEL BANK TRANSACTION
// ---------------------------------------------------------------------------
const cancelBankTransaction = async (
  id,
  companyId,
  workspaceId,
  userId,
  payload,
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const bankTransaction = await mongoose
      .model("BankTransaction")
      .findOne({ _id: id, companyId, workspaceId, isDeleted: false })
      .session(session);

    if (!bankTransaction) {
      throw new ApiError(404, "Bank Transaction not found");
    }

    if (bankTransaction.status === BANK_TRANSACTION_STATUS.CANCELLED) {
      throw new ApiError(400, "Bank Transaction is already cancelled");
    }

    await session.commitTransaction();
    session.endSession();

    // Reverse the journal voucher (manages its own session internally)
    if (
      bankTransaction.status === BANK_TRANSACTION_STATUS.POSTED &&
      bankTransaction.journalVoucherId
    ) {
      await journalCancellationService.cancelJournalVoucher(
        bankTransaction.journalVoucherId,
        companyId,
        workspaceId,
        userId,
      );
    }

    // Update the bank transaction status
    await mongoose.model("BankTransaction").updateOne(
      { _id: bankTransaction._id },
      {
        $set: {
          status: BANK_TRANSACTION_STATUS.CANCELLED,
          cancelledAt: new Date(),
          cancelledBy: userId,
          cancellationReason: payload?.reason || null,
        },
      },
    );

    return getBankTransactionById(bankTransaction._id, companyId, workspaceId);
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch (_) {
      /* already committed or aborted */
    }
    session.endSession();
    throw error;
  }
};

// ---------------------------------------------------------------------------
// DIRECT DEPOSIT (Always Directly POSTED - Real Bank Inward)
// ---------------------------------------------------------------------------
const directDeposit = async (workspaceId, companyId, userId, payload) => {
  const {
    bankAccountId,
    amount,
    paymentMode = BANK_TRANSACTION_PAYMENT_MODE.CASH,
    category = BANK_TRANSACTION_CATEGORY.CAPITAL_INFUSION,
    counterpartyAccountId,
    transactionDate,
    referenceNumber,
    narration,
  } = payload;

  if (!amount || Number(amount) <= 0) {
    throw new ApiError(400, "Deposit amount must be greater than zero");
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Verify active BankAccount
    const bankAccount = await BankAccount.findOne({
      _id: bankAccountId,
      companyId,
      workspaceId,
      isDeleted: false,
      isActive: true,
    }).session(session);

    if (!bankAccount) {
      throw new ApiError(400, "Bank Account not found or inactive");
    }

    const bankLedgerAccountId = bankAccount.ledgerAccountId;

    // 2. Resolve offset ledger account based on category
    let offsetLedgerAccountId = null;
    if (counterpartyAccountId) {
      const acct = await Account.findOne({
        _id: counterpartyAccountId,
        companyId,
        isDeleted: false,
      }).session(session);
      if (!acct) throw new ApiError(400, "Counterparty account not found");
      offsetLedgerAccountId = acct._id;
    } else if (category === BANK_TRANSACTION_CATEGORY.CAPITAL_INFUSION) {
      const capitalAccount = await findOrCreateSystemAccount(
        workspaceId,
        companyId,
        userId,
        "SYS-OWNERS-CAPITAL",
        "Owner's Capital Infusion",
        "EQUITY",
        "EQUITY",
        "EQUITY_CAPITAL",
        "Capital & Equity",
        session,
      );
      offsetLedgerAccountId = capitalAccount._id;
    } else if (category === BANK_TRANSACTION_CATEGORY.DIRECT_INCOME) {
      const incomeAccount = await findOrCreateSystemAccount(
        workspaceId,
        companyId,
        userId,
        "SYS-MISC-INCOME",
        "Miscellaneous Income",
        "INCOME",
        "INCOME",
        "SYS-MISC-INCOME-GRP",
        "Miscellaneous Income",
        session,
      );
      offsetLedgerAccountId = incomeAccount._id;
    } else {
      throw new ApiError(
        400,
        "Counterparty account is required for the selected category",
      );
    }

    // 3. Generate unique transaction number
    const transactionNumber =
      await bankTransactionRepository.getNextTransactionNumber(
        companyId,
        workspaceId,
        { session },
      );

    // 4. Generate voucher number (Receipt Voucher)
    const voucherNumber = await voucherNumberService.generateVoucherNumber(
      companyId,
      workspaceId,
      VOUCHER_TYPE.RECEIPT,
      { session },
    );

    const txDate = parseISTTransactionDate(transactionDate);
    const txNarration =
      narration ||
      `Direct Bank Deposit (${paymentMode}) - ${transactionNumber}`;

    // 5. Build Journal Lines (DEPOSIT: Debit Bank A/c, Credit Offset A/c)
    const lines = [
      {
        workspaceId,
        companyId,
        accountId: bankLedgerAccountId,
        debit: Number(amount),
        credit: 0,
        narration: txNarration,
      },
      {
        workspaceId,
        companyId,
        accountId: offsetLedgerAccountId,
        debit: 0,
        credit: Number(amount),
        narration: txNarration,
      },
    ];

    // 6. Create Journal Voucher (will be posted immediately in step 7)
    const journalVoucher = await journalVoucherRepository.createVoucher(
      {
        workspaceId,
        companyId,
        voucherNumber,
        voucherDate: txDate,
        voucherType: VOUCHER_TYPE.RECEIPT,
        referenceNumber: referenceNumber || null,
        narration: txNarration,
        totalDebit: Number(amount),
        totalCredit: Number(amount),
        createdBy: userId,
      },
      { session },
    );

    const linesWithVoucher = lines.map((l) => ({
      ...l,
      voucherId: journalVoucher._id,
    }));
    await journalLineRepository.createLines(linesWithVoucher, { session });

    // 7. Post Journal Voucher immediately (updates AccountBalance & writes to Ledger)
    await journalPostingService.postJournalVoucher(
      journalVoucher._id,
      companyId,
      workspaceId,
      userId,
      { session },
    );

    // 8. Save Bank Transaction (always directly POSTED, zero shift dependency)
    const txPayload = {
      workspaceId,
      companyId,
      transactionNumber,
      transactionDate: txDate,
      bankAccountId,
      transactionType: BANK_TRANSACTION_TYPE.DEPOSIT,
      paymentMode,
      category,
      direction: BANK_TRANSACTION_DIRECTION.CREDIT,
      amount: Number(amount),
      referenceNumber: referenceNumber || null,
      narration: txNarration,
      counterpartyAccountId: offsetLedgerAccountId,
      journalVoucherId: journalVoucher._id,
      shiftId: null,
      status: BANK_TRANSACTION_STATUS.POSTED,
      postedAt: new Date(),
      postedBy: userId,
      createdBy: userId,
    };

    const bankTransaction =
      await bankTransactionRepository.createBankTransaction(txPayload, {
        session,
      });

    await session.commitTransaction();
    session.endSession();

    return getBankTransactionById(bankTransaction._id, companyId, workspaceId);
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch (_) {
      /* already committed or aborted */
    }
    session.endSession();
    throw error;
  }
};

// ---------------------------------------------------------------------------
// DIRECT WITHDRAWAL (Always Directly POSTED - Real Bank Outward)
// ---------------------------------------------------------------------------
const directWithdraw = async (workspaceId, companyId, userId, payload) => {
  const {
    bankAccountId,
    amount,
    paymentMode = BANK_TRANSACTION_PAYMENT_MODE.CASH,
    category = BANK_TRANSACTION_CATEGORY.PERSONAL_USE,
    counterpartyAccountId,
    transactionDate,
    referenceNumber,
    narration,
  } = payload;

  if (!amount || Number(amount) <= 0) {
    throw new ApiError(400, "Withdrawal amount must be greater than zero");
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Verify active BankAccount
    const bankAccount = await BankAccount.findOne({
      _id: bankAccountId,
      companyId,
      workspaceId,
      isDeleted: false,
      isActive: true,
    }).session(session);

    if (!bankAccount) {
      throw new ApiError(400, "Bank Account not found or inactive");
    }

    const bankLedgerAccountId = bankAccount.ledgerAccountId;

    // 2. Resolve offset ledger account based on category
    let offsetLedgerAccountId = null;
    if (counterpartyAccountId) {
      const acct = await Account.findOne({
        _id: counterpartyAccountId,
        companyId,
        isDeleted: false,
      }).session(session);
      if (!acct) throw new ApiError(400, "Counterparty account not found");
      offsetLedgerAccountId = acct._id;
    } else if (category === BANK_TRANSACTION_CATEGORY.PERSONAL_USE) {
      const drawingsAccount = await findOrCreateSystemAccount(
        workspaceId,
        companyId,
        userId,
        "SYS-OWNERS-DRAWINGS",
        "Owner's Drawings / Personal Withdrawals",
        "EQUITY",
        "EQUITY",
        "EQUITY_CAPITAL",
        "Capital & Equity",
        session,
      );
      offsetLedgerAccountId = drawingsAccount._id;
    } else if (category === BANK_TRANSACTION_CATEGORY.DIRECT_EXPENSE) {
      const expenseAccount = await findOrCreateSystemAccount(
        workspaceId,
        companyId,
        userId,
        "SYS-DIRECT-BANK-EXPENSE",
        "Direct Bank Expense",
        "EXPENSE",
        "EXPENSE",
        "OPERATING_EXPENSES",
        "Operating Expenses",
        session,
      );
      offsetLedgerAccountId = expenseAccount._id;
    } else {
      throw new ApiError(
        400,
        "Counterparty account is required for the selected category",
      );
    }

    // 3. Generate unique transaction number
    const transactionNumber =
      await bankTransactionRepository.getNextTransactionNumber(
        companyId,
        workspaceId,
        { session },
      );

    // 4. Generate voucher number (Payment Voucher)
    const voucherNumber = await voucherNumberService.generateVoucherNumber(
      companyId,
      workspaceId,
      VOUCHER_TYPE.PAYMENT,
      { session },
    );

    const txDate = parseISTTransactionDate(transactionDate);
    const txNarration =
      narration ||
      `Direct Bank Withdrawal (${paymentMode}) - ${transactionNumber}`;

    // 5. Build Journal Lines (WITHDRAWAL: Debit Offset A/c, Credit Bank A/c)
    const lines = [
      {
        workspaceId,
        companyId,
        accountId: offsetLedgerAccountId,
        debit: Number(amount),
        credit: 0,
        narration: txNarration,
      },
      {
        workspaceId,
        companyId,
        accountId: bankLedgerAccountId,
        debit: 0,
        credit: Number(amount),
        narration: txNarration,
      },
    ];

    // 6. Create Journal Voucher (will be posted immediately in step 7)
    const journalVoucher = await journalVoucherRepository.createVoucher(
      {
        workspaceId,
        companyId,
        voucherNumber,
        voucherDate: txDate,
        voucherType: VOUCHER_TYPE.PAYMENT,
        referenceNumber: referenceNumber || null,
        narration: txNarration,
        totalDebit: Number(amount),
        totalCredit: Number(amount),
        createdBy: userId,
      },
      { session },
    );

    const linesWithVoucher = lines.map((l) => ({
      ...l,
      voucherId: journalVoucher._id,
    }));
    await journalLineRepository.createLines(linesWithVoucher, { session });

    // 7. Post Journal Voucher immediately (updates AccountBalance & writes to Ledger)
    await journalPostingService.postJournalVoucher(
      journalVoucher._id,
      companyId,
      workspaceId,
      userId,
      { session },
    );

    // 8. Save Bank Transaction (always directly POSTED, zero shift dependency)
    const txPayload = {
      workspaceId,
      companyId,
      transactionNumber,
      transactionDate: txDate,
      bankAccountId,
      transactionType: BANK_TRANSACTION_TYPE.WITHDRAWAL,
      paymentMode,
      category,
      direction: BANK_TRANSACTION_DIRECTION.DEBIT,
      amount: Number(amount),
      referenceNumber: referenceNumber || null,
      narration: txNarration,
      counterpartyAccountId: offsetLedgerAccountId,
      journalVoucherId: journalVoucher._id,
      shiftId: null,
      status: BANK_TRANSACTION_STATUS.POSTED,
      postedAt: new Date(),
      postedBy: userId,
      createdBy: userId,
    };

    const bankTransaction =
      await bankTransactionRepository.createBankTransaction(txPayload, {
        session,
      });

    await session.commitTransaction();
    session.endSession();

    return getBankTransactionById(bankTransaction._id, companyId, workspaceId);
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch (_) {
      /* already committed or aborted */
    }
    session.endSession();
    throw error;
  }
};

export default {
  createBankTransaction,
  directDeposit,
  directWithdraw,
  getBankTransactions,
  getBankTransactionById,
  cancelBankTransaction,
};
