import mongoose from "mongoose";
import ApiError from "../../../../utils/ApiError.js";
import Customer from "../models/customer.model.js";
import CustomerAdvanceTransaction from "../models/customerAdvanceTransaction.model.js";
import CustomerCreditTransaction from "../models/customerCreditTransaction.model.js";
import SalesInvoice from "../../../sales/invoices/models/invoice.model.js";
import {
  CUSTOMER_TRANSACTION_TYPE,
  CREDIT_STATUS,
} from "../constants/customer.constant.js";
import accountRepository from "../../../finance/chart-of-accounts/repositories/account.repository.js";
import accountGroupRepository from "../../../finance/chart-of-accounts/repositories/accountGroup.repository.js";
import journalVoucherService from "../../../finance/journal-vouchers/services/journalVoucher.service.js";
import voucherNumberService from "../../../finance/journal-vouchers/services/voucherNumber.service.js";
import cashTransactionService from "../../../finance/treasury/cash-management/cash-transactions/services/cashTransaction.service.js";
import cashTransactionRepository from "../../../finance/treasury/cash-management/cash-transactions/repositories/cashTransaction.repository.js";
import bankTransactionService from "../../../finance/treasury/bank-management/bank-transactions/services/bankTransaction.service.js";
import BankAccount from "../../../finance/treasury/bank-management/bank-accounts/models/bankAccount.model.js";
import PaymentQr from "../../../finance/treasury/payment-qr/models/paymentQr.model.js";
import { Shift } from "../../../operations/shifts/shift.model.js";
import branchCashService from "../../../finance/treasury/cash-management/branch-cash/services/branchCash.service.js";
import branchCashRepository from "../../../finance/treasury/cash-management/branch-cash/repositories/branchCash.repository.js";
import { getUpiClearingAccount } from "../../../finance/treasury/shared/findOrCreateSystemAccount.js";

const STANDARD_DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1];

export const decomposeCashAmount = (amount) => {
  let rem = Math.round(Number(amount) || 0);
  const result = [];
  for (const denom of STANDARD_DENOMINATIONS) {
    if (rem >= denom) {
      const count = Math.floor(rem / denom);
      rem = rem % denom;
      result.push({
        denomination: denom,
        quantity: count,
        subtotal: denom * count,
      });
    }
  }
  return result;
};

/**
 * Resolves the active open shift for a branch and company.
 * If providedShiftId is valid and currently open, returns it.
 * If not provided or not open, auto-detects the currently open shift for user / branch / company.
 * Returns shiftId ObjectId if found, null if no open shift.
 */
export const resolveShiftId = async (
  branchId,
  companyId,
  providedShiftId = null,
  userId = null,
) => {
  if (providedShiftId) {
    const shift = await Shift.findOne({ _id: providedShiftId, status: "open" })
      .select("_id shiftNo branchId")
      .lean();
    if (shift) return shift._id;
  }
  if (!companyId) return null;
  try {
    const query = { companyId, status: "open" };
    if (branchId) query.branchId = branchId;
    if (userId) query.userId = userId;
    let openShift = await Shift.findOne(query)
      .select("_id shiftNo branchId")
      .lean();
    if (!openShift && branchId) {
      // Fallback: any open shift in this branch
      openShift = await Shift.findOne({ branchId, companyId, status: "open" })
        .select("_id shiftNo branchId")
        .lean();
    }
    if (!openShift) {
      // Fallback: any open shift in this company
      openShift = await Shift.findOne({ companyId, status: "open" })
        .select("_id shiftNo branchId")
        .lean();
    }
    return openShift?._id || null;
  } catch (err) {
    console.warn(
      "[customerAdvance.service] resolveShiftId failed:",
      err.message,
    );
    return null;
  }
};

/**
 * Ensures the company-wide "Customer Advance" liability ledger account exists.
 * Code: CUST-ADVANCE, Group: CURRENT_LIABILITIES, Nature: LIABILITY
 */
export const ensureCustomerAdvanceAccount = async (
  workspaceId,
  companyId,
  userId,
  session = null,
) => {
  // Check if account already exists
  let advanceAccount = await accountRepository.findAccountByCode(
    companyId,
    "CUST-ADVANCE",
    { session },
  );
  if (advanceAccount) {
    return advanceAccount;
  }

  // Find or create CURRENT_LIABILITIES group
  let currentLiabilitiesGroup = await accountGroupRepository.findGroupByCode(
    companyId,
    "CURRENT_LIABILITIES",
    { session },
  );
  if (!currentLiabilitiesGroup) {
    currentLiabilitiesGroup = await accountGroupRepository.createGroup(
      {
        workspaceId,
        companyId,
        groupCode: "CURRENT_LIABILITIES",
        groupName: "Current Liabilities",
        nature: "LIABILITY",
        isSystemGroup: true,
        createdBy: userId,
      },
      { session },
    );
  }

  // Create CUST-ADVANCE account
  advanceAccount = await accountRepository.createAccount(
    {
      workspaceId,
      companyId,
      accountCode: "CUST-ADVANCE",
      accountName: "Customer Advance",
      accountGroupId: currentLiabilitiesGroup._id,
      accountNature: "LIABILITY",
      accountCategory: "LIABILITY",
      openingBalance: 0,
      openingBalanceType: "cr",
      status: "active",
      isSystemAccount: true,
      createdBy: userId,
    },
    { session },
  );

  return advanceAccount;
};

/**
 * Ensures a Customer has an associated Ledger Account under SUNDRY_DEBTORS.
 * If not already linked, dynamically creates and links one.
 */
export const ensureCustomerLedgerAccount = async (
  customer,
  workspaceId,
  companyId,
  userId,
  session = null,
) => {
  if (customer.ledgerAccountId) {
    const existing = await accountRepository.findAccountByIdCompanyAndWorkspace(
      customer.ledgerAccountId,
      companyId,
      workspaceId,
      { session },
    );
    if (existing) return existing;
  }

  // Find or create CURRENT_ASSETS group
  let currentAssetsGroup = await accountGroupRepository.findGroupByCode(
    companyId,
    "CURRENT_ASSETS",
    { session },
  );
  if (!currentAssetsGroup) {
    currentAssetsGroup = await accountGroupRepository.createGroup(
      {
        workspaceId,
        companyId,
        groupCode: "CURRENT_ASSETS",
        groupName: "Current Assets",
        nature: "ASSET",
        parentGroupId: null,
        isSystemGroup: true,
        createdBy: userId,
      },
      { session },
    );
  }

  // Find or create SUNDRY_DEBTORS group
  let sundryDebtorsGroup = await accountGroupRepository.findGroupByCode(
    companyId,
    "SUNDRY_DEBTORS",
    { session },
  );
  if (!sundryDebtorsGroup) {
    sundryDebtorsGroup = await accountGroupRepository.createGroup(
      {
        workspaceId,
        companyId,
        groupCode: "SUNDRY_DEBTORS",
        groupName: "Sundry Debtors",
        nature: "ASSET",
        parentGroupId: currentAssetsGroup._id,
        isSystemGroup: true,
        createdBy: userId,
      },
      { session },
    );
  }

  const accCode = customer.customerCode
    ? `CUST-${customer.customerCode}`
    : `CUST-${Date.now()}`;
  const ledgerAccount = await accountRepository.createAccount(
    {
      workspaceId,
      companyId,
      accountCode: accCode,
      accountName: `${customer.name} - Customer`,
      accountGroupId: sundryDebtorsGroup._id,
      accountNature: "ASSET",
      accountCategory: "CUSTOMER",
      openingBalance: customer.openingBalance || 0,
      openingBalanceType: customer.openingBalanceType || "dr",
      status: "active",
      isSystemAccount: false,
      createdBy: userId,
    },
    { session },
  );

  await Customer.findByIdAndUpdate(
    customer._id,
    { ledgerAccountId: ledgerAccount._id },
    { session },
  );
  customer.ledgerAccountId = ledgerAccount._id;
  return ledgerAccount;
};

/**
 * Computes the real-time available advance balance for a customer.
 */
export const getAdvanceBalance = async (
  customerId,
  companyId,
  workspaceId,
  session = null,
) => {
  const result = await CustomerAdvanceTransaction.aggregate([
    {
      $match: {
        customerId: new mongoose.Types.ObjectId(customerId),
        companyId: new mongoose.Types.ObjectId(companyId),
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        status: "ACTIVE",
      },
    },
    {
      $group: {
        _id: null,
        received: {
          $sum: {
            $cond: [
              { $eq: ["$type", CUSTOMER_TRANSACTION_TYPE.ADVANCE_RECEIVED] },
              "$amount",
              0,
            ],
          },
        },
        settled: {
          $sum: {
            $cond: [
              {
                $in: [
                  "$type",
                  [
                    CUSTOMER_TRANSACTION_TYPE.ADVANCE_SETTLED,
                    CUSTOMER_TRANSACTION_TYPE.CREDIT_SETTLED,
                  ],
                ],
              },
              "$amount",
              0,
            ],
          },
        },
      },
    },
  ]).session(session);

  if (!result || result.length === 0) return 0;
  const balance = Number((result[0].received || 0) - (result[0].settled || 0));
  return Math.max(0, Math.round(balance * 100) / 100);
};

/**
 * Record an advance payment from a customer.
 * Accounting Entry:
 *   DR: Cash / Bank (Petty Cash / Bank Account)
 *   CR: Customer Advance Account (Liability)
 */
export const receiveCustomerAdvance = async (
  workspaceId,
  companyId,
  userId,
  payload,
  existingSession = null,
) => {
  const {
    customerId,
    amount,
    paymentMethod = "Cash",
    paymentDetails = {},
    branchId = null,
    shiftId = null,
    narration = null,
    date = new Date(),
  } = payload;

  const parsedAmount = Number(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new ApiError(400, "Advance amount must be a positive number");
  }

  const session = existingSession || (await mongoose.startSession());
  if (!existingSession) session.startTransaction();

  try {
    const customer = await Customer.findOne({
      _id: customerId,
      companyId,
      workspaceId,
      isDeleted: false,
    }).session(session);

    if (!customer) {
      throw new ApiError(404, "Customer not found");
    }

    const customerLedgerAccount = await ensureCustomerLedgerAccount(
      customer,
      workspaceId,
      companyId,
      userId,
      session,
    );
    const prevBalance = await getAdvanceBalance(
      customerId,
      companyId,
      workspaceId,
      session,
    );
    const newBalance = Math.round((prevBalance + parsedAmount) * 100) / 100;

    // Resolve active shift for branch/user/company
    const resolvedShiftId = await resolveShiftId(
      branchId || customer.branchId,
      companyId,
      shiftId,
      userId,
    );

    // Reliable branch resolution so BranchCash & shift linkage never fails
    let effectiveBranchId = branchId || payload.branchId;
    if (!effectiveBranchId && resolvedShiftId) {
      const shiftDoc = await Shift.findById(resolvedShiftId)
        .select("branchId")
        .lean();
      if (shiftDoc?.branchId) effectiveBranchId = shiftDoc.branchId;
    }
    if (!effectiveBranchId && customer.branchId) {
      effectiveBranchId = customer.branchId;
    }
    if (!effectiveBranchId) {
      try {
        const BranchModel = mongoose.models.Branch || mongoose.model("Branch");
        const defaultBranch = await BranchModel.findOne({
          companyId,
          isDeleted: false,
        })
          .select("_id")
          .lean();
        if (defaultBranch) effectiveBranchId = defaultBranch._id;
      } catch (brErr) {
        // branch lookup fallback
      }
    }

    if (effectiveBranchId) {
      try {
        await branchCashService.initializeBranchCash(
          workspaceId,
          companyId,
          userId,
          effectiveBranchId,
        );
      } catch (e) {
        // idempotent
      }
    }

    // Immediately increment customer's advance balance on Customer model
    await Customer.findByIdAndUpdate(
      customer._id,
      { $inc: { advanceBalance: parsedAmount } },
      { session },
    );

    // Extract cash tendered, change, payment QR, and denomination notes
    const cashTendered = Number(
      payload.cashTendered ?? paymentDetails.cashTendered ?? parsedAmount,
    );
    const changeDue = Math.max(
      0,
      Number(
        payload.changeDue ??
          paymentDetails.changeDue ??
          cashTendered - parsedAmount,
      ),
    );
    const paymentQrId =
      payload.paymentQrId || paymentDetails.paymentQrId || null;
    const rawReceivedDenoms = Array.isArray(paymentDetails.denominations)
      ? paymentDetails.denominations
      : Array.isArray(payload.denominations)
        ? payload.denominations
        : [];
    const rawReturnedDenoms = Array.isArray(
      paymentDetails.returnedDenominations,
    )
      ? paymentDetails.returnedDenominations
      : Array.isArray(payload.returnedDenominations)
        ? payload.returnedDenominations
        : [];

    const receivedDenoms =
      rawReceivedDenoms.length > 0
        ? rawReceivedDenoms
        : decomposeCashAmount(cashTendered);
    const returnedDenoms =
      changeDue > 0 && rawReturnedDenoms.length === 0
        ? decomposeCashAmount(changeDue)
        : rawReturnedDenoms;

    // Generate Customer Receipt Voucher number
    const voucherNumber = await voucherNumberService.generateVoucherNumber(
      companyId,
      workspaceId,
      "CUSTOMER_RECEIPT",
      { session },
    );

    let journalVoucher = null;
    const isCash = String(paymentMethod).toLowerCase() === "cash";
    const isUpi = String(paymentMethod).toLowerCase() === "upi";

    if (isCash) {
      // Find Petty Cash Account
      const cashAccountsRes = await accountRepository.getAccounts(
        workspaceId,
        companyId,
        {
          accountCategory: "CASH",
        },
      );
      const cashAccounts = cashAccountsRes?.accounts || [];
      const cashAccount =
        cashAccounts.find((a) => a.accountCode === "PETTY-CASH") ||
        cashAccounts.find((a) =>
          String(a.accountName).toLowerCase().includes("cash"),
        ) ||
        cashAccounts[0];

      if (!cashAccount) {
        throw new ApiError(
          400,
          "No Cash Ledger Account found for recording advance receipt.",
        );
      }

      // Try Treasury Cash In
      let cashTxSuccess = false;
      if (effectiveBranchId) {
        try {
          const baseCashTx =
            await cashTransactionRepository.getNextTransactionNumber(
              companyId,
              workspaceId,
              { session },
            );

          const cashInPayload = {
            transactionNumber: baseCashTx,
            voucherNumber: voucherNumber,
            transactionDate: date ? new Date(date) : new Date(),
            branchId: effectiveBranchId,
            partition: "running",
            transactionType: "CASH_IN",
            direction: "CREDIT",
            amount: cashTendered > parsedAmount ? cashTendered : parsedAmount,
            referenceNumber: voucherNumber,
            narration:
              narration || `Customer Advance Received from ${customer.name}`,
            counterpartyAccountId: customerLedgerAccount._id,
            denominations: receivedDenoms,
            shiftId: resolvedShiftId || null,
          };

          const cashTxResult =
            await cashTransactionService.createCashTransaction(
              workspaceId,
              companyId,
              userId,
              cashInPayload,
              { session },
            );
          if (cashTxResult?.journalVoucherId) {
            journalVoucher = { _id: cashTxResult.journalVoucherId };
          }

          if (changeDue > 0) {
            const outCashTx =
              await cashTransactionRepository.getNextTransactionNumber(
                companyId,
                workspaceId,
                { session },
              );
            const changeVoucherNumber =
              await voucherNumberService.generateVoucherNumber(
                companyId,
                workspaceId,
                "JOURNAL",
                { session },
              );
            const cashOutPayload = {
              transactionNumber: outCashTx,
              voucherNumber: changeVoucherNumber,
              transactionDate: date ? new Date(date) : new Date(),
              branchId: effectiveBranchId,
              partition: "running",
              transactionType: "CASH_OUT",
              direction: "DEBIT",
              amount: changeDue,
              referenceNumber: voucherNumber,
              narration: `Change Returned for Customer Advance from ${customer.name}`,
              counterpartyAccountId: customerLedgerAccount._id,
              denominations: returnedDenoms,
              shiftId: resolvedShiftId || null,
            };
            await cashTransactionService.createCashTransaction(
              workspaceId,
              companyId,
              userId,
              cashOutPayload,
              { session },
            );
          }

          cashTxSuccess = true;
        } catch (ctErr) {
          console.warn(
            "Could not create treasury cash transaction for advance, applying direct drawer update:",
            ctErr.message,
          );
          try {
            // Direct guarantee: cash drawer is increased even if cash transaction service threw
            const netDenoms = decomposeCashAmount(parsedAmount);
            await branchCashRepository.addRunningDenominations(
              effectiveBranchId,
              companyId,
              netDenoms,
              userId,
              { session },
            );
          } catch (bcdErr) {
            console.warn(
              "Could not add running denominations directly:",
              bcdErr.message,
            );
          }
        }
      }

      // If treasury didn't post JV, create and post JV directly
      if (!journalVoucher) {
        const jvPayload = {
          voucherNumber,
          voucherDate: date ? new Date(date) : new Date(),
          voucherType: "CUSTOMER_RECEIPT",
          referenceNumber: voucherNumber,
          narration:
            narration ||
            `Customer Advance Received in Cash from ${customer.name}`,
          status: "POSTED",
          lines: [
            {
              accountId: cashAccount._id,
              debit: parsedAmount,
              credit: 0,
              narration: `Cash Received from ${customer.name} (Advance)`,
            },
            {
              accountId: customerLedgerAccount._id,
              debit: 0,
              credit: parsedAmount,
              narration: `Customer Advance from ${customer.name}`,
            },
          ],
        };

        journalVoucher = await journalVoucherService.createJournalVoucher(
          workspaceId,
          companyId,
          userId,
          jvPayload,
          { session },
        );
      }
    } else if (isUpi) {
      // Find Bank Account
      let bankAccount = null;
      let targetQrId = paymentQrId || paymentDetails.paymentQrId;
      if (!targetQrId && effectiveBranchId) {
        const branchPrimaryQr = await PaymentQr.findOne({
          companyId,
          branchId: effectiveBranchId,
          isDeleted: false,
          status: "ACTIVE",
          isPrimary: true,
        }).session(session);
        if (branchPrimaryQr) targetQrId = branchPrimaryQr._id;
      }
      if (targetQrId) {
        const paymentQr = await PaymentQr.findById(targetQrId).session(session);
        if (paymentQr?.bankAccountId) {
          bankAccount = await BankAccount.findOne({
            _id: paymentQr.bankAccountId,
            isDeleted: false,
            isActive: true,
          }).session(session);
        }
      }

      if (!bankAccount) {
        bankAccount =
          (await BankAccount.findOne({
            companyId,
            workspaceId,
            isDeleted: false,
            isActive: true,
            isPrimary: true,
          }).session(session)) ||
          (await BankAccount.findOne({
            companyId,
            workspaceId,
            isDeleted: false,
            isActive: true,
          }).session(session));
      }

      let bankLedgerAccountId = bankAccount?.ledgerAccountId;
      if (!bankLedgerAccountId) {
        const bankAccountsRes = await accountRepository.getAccounts(
          workspaceId,
          companyId,
          { accountCategory: "BANK" },
        );
        if (bankAccountsRes?.accounts?.length > 0) {
          bankLedgerAccountId = bankAccountsRes.accounts[0]._id;
        }
      }

      if (!bankLedgerAccountId) {
        throw new ApiError(
          400,
          "No Bank Ledger Account found for recording UPI advance receipt.",
        );
      }

      if (resolvedShiftId) {
        // HOLD IN SHIFT:
        // Do NOT create individual BankTransaction in Treasury!
        // Route through SYS-UPI-CLEARING to credit customer advance liability immediately,
        // while the Bank Account balance and Bank Transactions register remain untouched until Shift Close.
        const upiClearingAccount = await getUpiClearingAccount(
          workspaceId,
          companyId,
          userId,
          session,
        );

        const jvPayload = {
          voucherNumber,
          voucherDate: date ? new Date(date) : new Date(),
          voucherType: "CUSTOMER_RECEIPT",
          referenceNumber:
            paymentDetails.referenceNo ||
            paymentDetails.txnRefNo ||
            voucherNumber,
          narration:
            narration ||
            `Customer Advance Received (UPI) from ${customer.name} (Shift Held)`,
          status: "POSTED",
          lines: [
            {
              accountId: upiClearingAccount._id,
              debit: parsedAmount,
              credit: 0,
              narration: `UPI Advance Received from ${customer.name}`,
            },
            {
              accountId: customerLedgerAccount._id,
              debit: 0,
              credit: parsedAmount,
              narration: `Customer Advance (UPI) from ${customer.name}`,
            },
          ],
        };

        journalVoucher = await journalVoucherService.createJournalVoucher(
          workspaceId,
          companyId,
          userId,
          jvPayload,
          { session },
        );
      } else {
        // Direct advance receipt without open shift
        let bankTxSuccess = false;
        if (bankAccount) {
          try {
            const btResult = await bankTransactionService.createBankTransaction(
              workspaceId,
              companyId,
              userId,
              {
                transactionDate: date ? new Date(date) : new Date(),
                bankAccountId: bankAccount._id,
                transactionType: "UPI",
                direction: "CREDIT",
                amount: parsedAmount,
                referenceNumber:
                  paymentDetails.referenceNo ||
                  paymentDetails.txnRefNo ||
                  voucherNumber,
                narration:
                  narration || `UPI Advance Received from ${customer.name}`,
                counterpartyAccountId: customerLedgerAccount._id,
                shiftId: null,
                status: "POSTED",
              },
              { session },
            );
            if (btResult?.journalVoucherId) {
              journalVoucher = { _id: btResult.journalVoucherId };
            }
            bankTxSuccess = true;
          } catch (btErr) {
            console.warn(
              "Could not create direct treasury bank transaction for advance:",
              btErr.message,
            );
          }
        }

        if (!bankTxSuccess || !journalVoucher) {
          const jvPayload = {
            voucherNumber,
            voucherDate: date ? new Date(date) : new Date(),
            voucherType: "CUSTOMER_RECEIPT",
            referenceNumber:
              paymentDetails.referenceNo ||
              paymentDetails.txnRefNo ||
              voucherNumber,
            narration:
              narration ||
              `Customer Advance Received (UPI) from ${customer.name}`,
            status: "POSTED",
            lines: [
              {
                accountId: bankLedgerAccountId,
                debit: parsedAmount,
                credit: 0,
                narration: `UPI Received from ${customer.name} (Advance)`,
              },
              {
                accountId: customerLedgerAccount._id,
                debit: 0,
                credit: parsedAmount,
                narration: `Customer Advance (UPI) from ${customer.name}`,
              },
            ],
          };

          journalVoucher = await journalVoucherService.createJournalVoucher(
            workspaceId,
            companyId,
            userId,
            jvPayload,
            { session },
          );
        }
      }
    } else {
      throw new ApiError(
        400,
        `Unsupported payment method for advance: ${paymentMethod}. Use Cash or UPI.`,
      );
    }

    // Save CustomerAdvanceTransaction record
    const [advanceTx] = await CustomerAdvanceTransaction.create(
      [
        {
          workspaceId,
          companyId,
          branchId: effectiveBranchId,
          customerId: customer._id,
          type: CUSTOMER_TRANSACTION_TYPE.ADVANCE_RECEIVED,
          amount: parsedAmount,
          balanceAfter: newBalance,
          referenceType: "RECEIPT",
          referenceId: journalVoucher?._id || null,
          referenceNumber: voucherNumber,
          paymentMethod,
          paymentDetails,
          journalVoucherId: journalVoucher?._id || null,
          shiftId: resolvedShiftId || null,
          paymentQrId: paymentQrId || null,
          cashTendered,
          changeDue,
          denominations: receivedDenoms,
          returnedDenominations: returnedDenoms,
          narration: narration || `Advance received of ₹${parsedAmount}`,
          status: "ACTIVE",
          createdBy: userId,
        },
      ],
      { session },
    );

    if (!existingSession) await session.commitTransaction();

    return {
      success: true,
      transaction: advanceTx,
      voucherNumber,
      advanceBalance: newBalance,
      customer: {
        _id: customer._id,
        name: customer.name,
        customerCode: customer.customerCode,
      },
    };
  } catch (error) {
    if (!existingSession) await session.abortTransaction();
    throw error;
  } finally {
    if (!existingSession) session.endSession();
  }
};

/**
 * Settle outstanding credit invoices for a customer.
 * Settle modes:
 *   1. "Advance" - Clears receivable using accumulated advance balance
 *      DR: Customer Advance Account
 *      CR: Customer Ledger Account (Sundry Debtor)
 *   2. "Cash" - Customer pays cash against outstanding credit invoice
 *      DR: Cash Account
 *      CR: Customer Ledger Account
 *   3. "UPI" - Customer pays via UPI against outstanding credit invoice
 *      DR: Bank Account
 *      CR: Customer Ledger Account
 */
export const settleCustomerCredit = async (
  workspaceId,
  companyId,
  userId,
  payload,
  existingSession = null,
) => {
  const {
    customerId,
    settlements = [],
    paymentMethod = "Cash",
    paymentDetails = {},
    branchId = null,
    shiftId = null,
    narration = null,
    date = new Date(),
  } = payload;

  if (!Array.isArray(settlements) || settlements.length === 0) {
    throw new ApiError(
      400,
      "At least one credit invoice must be selected for settlement",
    );
  }

  const session = existingSession || (await mongoose.startSession());
  if (!existingSession) session.startTransaction();

  try {
    const customer = await Customer.findOne({
      _id: customerId,
      companyId,
      workspaceId,
      isDeleted: false,
    }).session(session);

    if (!customer) {
      throw new ApiError(404, "Customer not found");
    }

    if (!customer.ledgerAccountId) {
      throw new ApiError(400, "Customer does not have a linked ledger account");
    }

    const totalSettlementAmount = settlements.reduce(
      (sum, s) => sum + Number(s.amount || 0),
      0,
    );
    if (totalSettlementAmount <= 0) {
      throw new ApiError(400, "Settlement amount must be greater than 0");
    }

    // Resolve active shift for branch/user/company
    const resolvedShiftId = await resolveShiftId(
      branchId || customer.branchId,
      companyId,
      shiftId,
      userId,
    );

    // Reliable branch resolution so BranchCash & shift linkage never fails
    let effectiveBranchId = branchId || payload.branchId;
    if (!effectiveBranchId && resolvedShiftId) {
      const shiftDoc = await Shift.findById(resolvedShiftId)
        .select("branchId")
        .lean();
      if (shiftDoc?.branchId) effectiveBranchId = shiftDoc.branchId;
    }
    if (!effectiveBranchId && customer.branchId) {
      effectiveBranchId = customer.branchId;
    }
    if (!effectiveBranchId) {
      try {
        const BranchModel = mongoose.models.Branch || mongoose.model("Branch");
        const defaultBranch = await BranchModel.findOne({
          companyId,
          isDeleted: false,
        })
          .select("_id")
          .lean();
        if (defaultBranch) effectiveBranchId = defaultBranch._id;
      } catch (brErr) {
        // branch lookup fallback
      }
    }

    if (effectiveBranchId) {
      try {
        await branchCashService.initializeBranchCash(
          workspaceId,
          companyId,
          userId,
          effectiveBranchId,
        );
      } catch (e) {
        // idempotent
      }
    }

    // Extract cash tendered, change, payment QR, and denomination notes
    const cashTendered = Number(
      payload.cashTendered ??
        paymentDetails.cashTendered ??
        totalSettlementAmount,
    );
    const changeDue = Math.max(
      0,
      Number(
        payload.changeDue ??
          paymentDetails.changeDue ??
          cashTendered - totalSettlementAmount,
      ),
    );
    const paymentQrId =
      payload.paymentQrId || paymentDetails.paymentQrId || null;
    const rawReceivedDenoms = Array.isArray(paymentDetails.denominations)
      ? paymentDetails.denominations
      : Array.isArray(payload.denominations)
        ? payload.denominations
        : [];
    const rawReturnedDenoms = Array.isArray(
      paymentDetails.returnedDenominations,
    )
      ? paymentDetails.returnedDenominations
      : Array.isArray(payload.returnedDenominations)
        ? payload.returnedDenominations
        : [];

    const receivedDenoms =
      rawReceivedDenoms.length > 0
        ? rawReceivedDenoms
        : decomposeCashAmount(cashTendered);
    const returnedDenoms =
      changeDue > 0 && rawReturnedDenoms.length === 0
        ? decomposeCashAmount(changeDue)
        : rawReturnedDenoms;

    const voucherNumber = await voucherNumberService.generateVoucherNumber(
      companyId,
      workspaceId,
      "CUSTOMER_RECEIPT",
      { session },
    );

    let journalVoucher = null;
    let advanceTx = null;

    if (paymentMethod === "Advance") {
      const currentAdvance = await getAdvanceBalance(
        customerId,
        companyId,
        workspaceId,
        session,
      );
      if (currentAdvance < totalSettlementAmount - 0.01) {
        throw new ApiError(
          400,
          `Insufficient advance balance. Available: ₹${currentAdvance.toFixed(2)}, Required: ₹${totalSettlementAmount.toFixed(2)}`,
        );
      }

      const advanceAccount = await ensureCustomerAdvanceAccount(
        workspaceId,
        companyId,
        userId,
        session,
      );

      // JV: DR Customer Advance Account, CR Customer Ledger Account
      const jvPayload = {
        voucherNumber,
        voucherDate: date ? new Date(date) : new Date(),
        voucherType: "CUSTOMER_RECEIPT",
        referenceNumber: voucherNumber,
        narration:
          narration ||
          `Credit settlement using customer advance for ${customer.name}`,
        status: "POSTED",
        lines: [
          {
            accountId: advanceAccount._id,
            debit: totalSettlementAmount,
            credit: 0,
            narration: `Advance deduction for credit settlement (${customer.name})`,
          },
          {
            accountId: customer.ledgerAccountId,
            debit: 0,
            credit: totalSettlementAmount,
            narration: `Credit settlement against invoices for ${customer.name}`,
          },
        ],
      };

      journalVoucher = await journalVoucherService.createJournalVoucher(
        workspaceId,
        companyId,
        userId,
        jvPayload,
        { session },
      );

      const newAdvanceBalance = Math.max(
        0,
        Math.round((currentAdvance - totalSettlementAmount) * 100) / 100,
      );

      // Decrement advance balance on Customer model
      await Customer.findByIdAndUpdate(
        customer._id,
        { $inc: { advanceBalance: -totalSettlementAmount } },
        { session },
      );

      const [advTxDoc] = await CustomerAdvanceTransaction.create(
        [
          {
            workspaceId,
            companyId,
            branchId: effectiveBranchId,
            customerId: customer._id,
            type: CUSTOMER_TRANSACTION_TYPE.CREDIT_SETTLED,
            amount: totalSettlementAmount,
            balanceAfter: newAdvanceBalance,
            referenceType: "RECEIPT",
            referenceId: journalVoucher?._id || null,
            referenceNumber: voucherNumber,
            paymentMethod: "Advance",
            journalVoucherId: journalVoucher?._id || null,
            shiftId: resolvedShiftId || null,
            narration:
              narration ||
              `Credit settled using advance of ₹${totalSettlementAmount}`,
            status: "ACTIVE",
            createdBy: userId,
          },
        ],
        { session },
      );
      advanceTx = advTxDoc;
    } else if (paymentMethod === "Cash") {
      const cashAccountsRes = await accountRepository.getAccounts(
        workspaceId,
        companyId,
        { accountCategory: "CASH" },
      );
      const cashAccounts = cashAccountsRes?.accounts || [];
      const cashAccount =
        cashAccounts.find((a) => a.accountCode === "PETTY-CASH") ||
        cashAccounts.find((a) =>
          String(a.accountName).toLowerCase().includes("cash"),
        ) ||
        cashAccounts[0];

      if (!cashAccount) {
        throw new ApiError(
          400,
          "No Cash Ledger Account found for cash settlement.",
        );
      }

      // Try Treasury Cash In
      let cashTxSuccess = false;
      if (effectiveBranchId) {
        try {
          const baseCashTx =
            await cashTransactionRepository.getNextTransactionNumber(
              companyId,
              workspaceId,
              { session },
            );

          const cashInPayload = {
            transactionNumber: baseCashTx,
            voucherNumber,
            transactionDate: date ? new Date(date) : new Date(),
            branchId: effectiveBranchId,
            partition: "running",
            transactionType: "CASH_IN",
            direction: "CREDIT",
            amount:
              cashTendered > totalSettlementAmount
                ? cashTendered
                : totalSettlementAmount,
            referenceNumber: voucherNumber,
            narration:
              narration ||
              `Cash received for credit settlement from ${customer.name}`,
            counterpartyAccountId: customer.ledgerAccountId,
            denominations: receivedDenoms,
            shiftId: resolvedShiftId || null,
          };

          const cashTxResult =
            await cashTransactionService.createCashTransaction(
              workspaceId,
              companyId,
              userId,
              cashInPayload,
              { session },
            );
          if (cashTxResult?.journalVoucherId) {
            journalVoucher = { _id: cashTxResult.journalVoucherId };
          }

          if (changeDue > 0) {
            const outCashTx =
              await cashTransactionRepository.getNextTransactionNumber(
                companyId,
                workspaceId,
                { session },
              );
            const changeVoucherNumber =
              await voucherNumberService.generateVoucherNumber(
                companyId,
                workspaceId,
                "JOURNAL",
                { session },
              );
            const cashOutPayload = {
              transactionNumber: outCashTx,
              voucherNumber: changeVoucherNumber,
              transactionDate: date ? new Date(date) : new Date(),
              branchId: effectiveBranchId,
              partition: "running",
              transactionType: "CASH_OUT",
              direction: "DEBIT",
              amount: changeDue,
              referenceNumber: voucherNumber,
              narration: `Change Returned for Credit Settlement from ${customer.name}`,
              counterpartyAccountId: customer.ledgerAccountId,
              denominations: returnedDenoms,
              shiftId: resolvedShiftId || null,
            };
            await cashTransactionService.createCashTransaction(
              workspaceId,
              companyId,
              userId,
              cashOutPayload,
              { session },
            );
          }

          cashTxSuccess = true;
        } catch (ctErr) {
          console.warn(
            "Could not create treasury cash transaction for settlement, applying direct drawer update:",
            ctErr.message,
          );
          try {
            const netDenoms = decomposeCashAmount(totalSettlementAmount);
            await branchCashRepository.addRunningDenominations(
              effectiveBranchId,
              companyId,
              netDenoms,
              userId,
              { session },
            );
          } catch (bcdErr) {
            console.warn(
              "Could not add running denominations directly:",
              bcdErr.message,
            );
          }
        }
      }

      if (!journalVoucher) {
        const jvPayload = {
          voucherNumber,
          voucherDate: date ? new Date(date) : new Date(),
          voucherType: "CUSTOMER_RECEIPT",
          referenceNumber: voucherNumber,
          narration:
            narration ||
            `Cash settlement for credit invoices from ${customer.name}`,
          status: "POSTED",
          lines: [
            {
              accountId: cashAccount._id,
              debit: totalSettlementAmount,
              credit: 0,
              narration: `Cash Received for Credit Settlement from ${customer.name}`,
            },
            {
              accountId: customer.ledgerAccountId,
              debit: 0,
              credit: totalSettlementAmount,
              narration: `Credit settlement offset for ${customer.name}`,
            },
          ],
        };

        journalVoucher = await journalVoucherService.createJournalVoucher(
          workspaceId,
          companyId,
          userId,
          jvPayload,
          { session },
        );
      }

      // Create mirroring CustomerAdvanceTransaction so shift aggregation finds it
      const [cashAdvTxDoc] = await CustomerAdvanceTransaction.create(
        [
          {
            workspaceId,
            companyId,
            branchId: effectiveBranchId,
            customerId: customer._id,
            type: CUSTOMER_TRANSACTION_TYPE.CREDIT_SETTLED,
            amount: totalSettlementAmount,
            balanceAfter: 0,
            referenceType: "RECEIPT",
            referenceId: journalVoucher?._id || null,
            referenceNumber: voucherNumber,
            paymentMethod: "Cash",
            journalVoucherId: journalVoucher?._id || null,
            shiftId: resolvedShiftId || null,
            paymentQrId: null,
            cashTendered,
            changeDue,
            denominations: receivedDenoms,
            returnedDenominations: returnedDenoms,
            narration:
              narration || `Credit settled in cash for ${customer.name}`,
            status: "ACTIVE",
            createdBy: userId,
          },
        ],
        { session },
      );
      advanceTx = cashAdvTxDoc;
    } else if (paymentMethod === "UPI") {
      let bankAccount = null;
      let targetQrId = paymentQrId || paymentDetails.paymentQrId;
      if (!targetQrId && effectiveBranchId) {
        const branchPrimaryQr = await PaymentQr.findOne({
          companyId,
          branchId: effectiveBranchId,
          isDeleted: false,
          status: "ACTIVE",
          isPrimary: true,
        }).session(session);
        if (branchPrimaryQr) targetQrId = branchPrimaryQr._id;
      }
      if (targetQrId) {
        const paymentQr = await PaymentQr.findById(targetQrId).session(session);
        if (paymentQr?.bankAccountId) {
          bankAccount = await BankAccount.findOne({
            _id: paymentQr.bankAccountId,
            isDeleted: false,
            isActive: true,
          }).session(session);
        }
      }

      if (!bankAccount) {
        bankAccount =
          (await BankAccount.findOne({
            companyId,
            workspaceId,
            isDeleted: false,
            isActive: true,
            isPrimary: true,
          }).session(session)) ||
          (await BankAccount.findOne({
            companyId,
            workspaceId,
            isDeleted: false,
            isActive: true,
          }).session(session));
      }

      let bankLedgerAccountId = bankAccount?.ledgerAccountId;
      if (!bankLedgerAccountId) {
        const bankAccountsRes = await accountRepository.getAccounts(
          workspaceId,
          companyId,
          { accountCategory: "BANK" },
        );
        if (bankAccountsRes?.accounts?.length > 0) {
          bankLedgerAccountId = bankAccountsRes.accounts[0]._id;
        }
      }

      if (!bankLedgerAccountId) {
        throw new ApiError(
          400,
          "No Bank Ledger Account found for UPI credit settlement.",
        );
      }

      if (resolvedShiftId) {
        // HOLD IN SHIFT:
        // Do NOT create individual BankTransaction in Treasury!
        // Route through SYS-UPI-CLEARING to credit customer debtor balance immediately,
        // while the Bank Account balance and Bank Transactions register remain untouched until Shift Close.
        const upiClearingAccount = await getUpiClearingAccount(
          workspaceId,
          companyId,
          userId,
          session,
        );

        const jvPayload = {
          voucherNumber,
          voucherDate: date ? new Date(date) : new Date(),
          voucherType: "CUSTOMER_RECEIPT",
          referenceNumber:
            paymentDetails.referenceNo ||
            paymentDetails.txnRefNo ||
            voucherNumber,
          narration:
            narration ||
            `UPI credit settlement from ${customer.name} (Shift Held)`,
          status: "POSTED",
          lines: [
            {
              accountId: upiClearingAccount._id,
              debit: totalSettlementAmount,
              credit: 0,
              narration: `UPI Received for Credit Settlement from ${customer.name}`,
            },
            {
              accountId: customer.ledgerAccountId,
              debit: 0,
              credit: totalSettlementAmount,
              narration: `Credit settlement offset for ${customer.name}`,
            },
          ],
        };

        journalVoucher = await journalVoucherService.createJournalVoucher(
          workspaceId,
          companyId,
          userId,
          jvPayload,
          { session },
        );
      } else {
        // Direct credit settlement without open shift
        let bankTxSuccess = false;
        if (bankAccount) {
          try {
            const btResult = await bankTransactionService.createBankTransaction(
              workspaceId,
              companyId,
              userId,
              {
                transactionDate: date ? new Date(date) : new Date(),
                bankAccountId: bankAccount._id,
                transactionType: "UPI",
                direction: "CREDIT",
                amount: totalSettlementAmount,
                referenceNumber:
                  paymentDetails.referenceNo ||
                  paymentDetails.txnRefNo ||
                  voucherNumber,
                narration:
                  narration ||
                  `UPI received for credit settlement from ${customer.name}`,
                counterpartyAccountId: customer.ledgerAccountId,
                shiftId: null,
                status: "POSTED",
              },
              { session },
            );
            if (btResult?.journalVoucherId) {
              journalVoucher = { _id: btResult.journalVoucherId };
            }
            bankTxSuccess = true;
          } catch (btErr) {
            console.warn(
              "Could not create direct treasury bank transaction for credit settlement:",
              btErr.message,
            );
          }
        }

        if (!bankTxSuccess || !journalVoucher) {
          const jvPayload = {
            voucherNumber,
            voucherDate: date ? new Date(date) : new Date(),
            voucherType: "CUSTOMER_RECEIPT",
            referenceNumber:
              paymentDetails.referenceNo ||
              paymentDetails.txnRefNo ||
              voucherNumber,
            narration:
              narration || `UPI credit settlement from ${customer.name}`,
            status: "POSTED",
            lines: [
              {
                accountId: bankLedgerAccountId,
                debit: totalSettlementAmount,
                credit: 0,
                narration: `UPI Received for Credit Settlement from ${customer.name}`,
              },
              {
                accountId: customer.ledgerAccountId,
                debit: 0,
                credit: totalSettlementAmount,
                narration: `Credit settlement offset for ${customer.name}`,
              },
            ],
          };

          journalVoucher = await journalVoucherService.createJournalVoucher(
            workspaceId,
            companyId,
            userId,
            jvPayload,
            { session },
          );
        }
      }

      // Create mirroring CustomerAdvanceTransaction so shift aggregation finds it
      const [upiAdvTxDoc] = await CustomerAdvanceTransaction.create(
        [
          {
            workspaceId,
            companyId,
            branchId: effectiveBranchId,
            customerId: customer._id,
            type: CUSTOMER_TRANSACTION_TYPE.CREDIT_SETTLED,
            amount: totalSettlementAmount,
            balanceAfter: 0,
            referenceType: "RECEIPT",
            referenceId: journalVoucher?._id || null,
            referenceNumber: voucherNumber,
            paymentMethod: "UPI",
            journalVoucherId: journalVoucher?._id || null,
            shiftId: resolvedShiftId || null,
            paymentQrId: paymentQrId || null,
            cashTendered: totalSettlementAmount,
            changeDue: 0,
            denominations: [],
            returnedDenominations: [],
            narration:
              narration || `Credit settled via UPI for ${customer.name}`,
            status: "ACTIVE",
            createdBy: userId,
          },
        ],
        { session },
      );
      advanceTx = upiAdvTxDoc;
    } else {
      throw new ApiError(400, `Unsupported payment method: ${paymentMethod}`);
    }

    // Now update individual credit transactions & invoices
    const processedSettlements = [];

    for (const item of settlements) {
      const itemAmount = Number(item.amount || 0);
      if (itemAmount <= 0) continue;

      const creditTx = await CustomerCreditTransaction.findOne({
        _id: item.creditTransactionId || item.id,
        customerId: customer._id,
        companyId,
        workspaceId,
      }).session(session);

      if (!creditTx) {
        throw new ApiError(
          404,
          `Credit transaction not found: ${item.creditTransactionId || item.id}`,
        );
      }

      if (creditTx.status === "SETTLED") {
        throw new ApiError(
          400,
          `Invoice ${creditTx.invoiceNo} is already fully settled`,
        );
      }

      if (itemAmount > creditTx.balanceDue + 0.01) {
        throw new ApiError(
          400,
          `Settlement amount (₹${itemAmount}) cannot exceed balance due (₹${creditTx.balanceDue}) for invoice ${creditTx.invoiceNo}`,
        );
      }

      const newPaid =
        Math.round((creditTx.paidAmount + itemAmount) * 100) / 100;
      const newDue = Math.max(
        0,
        Math.round((creditTx.invoiceAmount - newPaid) * 100) / 100,
      );
      const isSettled = newDue <= 0.01;
      const newStatus = isSettled ? "SETTLED" : "PARTIAL";

      creditTx.paidAmount = newPaid;
      creditTx.balanceDue = newDue;
      creditTx.status = newStatus;
      creditTx.settlements.push({
        settledAmount: itemAmount,
        settledDate: date ? new Date(date) : new Date(),
        paymentMethod,
        journalVoucherId: journalVoucher?._id || null,
        advanceTransactionId: advanceTx?._id || null,
        shiftId: resolvedShiftId || null,
        paymentQrId: paymentQrId || null,
        cashTendered,
        changeDue,
        denominations: receivedDenoms,
        returnedDenominations: returnedDenoms,
        narration: narration || `Settled ₹${itemAmount} via ${paymentMethod}`,
        createdBy: userId,
      });

      await creditTx.save({ session });

      // Update SalesInvoice
      const invoice = await SalesInvoice.findOne({
        _id: creditTx.invoiceId,
      }).session(session);
      if (invoice) {
        invoice.creditPaidAmount = newPaid;
        if (isSettled) {
          invoice.status = "Paid";
        } else {
          invoice.status = "Pending";
        }
        await invoice.save({ session });
      }

      processedSettlements.push({
        creditTransactionId: creditTx._id,
        invoiceNo: creditTx.invoiceNo,
        settledAmount: itemAmount,
        remainingDue: newDue,
        status: newStatus,
      });
    }

    if (!existingSession) await session.commitTransaction();

    const remainingAdvance = await getAdvanceBalance(
      customerId,
      companyId,
      workspaceId,
    );

    return {
      success: true,
      voucherNumber,
      totalSettled: totalSettlementAmount,
      remainingAdvanceBalance: remainingAdvance,
      settlements: processedSettlements,
    };
  } catch (error) {
    if (!existingSession) await session.abortTransaction();
    throw error;
  } finally {
    if (!existingSession) session.endSession();
  }
};

/**
 * Get all credit transactions and metrics for a customer.
 */
export const getCreditOutstanding = async (
  customerId,
  companyId,
  workspaceId,
  options = {},
) => {
  const query = {
    customerId: new mongoose.Types.ObjectId(customerId),
    companyId: new mongoose.Types.ObjectId(companyId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
  };

  if (options.status) {
    query.status = options.status;
  } else {
    query.status = { $in: ["PENDING", "PARTIAL"] };
  }

  const transactions = await CustomerCreditTransaction.find(query).sort({
    dueDate: 1,
    createdAt: -1,
  });

  const customer = await Customer.findOne({
    _id: customerId,
    companyId,
    workspaceId,
  }).select("creditLimit creditDays name customerCode");

  const totalOutstanding = transactions.reduce(
    (sum, t) => sum + Number(t.balanceDue || 0),
    0,
  );
  const now = new Date();
  const overdueInvoices = transactions.filter(
    (t) => t.dueDate && new Date(t.dueDate) < now,
  );
  const overdueTotal = overdueInvoices.reduce(
    (sum, t) => sum + Number(t.balanceDue || 0),
    0,
  );

  const advanceBalance = await getAdvanceBalance(
    customerId,
    companyId,
    workspaceId,
  );

  return {
    customer,
    transactions,
    totalOutstanding: Math.round(totalOutstanding * 100) / 100,
    advanceBalance,
    creditLimit: customer?.creditLimit || 0,
    creditDays: customer?.creditDays || 0,
    availableCredit: Math.max(
      0,
      (customer?.creditLimit || 0) - totalOutstanding,
    ),
    overdueCount: overdueInvoices.length,
    overdueTotal: Math.round(overdueTotal * 100) / 100,
  };
};

/**
 * Get combined customer financial history (Advances + Credits).
 */
export const getCustomerTransactions = async (
  customerId,
  companyId,
  workspaceId,
  options = {},
) => {
  const [advances, credits, advanceBalance] = await Promise.all([
    CustomerAdvanceTransaction.find({
      customerId,
      companyId,
      workspaceId,
    }).sort({ createdAt: -1 }),
    CustomerCreditTransaction.find({ customerId, companyId, workspaceId }).sort(
      { createdAt: -1 },
    ),
    getAdvanceBalance(customerId, companyId, workspaceId),
  ]);

  const creditOutstanding = credits
    .filter((c) => ["PENDING", "PARTIAL"].includes(c.status))
    .reduce((sum, c) => sum + Number(c.balanceDue || 0), 0);

  const now = new Date();
  const overdueCount = credits.filter(
    (c) =>
      ["PENDING", "PARTIAL"].includes(c.status) &&
      c.dueDate &&
      new Date(c.dueDate) < now,
  ).length;

  return {
    summary: {
      advanceBalance,
      creditOutstanding: Math.round(creditOutstanding * 100) / 100,
      overdueCount,
    },
    advances,
    credits,
  };
};

/**
 * Company-wide collections/receivables aggregated by customer.
 */
export const getAllPendingCredits = async (
  companyId,
  workspaceId,
  options = {},
) => {
  const matchStage = {
    companyId: new mongoose.Types.ObjectId(companyId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    status: { $in: ["PENDING", "PARTIAL"] },
  };

  const aggregatePipeline = [
    { $match: matchStage },
    {
      $group: {
        _id: "$customerId",
        invoiceCount: { $sum: 1 },
        totalAmount: { $sum: "$invoiceAmount" },
        paidAmount: { $sum: "$paidAmount" },
        totalOutstanding: { $sum: "$balanceDue" },
        oldestDueDate: { $min: "$dueDate" },
        newestInvoiceDate: { $max: "$invoiceDate" },
        invoices: {
          $push: {
            creditTransactionId: "$_id",
            invoiceId: "$invoiceId",
            invoiceNo: "$invoiceNo",
            invoiceDate: "$invoiceDate",
            invoiceAmount: "$invoiceAmount",
            paidAmount: "$paidAmount",
            balanceDue: "$balanceDue",
            dueDate: "$dueDate",
            status: "$status",
          },
        },
      },
    },
    {
      $lookup: {
        from: "customers",
        localField: "_id",
        foreignField: "_id",
        as: "customer",
      },
    },
    { $unwind: "$customer" },
    {
      $project: {
        customerId: "$_id",
        customerName: "$customer.name",
        customerCode: "$customer.customerCode",
        mobile: "$customer.mobile",
        email: "$customer.email",
        creditLimit: "$customer.creditLimit",
        creditDays: "$customer.creditDays",
        invoiceCount: 1,
        totalAmount: 1,
        paidAmount: 1,
        totalOutstanding: 1,
        oldestDueDate: 1,
        newestInvoiceDate: 1,
        invoices: 1,
      },
    },
    { $sort: { totalOutstanding: -1 } },
  ];

  const results = await CustomerCreditTransaction.aggregate(aggregatePipeline);

  // Compute stats
  const now = new Date();
  let grandTotalOutstanding = 0;
  let overdueAmount = 0;
  let overdueInvoicesCount = 0;

  for (const item of results) {
    grandTotalOutstanding += item.totalOutstanding;
    for (const inv of item.invoices) {
      if (inv.dueDate && new Date(inv.dueDate) < now) {
        overdueAmount += inv.balanceDue;
        overdueInvoicesCount += 1;
      }
    }
  }

  return {
    stats: {
      totalCustomers: results.length,
      grandTotalOutstanding: Math.round(grandTotalOutstanding * 100) / 100,
      overdueAmount: Math.round(overdueAmount * 100) / 100,
      overdueInvoicesCount,
    },
    customers: results,
  };
};

/**
 * Generate customer statement data for printable report.
 */
export const getCustomerStatement = async (
  customerId,
  companyId,
  workspaceId,
  { fromDate, toDate } = {},
) => {
  const customer = await Customer.findOne({
    _id: customerId,
    companyId,
    workspaceId,
    isDeleted: false,
  });
  if (!customer) {
    throw new ApiError(404, "Customer not found");
  }

  const dateFilter = {};
  if (fromDate) dateFilter.$gte = new Date(fromDate);
  if (toDate) {
    const end = new Date(toDate);
    end.setHours(23, 59, 59, 999);
    dateFilter.$lte = end;
  }

  const txFilter = { customerId, companyId, workspaceId };
  if (Object.keys(dateFilter).length > 0) {
    txFilter.createdAt = dateFilter;
  }

  const [advances, credits, advanceBalance] = await Promise.all([
    CustomerAdvanceTransaction.find(txFilter).sort({ createdAt: 1 }),
    CustomerCreditTransaction.find(txFilter).sort({ createdAt: 1 }),
    getAdvanceBalance(customerId, companyId, workspaceId),
  ]);

  const creditOutstanding = credits
    .filter((c) => ["PENDING", "PARTIAL"].includes(c.status))
    .reduce((sum, c) => sum + Number(c.balanceDue || 0), 0);

  return {
    customer: {
      _id: customer._id,
      name: customer.name,
      customerCode: customer.customerCode,
      mobile: customer.mobile,
      email: customer.email,
      billingAddress: customer.billingAddress,
      gstNumber: customer.gstNumber,
      creditLimit: customer.creditLimit,
      creditDays: customer.creditDays,
    },
    period: { fromDate: fromDate || null, toDate: toDate || null },
    summary: {
      advanceBalance,
      creditOutstanding: Math.round(creditOutstanding * 100) / 100,
      netReceivable: Math.max(0, creditOutstanding - advanceBalance),
    },
    advances,
    credits,
  };
};

export default {
  ensureCustomerAdvanceAccount,
  ensureCustomerLedgerAccount,
  getAdvanceBalance,
  receiveCustomerAdvance,
  settleCustomerCredit,
  getCreditOutstanding,
  getCustomerTransactions,
  getAllPendingCredits,
  getCustomerStatement,
};
