import mongoose from "mongoose";
import ApiError from "../../../../utils/ApiError.js";
import invoiceRepository from "../repositories/invoice.repository.js";
import { getBranchInitials } from "../../../../utils/branchInitials.js";
import customerRepository from "../../../parties/customers/repositories/customer.repository.js";
import branchRepository from "../../../organization/branches/repositories/branch.repository.js";
import financialPeriodRepository from "../../../finance/financial-periods/repositories/financialPeriod.repository.js";
import Batch from "../../../catalog/products/models/batch.model.js";
import ProductFacility from "../../../catalog/products/models/productFacility.model.js";
import gstLedgerRepository from "../../../finance/gst-ledger/repositories/gstLedger.repository.js";
import Company from "../../../organization/companies/models/company.model.js";
import journalVoucherService from "../../../finance/journal-vouchers/services/journalVoucher.service.js";
import accountRepository from "../../../finance/chart-of-accounts/repositories/account.repository.js";
import cashTransactionService from "../../../finance/treasury/cash-management/cash-transactions/services/cashTransaction.service.js";

import bankTransactionService from "../../../finance/treasury/bank-management/bank-transactions/services/bankTransaction.service.js";
import BankAccount from "../../../finance/treasury/bank-management/bank-accounts/models/bankAccount.model.js";
import PaymentQr from "../../../finance/treasury/payment-qr/models/paymentQr.model.js";

import voucherNumberService from "../../../finance/journal-vouchers/services/voucherNumber.service.js";
import cashTransactionRepository from "../../../finance/treasury/cash-management/cash-transactions/repositories/cashTransaction.repository.js";
import SalesInvoice from "../models/invoice.model.js";
import GstLedger from "../../../finance/gst-ledger/models/gstLedger.model.js";
import JournalVoucher from "../../../finance/journal-vouchers/models/journalVoucher.model.js";
import Ledger from "../../../finance/ledger/models/ledger.model.js";
import branchCashRepository from "../../../finance/treasury/cash-management/branch-cash/repositories/branchCash.repository.js";
import CashTransaction from "../../../finance/treasury/cash-management/cash-transactions/models/cashTransaction.model.js";
import BankTransaction from "../../../finance/treasury/bank-management/bank-transactions/models/bankTransaction.model.js";
import { Shift } from "../../../operations/shifts/shift.model.js";
import CustomerAdvanceTransaction from "../../../parties/customers/models/customerAdvanceTransaction.model.js";
import CustomerCreditTransaction from "../../../parties/customers/models/customerCreditTransaction.model.js";
import customerAdvanceService from "../../../parties/customers/services/customerAdvance.service.js";
import { CUSTOMER_TRANSACTION_TYPE, CREDIT_STATUS } from "../../../parties/customers/constants/customer.constant.js";
import Customer from "../../../parties/customers/models/customer.model.js";
import SharedContactGroup from "../../../parties/customers/models/sharedContactGroup.model.js";
import CustomerRelationship from "../../../parties/customers/models/customerRelationship.model.js";

/**
 * Validates that all cash payments have explicit denomination breakdowns
 * and that received - returned exactly equals the cash amount.
 */

const revertCashTransactionsForInvoice = async (
  invoiceNo,
  companyId,
  userId,
  session,
  refundDenominations = null,
  branchId = null,
  customerChangeDenominations = null
) => {
  const processedRefundDenoms = (Array.isArray(refundDenominations) ? refundDenominations : [])
    .map((d) => ({
      denomination: Number(d.denomination || d.val || d.note || 0),
      quantity: Number(d.quantity || d.count || d.qty || 0),
    }))
    .filter((d) => d.denomination > 0 && d.quantity > 0);

  const processedCustomerChangeDenoms = (Array.isArray(customerChangeDenominations) ? customerChangeDenominations : [])
    .map((d) => ({
      denomination: Number(d.denomination || d.val || d.note || 0),
      quantity: Number(d.quantity || d.count || d.qty || 0),
    }))
    .filter((d) => d.denomination > 0 && d.quantity > 0);

  if (processedRefundDenoms.length > 0 && (branchId || companyId)) {
    // Staff provided custom refund denominations to pay customer back from branch running cash drawer
    const resolvedBranchId = branchId;
    if (resolvedBranchId) {
      // 1. Subtract cash dispensed to customer from branch running cash drawer
      await branchCashRepository.subtractRunningDenominations(
        resolvedBranchId,
        companyId,
        processedRefundDenoms,
        userId,
        { session }
      );

      // 2. Add change received from customer back into branch running cash drawer (if any)
      if (processedCustomerChangeDenoms.length > 0) {
        await branchCashRepository.addRunningDenominations(
          resolvedBranchId,
          companyId,
          processedCustomerChangeDenoms,
          userId,
          { session }
        );
      }
    }
    // Delete linked CashTransactions
    await CashTransaction.deleteMany({ referenceNumber: invoiceNo }, { session });
  } else {
    // Default fallback: exactly reverse original note counts
    const cashTxns = await CashTransaction.find({ referenceNumber: invoiceNo }).session(session);
    for (const ct of cashTxns) {
      const processedDenominations = ct.denominations && ct.denominations.length > 0 ? ct.denominations : [];
      if (processedDenominations.length > 0) {
        const partition = ct.cashPartition || "running";
        const resolvedBranchId = ct.branchId || branchId;
        const ctDirection = ct.direction;
          
          if (ctDirection === "CREDIT") {
            if (partition === "running") {
              await branchCashRepository.subtractRunningDenominations(resolvedBranchId, companyId, processedDenominations, userId, { session });
            } else {
              await branchCashRepository.subtractFrozenDenominations(resolvedBranchId, companyId, processedDenominations, userId, { session });
            }
          } else {
            if (partition === "running") {
              await branchCashRepository.addRunningDenominations(resolvedBranchId, companyId, processedDenominations, userId, { session });
            } else {
              await branchCashRepository.addFrozenDenominations(resolvedBranchId, companyId, processedDenominations, userId, { session });
            }
          }
        }
      }
    await CashTransaction.deleteMany({ referenceNumber: invoiceNo }, { session });
  }
};

const validateCashDenominations = (saleData) => {
  const paymentsList = Array.isArray(saleData.payments) ? saleData.payments : [];
  const methodLower = String(saleData.paymentMethod || "").toLowerCase();
  const isCreditMethod = methodLower === "credit";
  const isAdvanceMethod = methodLower === "advance";

  // Skip cash denomination check if entirely non-cash (Credit or Advance)
  const allNonCash =
    paymentsList.length > 0 &&
    paymentsList.every((p) => {
      const pType = String(p.paymentType || p.mode || "").toLowerCase();
      return pType === "credit" || pType === "advance";
    });

  if (allNonCash || ((isCreditMethod || isAdvanceMethod) && paymentsList.length === 0)) {
    return;
  }

  const isCashMethod = methodLower === "cash";

  const cashPayments = [];

  if (paymentsList.length > 0) {
    for (const [index, p] of paymentsList.entries()) {
      const pType = String(p.paymentType || p.mode || "").toLowerCase();
      if (pType === "cash") {
        cashPayments.push({
          index,
          amount: Number(p.amount || 0),
          denominations: Array.isArray(p.denominations) && p.denominations.length > 0
            ? p.denominations
            : (index === 0 && Array.isArray(saleData.denominations) ? saleData.denominations : []),
          returnedDenominations: Array.isArray(p.returnedDenominations) && p.returnedDenominations.length > 0
            ? p.returnedDenominations
            : (index === 0 && Array.isArray(saleData.returnedDenominations) ? saleData.returnedDenominations : []),
        });
      }
    }
  } else if (isCashMethod) {
    cashPayments.push({
      index: 0,
      amount: Number(saleData.grandTotal || 0),
      denominations: Array.isArray(saleData.denominations) ? saleData.denominations : [],
      returnedDenominations: Array.isArray(saleData.returnedDenominations) ? saleData.returnedDenominations : [],
    });
  }

  for (const cp of cashPayments) {
    if (cp.amount <= 0) continue;

    const denoms = (Array.isArray(cp.denominations) ? cp.denominations : []).filter(
      d => Number(d.quantity) > 0 && Number(d.denomination) > 0
    );
    const returnedDenoms = (Array.isArray(cp.returnedDenominations) ? cp.returnedDenominations : []).filter(
      d => Number(d.quantity) > 0 && Number(d.denomination) > 0
    );

    if (denoms.length === 0) {
      throw new ApiError(
        400,
        `Cash payment of ₹${cp.amount.toFixed(2)} requires exact denomination breakdown. Please provide customer cash denominations.`
      );
    }

    const receivedTotal = denoms.reduce((sum, d) => sum + (Number(d.denomination) * Number(d.quantity)), 0);
    const returnedTotal = returnedDenoms.reduce((sum, d) => sum + (Number(d.denomination) * Number(d.quantity)), 0);

    if (receivedTotal < cp.amount) {
      throw new ApiError(
        400,
        `Received cash denominations total (₹${receivedTotal.toFixed(2)}) is less than required cash amount (₹${cp.amount.toFixed(2)}).`
      );
    }

    const expectedChange = Math.max(0, receivedTotal - cp.amount);
    if (Math.abs(returnedTotal - expectedChange) > 0.01) {
      throw new ApiError(
        400,
        `Change returned denominations total (₹${returnedTotal.toFixed(2)}) must exactly equal expected change (₹${expectedChange.toFixed(2)}).`
      );
    }

    const netCash = receivedTotal - returnedTotal;
    if (Math.abs(netCash - cp.amount) > 0.01) {
      throw new ApiError(
        400,
        `Net cash denomination total (₹${netCash.toFixed(2)}) does not match cash payment amount (₹${cp.amount.toFixed(2)}).`
      );
    }
  }

  // Backfill denominations to payments list if passed only at root saleData level
  if (Array.isArray(saleData.payments)) {
    const cashRow = saleData.payments.find(p => String(p.paymentType || p.mode || "").toLowerCase() === "cash");
    if (cashRow) {
      if ((!cashRow.denominations || cashRow.denominations.length === 0) && Array.isArray(saleData.denominations) && saleData.denominations.length > 0) {
        cashRow.denominations = saleData.denominations;
      }
      if ((!cashRow.returnedDenominations || cashRow.returnedDenominations.length === 0) && Array.isArray(saleData.returnedDenominations) && saleData.returnedDenominations.length > 0) {
        cashRow.returnedDenominations = saleData.returnedDenominations;
      }
    }
  }
};

/**
 * Helper to revert inventory for an invoice (add quantities back to Batch & ProductFacility)
 */
const revertInvoiceInventory = async (items, branchId, session) => {
  if (!Array.isArray(items) || items.length === 0) return;
  const batchOps = [];
  const facilityOps = [];
  const resolvedBranchId = branchId || null;

  for (const item of items) {
    const qtyToRevert = Number(item.qty || 0);
    if (qtyToRevert <= 0) continue;

    const rawBatchId = item.batchId || item.batch_id || (item.batch && item.batch._id) || item.batch;
    const productId = item.productId || item.product_id || item.workspaceProductId || item.id;

    if (rawBatchId) {
      batchOps.push({
        updateOne: {
          filter: { _id: rawBatchId },
          update: { $inc: { batchQty: qtyToRevert } },
        },
      });
    }

    if (productId && resolvedBranchId) {
      facilityOps.push({
        updateOne: {
          filter: { product_id: productId, facility_id: resolvedBranchId },
          update: { $inc: { total_qty_available: qtyToRevert, qoh: qtyToRevert, atp: qtyToRevert } },
        },
      });
    }
  }

  if (batchOps.length > 0) {
    await Batch.bulkWrite(batchOps, { session });
  }
  if (facilityOps.length > 0) {
    await ProductFacility.bulkWrite(facilityOps, { session });
  }
};

/**
 * Helper to deduct inventory for an invoice (deduct quantities from Batch & ProductFacility)
 */
const deductInvoiceInventory = async (items, branchId, session) => {
  if (!Array.isArray(items) || items.length === 0) return;
  const batchOps = [];
  const facilityOps = [];
  const resolvedBranchId = branchId || null;

  for (const item of items) {
    const qtyToDeduct = Number(item.qty || 0);
    if (qtyToDeduct <= 0) continue;

    const productId = item.productId || item.product_id || item.workspaceProductId || item.id;
    const rawBatchId = item.batchId || item.batch_id || (item.batch && item.batch._id) || item.batch;

    if (rawBatchId) {
      batchOps.push({
        updateOne: {
          filter: { _id: rawBatchId },
          update: { $inc: { batchQty: -qtyToDeduct } },
        },
      });
    }

    if (productId && resolvedBranchId) {
      facilityOps.push({
        updateOne: {
          filter: { product_id: productId, facility_id: resolvedBranchId },
          update: { $inc: { total_qty_available: -qtyToDeduct, qoh: -qtyToDeduct, atp: -qtyToDeduct } },
        },
      });
    }
  }

  if (batchOps.length > 0) {
    await Batch.bulkWrite(batchOps, { session });
  }
  if (facilityOps.length > 0) {
    await ProductFacility.bulkWrite(facilityOps, { session });
  }
};

/**
 * Helper to delete all financial & treasury entries associated with an invoice (GSTR-1, Cash, Bank, JVs)
 */
const cleanInvoiceAccountingEntries = async (
  invoiceId,
  invoiceNo,
  companyId,
  userId,
  session,
  refundDenominations = null,
  branchId = null,
  customerChangeDenominations = null
) => {
  // 1. Delete GSTR-1 entry
  await GstLedger.deleteMany({ voucherId: invoiceId }, { session });

  // 2. Delete Cash Transactions & Revert Denominations (deducting custom refund denominations & adding customer change if specified)
  await revertCashTransactionsForInvoice(
    invoiceNo,
    companyId,
    userId,
    session,
    refundDenominations,
    branchId,
    customerChangeDenominations
  );

  // 3. Delete Bank Transactions & Linked Journal Vouchers
  const bankTxQuery = {
    $or: [
      { referenceNumber: invoiceNo },
      { narration: { $regex: invoiceNo } },
    ],
  };
  const relatedBankTxs = await BankTransaction.find(bankTxQuery).session(session);
  const btJvIds = relatedBankTxs.map((bt) => bt.journalVoucherId).filter(Boolean);
  if (btJvIds.length > 0) {
    await JournalVoucher.deleteMany({ _id: { $in: btJvIds } }, { session });
    await mongoose.model("JournalLine").deleteMany({ voucherId: { $in: btJvIds } }, { session });
    await Ledger.deleteMany({ voucherId: { $in: btJvIds } }, { session });
  }
  await BankTransaction.deleteMany(bankTxQuery, { session });

  // 4. Delete any remaining Journal Vouchers linked to this invoice
  const jvQuery = {
    $or: [
      { referenceNumber: invoiceNo },
      { narration: { $regex: invoiceNo } },
    ],
  };
  const relatedJvs = await JournalVoucher.find(jvQuery).session(session);
  const remainingJvIds = relatedJvs.map((j) => j._id);
  if (remainingJvIds.length > 0) {
    await mongoose.model("JournalLine").deleteMany({ voucherId: { $in: remainingJvIds } }, { session });
    await JournalVoucher.deleteMany({ _id: { $in: remainingJvIds } }, { session });
    await Ledger.deleteMany({ voucherId: { $in: remainingJvIds } }, { session });
  }
};

/**
 * Helper to post all financial accounting, tax ledgers, cash drawer and bank transactions
 */
const postSaleAccounting = async ({
  invoice,
  saleData,
  customer,
  company,
  resolvedBranchId,
  resolvedPaymentQrId,
  salesAccountsResult,
  cashAccountsResult,
  bankAccountsResult,
  primaryBankAccount,
  defaultBankAccount,
  companyId,
  workspaceId,
  user,
  session,
}) => {
  // Concurrently resolve any missing reference accounts/company
  const [
    resolvedCompany,
    resolvedSalesAccounts,
    resolvedCashAccounts,
    resolvedBankAccounts,
    resolvedPrimaryBank,
    resolvedDefaultBank,
  ] = await Promise.all([
    company ? Promise.resolve(company) : Company.findOne({ _id: companyId, workspaceId }).session(session),
    salesAccountsResult ? Promise.resolve(salesAccountsResult) : accountRepository.getAccounts(workspaceId, companyId, { accountCategory: "SALES" }),
    cashAccountsResult ? Promise.resolve(cashAccountsResult) : accountRepository.getAccounts(workspaceId, companyId, { accountCategory: "CASH" }),
    bankAccountsResult ? Promise.resolve(bankAccountsResult) : accountRepository.getAccounts(workspaceId, companyId, { accountCategory: "BANK" }),
    primaryBankAccount !== undefined ? Promise.resolve(primaryBankAccount) : BankAccount.findOne({ companyId, workspaceId, isDeleted: false, isActive: true, isPrimary: true }).session(session),
    defaultBankAccount !== undefined ? Promise.resolve(defaultBankAccount) : BankAccount.findOne({ companyId, workspaceId, isDeleted: false, isActive: true }).session(session),
  ]);

  // 1. Auto-create GSTR-1 Entry for GST Ledger
  try {
    const totalGst = Number(invoice.tax || saleData.tax || 0);
    const halfGst = totalGst / 2;
    const taxableAmt = Number(
      saleData.taxableAmount !== undefined
        ? saleData.taxableAmount
        : (invoice.subtotal || 0) - (invoice.discount || 0)
    );

    const companyGstin = resolvedCompany?.gstin || "";
    const customerGstin = customer?.gstNumber || "";
    const hasCustomerGst = customerGstin && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(customerGstin.trim().toUpperCase());
    const grandTotal = Number(invoice.grandTotal || 0);
    const isIgst = Boolean(
      invoice.isIgst ||
      saleData?.isIgst ||
      (companyGstin && customerGstin && companyGstin.length >= 2 && customerGstin.length >= 2 && companyGstin.slice(0, 2) !== customerGstin.slice(0, 2))
    );

    let groupDescription = "B2C (Small) Invoice";
    if (invoice.isExport || String(invoice.billingMode).toUpperCase() === "EXPORT") {
      groupDescription = "Export Invoices";
    } else if (hasCustomerGst || String(invoice.billingMode).toUpperCase() === "B2B") {
      groupDescription = "B2B";
    } else if (isIgst && grandTotal > 250000) {
      groupDescription = "B2C (Large) Invoice";
    } else if (invoice.isNilRated || (totalGst === 0 && taxableAmt > 0)) {
      groupDescription = "Nil Rated";
    } else {
      groupDescription = "B2C (Small) Invoice";
    }

    await gstLedgerRepository.createGstLedgerEntry({
      workspaceId: invoice.workspaceId,
      companyId: invoice.companyId,
      branchId: invoice.branchId || null,
      partyId: customer._id,
      voucherId: invoice._id,
      voucherNumber: invoice.invoiceNo,
      voucherDate: invoice.date ? new Date(invoice.date) : new Date(),
      gstType: "GSTR-1",
      groupDescription,
      taxableAmount: taxableAmt,
      cgst: isIgst ? 0 : halfGst,
      sgst: isIgst ? 0 : halfGst,
      igst: isIgst ? totalGst : 0,
      totalAmount: grandTotal,
      narration: `Sale Bill ${invoice.invoiceNo} (${invoice.billingMode}) - Customer: ${customer.name || "Customer"}`,
    }, { session });
  } catch (gstErr) {
    console.error("Failed to auto-create GSTR-1 entry for sale bill:", gstErr);
  }

  // 2. Auto-create Journal Vouchers for Sale and Payments
  try {
    const isCashPaid = (String(invoice.paymentMethod).toLowerCase() === "cash" || Number(invoice.cashTendered) > 0) && String(invoice.status).toLowerCase() === "paid" && Number(invoice.grandTotal) > 0;
    const isUpiPaid = String(invoice.paymentMethod).toLowerCase() === "upi" && String(invoice.status).toLowerCase() === "paid" && Number(invoice.grandTotal) > 0;

    let salesAccount = null;
    if (resolvedSalesAccounts?.accounts && resolvedSalesAccounts.accounts.length > 0) {
      const accounts = resolvedSalesAccounts.accounts;
      salesAccount = accounts.find(a => a.accountCode === "SALES-REVENUE") 
                  || accounts.find(a => String(a.accountName).toLowerCase().includes("revenue")) 
                  || accounts[0];
    }
    if (!salesAccount) {
      salesAccount = await accountRepository.findAccountByCode(invoice.companyId, "SALES-REVENUE", { session });
    }
    if (!salesAccount) {
      const anyIncome = await accountRepository.getAccounts(invoice.workspaceId, invoice.companyId, { accountNature: "INCOME" }, { session });
      if (anyIncome?.accounts?.length > 0) {
        salesAccount = anyIncome.accounts[0];
      }
    }

    if (salesAccount) {
      const paymentsList = Array.isArray(saleData.payments) && saleData.payments.length > 0 
        ? [...saleData.payments]
        : (Array.isArray(invoice.payments) && invoice.payments.length > 0 ? [...invoice.payments] : []);

      const isAdvancePaid = String(invoice.paymentMethod).toLowerCase() === "advance";
      const isCreditSale = String(invoice.paymentMethod).toLowerCase() === "credit" || String(invoice.status).toLowerCase() === "credit";

      if (isCashPaid && paymentsList.length === 0) {
        paymentsList.push({
          paymentType: "cash",
          amount: invoice.grandTotal,
          denominations: Array.isArray(saleData.denominations) ? saleData.denominations : (invoice.denominations || []),
          returnedDenominations: Array.isArray(saleData.returnedDenominations) ? saleData.returnedDenominations : (invoice.returnedDenominations || [])
        });
      } else if (isUpiPaid && paymentsList.length === 0) {
        paymentsList.push({
          paymentType: "upi",
          amount: invoice.grandTotal
        });
      } else if (isAdvancePaid && paymentsList.length === 0) {
        paymentsList.push({
          paymentType: "advance",
          amount: invoice.grandTotal
        });
      } else if (isCreditSale && paymentsList.length === 0) {
        paymentsList.push({
          paymentType: "credit",
          amount: invoice.grandTotal
        });
      }

      // Compute credit and advance portions
      let creditPortion = 0;
      let advancePortion = 0;
      for (const p of paymentsList) {
        const pType = String(p.paymentType || p.mode || "").toLowerCase();
        if (pType === "credit") creditPortion += Number(p.amount || 0);
        if (pType === "advance") advancePortion += Number(p.amount || 0);
      }

      // ONLY credit sales require booking a receivable (SALE JV: Customer Dr, Sales Cr)
      // Pure Cash or UPI POS sales settle immediately and NEVER touch customer debtor ledger!
      let needsSaleJv = (customer.ledgerAccountId && creditPortion > 0) ? 1 : 0;
      let needsReceiptJv = 0;
      let needsCashTx = 0;

      for (const p of paymentsList) {
        if (String(p.paymentType || p.mode).toLowerCase() === "cash") {
          needsReceiptJv += 1;
          needsCashTx += 1; // CASH_IN
          let changeAmount = 0;
          const returnedList = p.returnedDenominations || saleData.returnedDenominations || invoice.returnedDenominations;
          if (Array.isArray(returnedList) && returnedList.length > 0) {
            changeAmount = returnedList.reduce((sum, d) => sum + (Number(d.denomination) * Number(d.quantity)), 0);
          }
          if (changeAmount > 0) {
            needsReceiptJv += 1; 
            needsCashTx += 1; // CASH_OUT
          }
        } else if (String(p.paymentType || p.mode).toLowerCase() === "upi") {
          needsReceiptJv += 1; // fallback JV
        } else if (String(p.paymentType || p.mode).toLowerCase() === "advance") {
          needsReceiptJv += 1; // Customer Advance adjustment JV
        }
      }

      const salePromises = [];
      const receiptPromises = [];
      
      if (needsSaleJv) salePromises.push(voucherNumberService.generateVoucherNumber(invoice.companyId, invoice.workspaceId, "SALE", { session }));
      for (let i = 0; i < needsReceiptJv; i++) {
        receiptPromises.push(voucherNumberService.generateVoucherNumber(invoice.companyId, invoice.workspaceId, "JOURNAL", { session }));
      }

      let baseCashTx = null;
      if (needsCashTx > 0) {
        baseCashTx = await cashTransactionRepository.getNextTransactionNumber(invoice.companyId, invoice.workspaceId, { session });
      }

      const [saleRes, receiptRes] = await Promise.all([
        Promise.all(salePromises),
        Promise.all(receiptPromises)
      ]);

      const cashTxRes = [];
      
      if (needsCashTx > 0 && baseCashTx) {
        const txParts = baseCashTx.split("-");
        const txPrefix = txParts.slice(0, 2).join("-") + "-";
        const txSeq = parseInt(txParts[txParts.length - 1]) || 1;

        for (let i = 0; i < needsCashTx; i++) {
          cashTxRes.push(`${txPrefix}${String(txSeq + i).padStart(5, "0")}`);
        }
      }

      let receiptIdx = 0, cashTxIdx = 0;
      const preSaleJv = needsSaleJv ? saleRes[0] : null;
      const nextReceiptJv = () => receiptRes[receiptIdx++];
      const nextCashTx = () => cashTxRes[cashTxIdx++];

      // 1. If customer bought on credit, create the SALE JV (Customer -> Sales) for creditPortion ONLY
      if (customer.ledgerAccountId && preSaleJv && creditPortion > 0) {
        const saleJvPayload = {
          voucherNumber: preSaleJv,
          voucherDate: invoice.date || new Date(),
          voucherType: "SALE",
          referenceNumber: invoice.invoiceNo,
          narration: `Credit Sale against Invoice ${invoice.invoiceNo} for ${customer.name || "Customer"}`,
          status: "POSTED",
          lines: [
            {
              accountId: customer.ledgerAccountId,
              debit: creditPortion,
              credit: 0,
              narration: `Credit due for Invoice ${invoice.invoiceNo}`
            },
            {
              accountId: salesAccount._id,
              debit: 0,
              credit: creditPortion,
              narration: `Sales from Invoice ${invoice.invoiceNo}`
            }
          ]
        };
        
        try {
          await journalVoucherService.createJournalVoucher(
            invoice.workspaceId,
            invoice.companyId,
            user?._id,
            saleJvPayload,
            { session }
          );
        } catch (jvErr) {
          console.error("--- FAILED TO CREATE CREDIT SALES JV ---", jvErr);
        }
      }

      // Point-of-sale instant settlements (Cash / UPI) and Advance offset directly against Sales Revenue!
      // The customer personal debtor ledger is NEVER debited or credited for Cash or UPI sales.
      const receiptCounterpartyId = salesAccount._id;
      const receiptNarrationSuffix = "Sale";

      for (const payment of paymentsList) {
        const paymentType = String(payment.paymentType || payment.mode || "").toLowerCase();
        const amount = Number(payment.amount || 0);
        
        if (amount <= 0) continue;

        if (paymentType === "cash") {
          let cashLedgerAccountId = null;
          if (resolvedCashAccounts?.accounts && resolvedCashAccounts.accounts.length > 0) {
            const accounts = resolvedCashAccounts.accounts;
            const bestCash = accounts.find(a => a.accountCode === "PETTY-CASH") 
                          || accounts.find(a => String(a.accountName).toLowerCase().includes("cash"))
                          || accounts[0];
            cashLedgerAccountId = bestCash._id;
          }

          if (cashLedgerAccountId) {
            let txSuccess = false;
            try {
              let receivedDenoms = Array.isArray(payment.denominations) && payment.denominations.length > 0
                ? payment.denominations
                : (Array.isArray(saleData.denominations) && saleData.denominations.length > 0 ? saleData.denominations : (invoice.denominations || []));
              let returnedDenoms = Array.isArray(payment.returnedDenominations) && payment.returnedDenominations.length > 0
                ? payment.returnedDenominations
                : (Array.isArray(saleData.returnedDenominations) ? saleData.returnedDenominations : (invoice.returnedDenominations || []));
              
              let receivedAmount = receivedDenoms.reduce((sum, d) => sum + (Number(d.denomination) * Number(d.quantity)), 0);

              if (receivedAmount === 0 && receivedDenoms.length === 0) {
                receivedAmount = Number(payment.amount || amount || 0);
              }

              let changeAmount = returnedDenoms.reduce((sum, d) => sum + (Number(d.denomination) * Number(d.quantity)), 0);

              // 1. Process CASH_IN for exact received amount
              const cashInPayload = {
                transactionNumber: nextCashTx(),
                voucherNumber: nextReceiptJv(),
                transactionDate: invoice.date || new Date(),
                branchId: resolvedBranchId || invoice.branchId,
                partition: "running",
                transactionType: "CASH_IN",
                direction: "CREDIT",
                amount: receivedAmount,
                referenceNumber: invoice.invoiceNo,
                narration: `Cash Received ${receiptNarrationSuffix} for Invoice ${invoice.invoiceNo}`,
                counterpartyAccountId: receiptCounterpartyId,
                denominations: receivedDenoms,
              };

              await cashTransactionService.createCashTransaction(
                invoice.workspaceId,
                invoice.companyId,
                user?._id,
                cashInPayload,
                { session }
              );

              // 2. Process CASH_OUT if change was given
              if (changeAmount > 0) {
                const cashOutPayload = {
                  transactionNumber: nextCashTx(),
                  voucherNumber: nextReceiptJv(),
                  transactionDate: invoice.date || new Date(),
                  branchId: resolvedBranchId || invoice.branchId,
                  partition: "running",
                  transactionType: "CASH_OUT",
                  direction: "DEBIT",
                  amount: changeAmount,
                  referenceNumber: invoice.invoiceNo,
                  narration: `Change Returned for Invoice ${invoice.invoiceNo}`,
                  counterpartyAccountId: receiptCounterpartyId,
                  denominations: returnedDenoms,
                };

                await cashTransactionService.createCashTransaction(
                  invoice.workspaceId,
                  invoice.companyId,
                  user?._id,
                  cashOutPayload,
                  { session }
                );
              }

              txSuccess = true;
            } catch (ctErr) {
              console.error("Failed to create cash transactions in treasury, falling back to JV:", ctErr);
            }

            if (!txSuccess) {
              const fallbackJvPayload = {
                voucherNumber: nextReceiptJv(),
                voucherDate: invoice.date || new Date(),
                voucherType: "RECEIPT",
                referenceNumber: invoice.invoiceNo,
                narration: `Cash ${receiptNarrationSuffix} for Invoice ${invoice.invoiceNo}`,
                status: "POSTED",
                lines: [
                  {
                    accountId: cashLedgerAccountId,
                    debit: amount,
                    credit: 0,
                    narration: `Cash Received for Invoice ${invoice.invoiceNo}`
                  },
                  {
                    accountId: receiptCounterpartyId,
                    debit: 0,
                    credit: amount,
                    narration: `Offset for Invoice ${invoice.invoiceNo}`
                  }
                ]
              };
              
              await journalVoucherService.createJournalVoucher(
                invoice.workspaceId,
                invoice.companyId,
                user?._id,
                fallbackJvPayload,
                { session }
              );
            }
          }
        } else if (paymentType === "upi") {
          let bankAccount = null;
          const qrIdToLookup = payment.paymentQrId || resolvedPaymentQrId || invoice.paymentQrId;
          if (qrIdToLookup) {
            const paymentQr = await PaymentQr.findById(qrIdToLookup).session(session);
            if (paymentQr && paymentQr.bankAccountId) {
              bankAccount = await BankAccount.findOne({ _id: paymentQr.bankAccountId, isDeleted: false, isActive: true }).session(session);
            }
          }
          
          if (!bankAccount) {
            bankAccount = resolvedPrimaryBank || resolvedDefaultBank;
          }

          const shouldHoldForShift = Boolean(invoice.shiftId);
          let txSuccess = false;

          if (bankAccount) {
            try {
              const bankTxPayload = {
                transactionDate: invoice.date || new Date(),
                bankAccountId: bankAccount._id,
                transactionType: "UPI",
                direction: "CREDIT",
                amount: amount,
                referenceNumber: payment.txnRefNo || payment.referenceNo || invoice.invoiceNo,
                narration: `UPI ${receiptNarrationSuffix} for Invoice ${invoice.invoiceNo}`,
                counterpartyAccountId: receiptCounterpartyId,
                shiftId: invoice.shiftId || null,
                status: shouldHoldForShift ? "PENDING_SHIFT_CLOSE" : "POSTED",
              };
              
              await bankTransactionService.createBankTransaction(
                invoice.workspaceId,
                invoice.companyId,
                user?._id,
                bankTxPayload,
                { session }
              );
              txSuccess = true;
            } catch (btErr) {
              console.error("Failed to create bank transaction, falling back to JV:", btErr);
            }
          }
          
          if (!txSuccess) {
            let bankLedgerAccountId = bankAccount?.ledgerAccountId;
            if (!bankLedgerAccountId && resolvedBankAccounts?.accounts && resolvedBankAccounts.accounts.length > 0) {
              bankLedgerAccountId = resolvedBankAccounts.accounts[0]._id;
            }
            if (bankLedgerAccountId) {
              const fallbackUpiJvPayload = {
                voucherNumber: nextReceiptJv(),
                voucherDate: invoice.date || new Date(),
                voucherType: "RECEIPT",
                referenceNumber: payment.txnRefNo || payment.referenceNo || invoice.invoiceNo,
                narration: `UPI ${receiptNarrationSuffix} for Invoice ${invoice.invoiceNo}`,
                status: shouldHoldForShift ? "DRAFT" : "POSTED",
                lines: [
                  {
                    accountId: bankLedgerAccountId,
                    debit: amount,
                    credit: 0,
                    narration: `UPI Received for Invoice ${invoice.invoiceNo}`
                  },
                  {
                    accountId: receiptCounterpartyId,
                    debit: 0,
                    credit: amount,
                    narration: `Offset for Invoice ${invoice.invoiceNo}`
                  }
                ]
              };
              
              await journalVoucherService.createJournalVoucher(
                invoice.workspaceId,
                invoice.companyId,
                user?._id,
                fallbackUpiJvPayload,
                { session }
              );
            }
          }
        } else if (paymentType === "credit") {
          // No treasury movement for credit sales.
          // The SALE JV (Customer DR, Sales CR) already books the receivable.
          // CustomerCreditTransaction is created in recordCustomerSale.
        } else if (paymentType === "advance") {
          let customerLedgerAccountId = customer?.ledgerAccountId;
          if (!customerLedgerAccountId) {
            const customerAccount = await customerAdvanceService.ensureCustomerLedgerAccount(
              customer,
              invoice.workspaceId,
              invoice.companyId,
              user?._id,
              session
            );
            customerLedgerAccountId = customerAccount?._id;
          }

          const advanceJvPayload = {
            voucherNumber: nextReceiptJv(),
            voucherDate: invoice.date || new Date(),
            voucherType: "CUSTOMER_RECEIPT",
            referenceNumber: invoice.invoiceNo,
            narration: `Payment from Customer Advance for Invoice ${invoice.invoiceNo}`,
            status: "POSTED",
            lines: [
              {
                accountId: customerLedgerAccountId,
                debit: amount,
                credit: 0,
                narration: `Customer Advance applied to Invoice ${invoice.invoiceNo}`,
              },
              {
                accountId: receiptCounterpartyId,
                debit: 0,
                credit: amount,
                narration: `Sales from Invoice ${invoice.invoiceNo} (Customer Advance)`,
              },
            ],
          };

          const advJv = await journalVoucherService.createJournalVoucher(
            invoice.workspaceId,
            invoice.companyId,
            user?._id,
            advanceJvPayload,
            { session }
          );

          const prevBalance = await customerAdvanceService.getAdvanceBalance(
            customer._id,
            invoice.companyId,
            invoice.workspaceId,
            session
          );

          await CustomerAdvanceTransaction.create(
            [
              {
                workspaceId: invoice.workspaceId,
                companyId: invoice.companyId,
                branchId: resolvedBranchId || invoice.branchId,
                customerId: customer._id,
                type: CUSTOMER_TRANSACTION_TYPE.ADVANCE_SETTLED,
                amount: amount,
                balanceAfter: Math.max(0, Math.round((prevBalance - amount) * 100) / 100),
                referenceType: "INVOICE",
                referenceId: invoice._id,
                referenceNumber: invoice.invoiceNo,
                paymentMethod: "Advance",
                journalVoucherId: advJv?._id || null,
                shiftId: invoice.shiftId || null,
                narration: `Advance applied against Invoice ${invoice.invoiceNo}`,
                status: "ACTIVE",
                createdBy: user?._id || null,
              },
            ],
            { session }
          );

          // Decrement customer advance balance on Customer document
          await Customer.findByIdAndUpdate(
            customer._id,
            { $inc: { advanceBalance: -amount } },
            { session }
          );
        }
      }
    }
  } catch (jvErr) {
    console.error("Error generating journal vouchers for sale bill:", jvErr);
  }
};

const recordCustomerSale = async (customerId, saleData, companyId, workspaceId, user = null, existingSession = null) => {
  // Enforce mandatory cash denomination breakdown
  validateCashDenominations(saleData);

  const _timingStats = [];
  const _startTotal = Date.now();
  let _lastTime = _startTotal;
  const _logTime = (label) => {
    const now = Date.now();
    _timingStats.push(`${label}: ${now - _lastTime}ms`);
    _lastTime = now;
  };

  const session = existingSession || await mongoose.startSession();
  if (!existingSession) session.startTransaction();

  try {
    _logTime('Session started');
    
    // Calculate Financial Year string early for prefix
    const saleDateObj = saleData.date ? new Date(saleData.date) : new Date();
    let earlyFyString = "";
    const month = saleDateObj.getMonth();
    const year = saleDateObj.getFullYear();
    if (month >= 3) {
      earlyFyString = `${year.toString().slice(-2)}${(year + 1).toString().slice(-2)}`;
    } else {
      earlyFyString = `${(year - 1).toString().slice(-2)}${year.toString().slice(-2)}`;
    }

    // Fetch all required reference data concurrently to eliminate sequential network latency
    const [
      customer,
      activeBranches,
      periods,
      company,
      salesAccountsResult,
      cashAccountsResult,
      bankAccountsResult,
      primaryBankAccount,
      defaultBankAccount
    ] = await Promise.all([
      customerRepository.findCustomerById(customerId, companyId, workspaceId),
      branchRepository.getCompanyBranches(companyId),
      financialPeriodRepository.getPeriods(workspaceId, companyId, { isCurrent: true, all: true }),
      Company.findOne({ _id: companyId, workspaceId }),
      accountRepository.getAccounts(workspaceId, companyId, { accountCategory: "SALES" }),
      accountRepository.getAccounts(workspaceId, companyId, { accountCategory: "CASH" }),
      accountRepository.getAccounts(workspaceId, companyId, { accountCategory: "BANK" }),
      BankAccount.findOne({ companyId, workspaceId, isDeleted: false, isActive: true, isPrimary: true }),
      BankAccount.findOne({ companyId, workspaceId, isDeleted: false, isActive: true }),
    ]);

  if (!customer) {
    throw new ApiError(404, "Customer not found");
  }

  // Resolve target branch and derive branch initials
  let resolvedBranchId = saleData.branchId || null;
  let targetBranch = null;

  if (Array.isArray(activeBranches) && activeBranches.length > 0) {
    if (resolvedBranchId) {
      targetBranch = activeBranches.find(
        (b) => b._id && b._id.toString() === resolvedBranchId.toString()
      ) || null;
    }
    if (!targetBranch) {
      targetBranch = activeBranches[0];
      resolvedBranchId = targetBranch._id;
    }
  }

  const branchInitials = getBranchInitials(targetBranch);

  let period = periods.periods && periods.periods[0];
  const financialPeriodId = period ? period._id : null;

  let fyString = earlyFyString;
  if (period && period.startDate && period.endDate) {
    const startYear = new Date(period.startDate).getFullYear();
    const endYear = new Date(period.endDate).getFullYear();
    fyString = `${startYear.toString().slice(-2)}${endYear.toString().slice(-2)}`;
  }

  const finalInvoicePrefix = `${branchInitials}-${fyString}-`;

  // Fetch the latest invoice strictly scoped to this branch and this branch prefix
  const lastInvoice = await invoiceRepository.getLatestInvoiceByPrefix(
    companyId,
    workspaceId,
    finalInvoicePrefix,
    resolvedBranchId
  );

  let sequenceNo = 1;
  if (lastInvoice && lastInvoice.invoiceNo && lastInvoice.invoiceNo.startsWith(finalInvoicePrefix)) {
    const parts = lastInvoice.invoiceNo.split('-');
    if (parts.length >= 3) {
      const lastSeq = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastSeq)) {
        sequenceNo = lastSeq + 1;
      }
    }
  }

  // Ensure generated invoice number never collides with any existing invoice in this branch
  let candidateSeq = sequenceNo;
  let finalInvoiceNo = `${finalInvoicePrefix}${candidateSeq.toString().padStart(4, '0')}`;
  let collision = await invoiceRepository.getInvoiceByInvoiceNo(companyId, workspaceId, finalInvoiceNo, resolvedBranchId);
  while (collision) {
    candidateSeq += 1;
    finalInvoiceNo = `${finalInvoicePrefix}${candidateSeq.toString().padStart(4, '0')}`;
    collision = await invoiceRepository.getInvoiceByInvoiceNo(companyId, workspaceId, finalInvoiceNo, resolvedBranchId);
  }

  // Resolve paymentQrId for UPI attribution:
  // - For single-method UPI: use top-level saleData.paymentQrId
  // - For split payments: pick paymentQrId from first UPI sub-payment
  // - For all other methods: null (backward compatible)
  let resolvedPaymentQrId = null;
  const paymentMethodUpper = String(saleData.paymentMethod || "").toUpperCase();
  if (saleData.paymentQrId) {
    resolvedPaymentQrId = saleData.paymentQrId;
  } else if (Array.isArray(saleData.payments)) {
    const upiPayment = saleData.payments.find(p =>
      String(p.paymentType || "").toUpperCase().includes("UPI") && p.paymentQrId
    );
    if (upiPayment) resolvedPaymentQrId = upiPayment.paymentQrId;
  } else if (paymentMethodUpper.includes("UPI") || paymentMethodUpper.includes("QR")) {
    resolvedPaymentQrId = null;
  }

  // Auto-resolve active open shift for branch if not explicitly provided
  let resolvedShiftId = saleData.shiftId || null;
  if (!resolvedShiftId && resolvedBranchId) {
    const activeOpenShift = await Shift.findOne({
      companyId: companyId || customer.companyId,
      branchId: resolvedBranchId,
      status: "open",
    }).session(session);
    if (activeOpenShift) {
      resolvedShiftId = activeOpenShift._id;
    }
  }

  // Compute credit and advance portions
  const grandTotal = Number(saleData.grandTotal || 0);
  const paymentsList = Array.isArray(saleData.payments) ? saleData.payments : [];
  const primaryMethodLower = String(saleData.paymentMethod || "").toLowerCase();

  let creditPortion = 0;
  let advancePortion = 0;

  if (paymentsList.length > 0) {
    for (const p of paymentsList) {
      const pType = String(p.paymentType || p.mode || "").toLowerCase();
      if (pType === "credit") creditPortion += Number(p.amount || 0);
      if (pType === "advance") advancePortion += Number(p.amount || 0);
    }
  } else {
    if (primaryMethodLower === "credit") creditPortion = grandTotal;
    if (primaryMethodLower === "advance") advancePortion = grandTotal;
  }

  // 1. Advance validation
  if (advancePortion > 0) {
    const availableAdvance = await customerAdvanceService.getAdvanceBalance(
      customer._id,
      companyId || customer.companyId,
      workspaceId || customer.workspaceId,
      session
    );
    if (availableAdvance < advancePortion - 0.01) {
      throw new ApiError(
        400,
        `Insufficient advance balance for "${customer.name}". Available: ₹${availableAdvance.toFixed(2)}, Required: ₹${advancePortion.toFixed(2)}.`
      );
    }
  }

  // 2. Credit limit validation (atomic check inside session)
  let creditDueDate = null;
  if (creditPortion > 0) {
    const customerLimit = Number(customer.creditLimit || 0);
    if (customerLimit <= 0) {
      throw new ApiError(
        400,
        `Credit sale is not allowed for customer "${customer.name}". Please configure a Credit Limit in customer profile.`
      );
    }

    const existingCredits = await CustomerCreditTransaction.aggregate([
      {
        $match: {
          customerId: customer._id,
          companyId: new mongoose.Types.ObjectId(companyId || customer.companyId),
          status: { $in: ["PENDING", "PARTIAL"] },
        },
      },
      {
        $group: {
          _id: null,
          totalDue: { $sum: "$balanceDue" },
        },
      },
    ]).session(session);

    const currentOutstanding = Number(existingCredits[0]?.totalDue || 0);
    if (currentOutstanding + creditPortion > customerLimit + 0.01) {
      throw new ApiError(
        400,
        `Credit limit exceeded for "${customer.name}". Current Outstanding: ₹${currentOutstanding.toFixed(2)}, This Bill Credit: ₹${creditPortion.toFixed(2)}, Allowed Limit: ₹${customerLimit.toFixed(2)}.`
      );
    }

    // Prioritize explicit creditDueDate provided by checkout modal
    let resolvedDueDate = null;
    if (saleData.creditDueDate) {
      const parsed = new Date(saleData.creditDueDate);
      if (!isNaN(parsed.getTime())) resolvedDueDate = parsed;
    }
    if (!resolvedDueDate && Array.isArray(saleData.payments)) {
      const creditP = saleData.payments.find(
        (p) => String(p.paymentType || p.mode || "").toLowerCase() === "credit" && (p.creditDueDate || p.dueDate)
      );
      if (creditP) {
        const parsedP = new Date(creditP.creditDueDate || creditP.dueDate);
        if (!isNaN(parsedP.getTime())) resolvedDueDate = parsedP;
      }
    }
    if (!resolvedDueDate && saleData.dueDate) {
      const parsedD = new Date(saleData.dueDate);
      if (!isNaN(parsedD.getTime())) resolvedDueDate = parsedD;
    }

    if (resolvedDueDate) {
      creditDueDate = resolvedDueDate;
    } else {
      const creditDays = Number(customer.creditDays) > 0 ? Number(customer.creditDays) : 15;
      creditDueDate = new Date(saleData.date || Date.now());
      creditDueDate.setDate(creditDueDate.getDate() + creditDays);
    }
  }

  const isAllCredit = creditPortion >= grandTotal - 0.01 && grandTotal > 0;

  const newSale = {
    workspaceId: workspaceId || customer.workspaceId,
    companyId: companyId || customer.companyId,
    branchId: resolvedBranchId,
    customerId: customer._id,
    invoiceNo: finalInvoiceNo,
    date: saleData.date || new Date(),
    financialPeriodId,
    shiftId: resolvedShiftId || null,
    billingMode: saleData.billingMode || "B2C",
    subtotal: saleData.subtotal || 0,
    discount: saleData.discount || 0,
    tax: saleData.tax || 0,
    grandTotal: saleData.grandTotal || 0,
    cashTendered: saleData.cashTendered || 0,
    changeDue: saleData.changeDue || 0,
    paymentMethod: saleData.paymentMethod || (isAllCredit ? "Credit" : "Cash"),
    paymentQrId: resolvedPaymentQrId || null,
    payments: Array.isArray(saleData.payments) ? saleData.payments : [],
    denominations: Array.isArray(saleData.denominations) ? saleData.denominations : [],
    returnedDenominations: Array.isArray(saleData.returnedDenominations) ? saleData.returnedDenominations : [],
    status: creditPortion > 0 ? "Pending" : (saleData.status || "Paid"),
    creditDueDate: creditDueDate || null,
    creditStatus: creditPortion > 0 ? "PENDING" : "NA",
    creditPaidAmount: 0,
    creditTransactionId: null,
    items: Array.isArray(saleData.items) ? saleData.items : [],
    doctor: saleData.doctor || saleData.doctorName || null,
    doctorId: saleData.doctorId || null,
    notes: saleData.notes || null,
    createdBy: user?._id || null,
    createdByName: user?.name || null,
    createdByEmail: user?.email || null,
  };
  _logTime('Data setup completed');

  const savedInvoice = await invoiceRepository.createInvoice(newSale, { session });
  _logTime('Invoice created in DB');

  // Create CustomerCreditTransaction if invoice has credit portion
  if (creditPortion > 0) {
    const [creditTx] = await CustomerCreditTransaction.create(
      [
        {
          workspaceId: workspaceId || customer.workspaceId,
          companyId: companyId || customer.companyId,
          branchId: resolvedBranchId,
          customerId: customer._id,
          invoiceId: savedInvoice._id,
          invoiceNo: savedInvoice.invoiceNo,
          invoiceDate: savedInvoice.date || new Date(),
          invoiceAmount: creditPortion,
          paidAmount: 0,
          balanceDue: creditPortion,
          dueDate: creditDueDate,
          status: "PENDING",
          settlements: [],
          createdBy: user?._id || null,
        },
      ],
      { session }
    );

    savedInvoice.creditTransactionId = creditTx._id;
    await savedInvoice.save({ session });
  }

  // Deduct inventory from Batch and ProductFacility
  await deductInvoiceInventory(newSale.items, resolvedBranchId, session);
  _logTime('Inventory bulk write completed');

  // Post financial accounting, GST ledger, cash drawer, and bank transactions
  await postSaleAccounting({
    invoice: savedInvoice,
    saleData,
    customer,
    company,
    resolvedBranchId,
    resolvedPaymentQrId,
    salesAccountsResult,
    cashAccountsResult,
    bankAccountsResult,
    primaryBankAccount,
    defaultBankAccount,
    companyId,
    workspaceId,
    user,
    session,
  });
  _logTime('All payments processed');

    if (!existingSession) {
      await session.commitTransaction();
      session.endSession();
    }
    
    _logTime('Transaction Committed');
    _timingStats.push(`--- Total Time: ${Date.now() - _startTotal}ms ---`);

    return savedInvoice;
  } catch (error) {
    if (!existingSession) {
      try {
        await session.abortTransaction();
      } catch (abortErr) {
        // Ignore abort errors if transaction is already committed or aborted
      }
      session.endSession();
    }
    throw error;
  }
};

const updateCustomerSale = async (invoiceId, customerId, saleData, companyId, workspaceId, user = null) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const existingInvoice = await SalesInvoice.findOne({
      _id: invoiceId,
      companyId,
      workspaceId,
      isDeleted: false,
    }).session(session);

    if (!existingInvoice) {
      throw new ApiError(404, "Invoice not found");
    }

    if (existingInvoice.status === "Cancelled") {
      throw new ApiError(400, "Cannot edit a cancelled invoice");
    }

    // Shift-gate check: Only allow update if shift is open (or invoice has no shift assigned)
    if (existingInvoice.shiftId) {
      const shift = await Shift.findById(existingInvoice.shiftId).session(session);
      if (shift && shift.status !== "open") {
        throw new ApiError(403, "Cannot edit an invoice after its shift is closed");
      }
    }

    // Enforce cash denominations validation if payment involves cash
    validateCashDenominations(saleData);

    const targetCustomerId = customerId || saleData.customerId || existingInvoice.customerId;
    const customer = await customerRepository.findCustomerById(targetCustomerId, companyId, workspaceId);
    if (!customer) {
      throw new ApiError(404, "Customer not found");
    }

    // 1. Revert Old Inventory (Add quantities back)
    await revertInvoiceInventory(existingInvoice.items, existingInvoice.branchId, session);

    // 2. Resolve branch and deduct New Inventory
    const resolvedBranchId = saleData.branchId || existingInvoice.branchId;
    await deductInvoiceInventory(saleData.items, resolvedBranchId, session);

    // 3. Clean up old accounting & treasury entries (GSTR-1, Cash Transactions, Bank Transactions, JVs)
    await cleanInvoiceAccountingEntries(
      existingInvoice._id,
      existingInvoice.invoiceNo,
      companyId,
      user?._id || user?.id,
      session
    );

    // 4. Resolve paymentQrId for UPI attribution
    let resolvedPaymentQrId = null;
    const paymentMethodUpper = String(saleData.paymentMethod || "").toUpperCase();
    if (saleData.paymentQrId) {
      resolvedPaymentQrId = saleData.paymentQrId;
    } else if (Array.isArray(saleData.payments)) {
      const upiPayment = saleData.payments.find(p =>
        String(p.paymentType || "").toUpperCase().includes("UPI") && p.paymentQrId
      );
      if (upiPayment) resolvedPaymentQrId = upiPayment.paymentQrId;
    } else if (paymentMethodUpper.includes("UPI") || paymentMethodUpper.includes("QR")) {
      resolvedPaymentQrId = null;
    }

    // 5. Update existing invoice document in place (DO NOT DELETE, PRESERVE _id AND invoiceNo)
    existingInvoice.customerId = customer._id;
    if (resolvedBranchId) {
      existingInvoice.branchId = resolvedBranchId;
    }
    if (saleData.shiftId) {
      existingInvoice.shiftId = saleData.shiftId;
    }
    if (saleData.billingMode) {
      existingInvoice.billingMode = saleData.billingMode;
    }
    existingInvoice.subtotal = Number(saleData.subtotal !== undefined ? saleData.subtotal : existingInvoice.subtotal);
    existingInvoice.discount = Number(saleData.discount !== undefined ? saleData.discount : existingInvoice.discount);
    existingInvoice.tax = Number(saleData.tax !== undefined ? saleData.tax : existingInvoice.tax);
    existingInvoice.grandTotal = Number(saleData.grandTotal !== undefined ? saleData.grandTotal : existingInvoice.grandTotal);
    existingInvoice.cashTendered = Number(saleData.cashTendered !== undefined ? saleData.cashTendered : existingInvoice.cashTendered);
    existingInvoice.changeDue = Number(saleData.changeDue !== undefined ? saleData.changeDue : existingInvoice.changeDue);
    existingInvoice.paymentMethod = saleData.paymentMethod || existingInvoice.paymentMethod || "Cash";
    existingInvoice.paymentQrId = resolvedPaymentQrId;
    existingInvoice.payments = Array.isArray(saleData.payments) ? saleData.payments : existingInvoice.payments;
    existingInvoice.denominations = Array.isArray(saleData.denominations) ? saleData.denominations : existingInvoice.denominations;
    existingInvoice.returnedDenominations = Array.isArray(saleData.returnedDenominations) ? saleData.returnedDenominations : existingInvoice.returnedDenominations;
    const isUnsettledCredit =
      existingInvoice.creditStatus === "PENDING" ||
      existingInvoice.creditStatus === "PARTIAL" ||
      String(saleData.paymentMethod || existingInvoice.paymentMethod).toLowerCase() === "credit";

    if (
      saleData.status &&
      String(saleData.status).toLowerCase() === "paid" &&
      isUnsettledCredit &&
      existingInvoice.creditStatus !== "SETTLED"
    ) {
      throw new ApiError(
        400,
        "Cannot directly mark a pending credit bill as Paid. Invoices with credit dues must be settled via Customer Credit Settlement."
      );
    }

    if (isUnsettledCredit && existingInvoice.creditStatus !== "SETTLED") {
      existingInvoice.status = "Pending";
    } else if (existingInvoice.status !== "Cancelled") {
      existingInvoice.status = saleData.status || existingInvoice.status || "Paid";
    }
    existingInvoice.items = Array.isArray(saleData.items) ? saleData.items : existingInvoice.items;
    if (saleData.doctor !== undefined) existingInvoice.doctor = saleData.doctor;
    if (saleData.doctorName !== undefined && saleData.doctor === undefined) existingInvoice.doctor = saleData.doctorName;
    if (saleData.doctorId !== undefined) existingInvoice.doctorId = saleData.doctorId || null;
    if (saleData.notes !== undefined) existingInvoice.notes = saleData.notes;
    if (saleData.creditDueDate) {
      const parsed = new Date(saleData.creditDueDate);
      if (!isNaN(parsed.getTime())) {
        existingInvoice.creditDueDate = parsed;
        if (existingInvoice.creditTransactionId) {
          await CustomerCreditTransaction.findByIdAndUpdate(
            existingInvoice.creditTransactionId,
            { dueDate: parsed },
            { session }
          );
        }
      }
    }
    existingInvoice.updatedAt = new Date();
    if (user?._id) {
      existingInvoice.updatedBy = user._id;
      existingInvoice.updatedByName = user.name || null;
      existingInvoice.updatedByEmail = user.email || null;
    }

    await existingInvoice.save({ session });

    // 6. Post new accounting & treasury entries
    await postSaleAccounting({
      invoice: existingInvoice,
      saleData,
      customer,
      resolvedBranchId,
      resolvedPaymentQrId,
      companyId,
      workspaceId,
      user,
      session,
    });

    await session.commitTransaction();
    session.endSession();

    return existingInvoice;
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch (abortErr) {}
    session.endSession();
    throw error;
  }
};

const getCustomerSales = async (
  customerId,
  companyId,
  workspaceId,
  branchId = null,
  options = {}
) => {
  const customer = await customerRepository.findCustomerById(customerId);

  if (!customer) {
    throw new ApiError(404, "Customer not found");
  }

  const { page = 1, limit = 10, memberId = null, includeFamily = true } = options;

  let targetCustomerIds = [customerId];
  const familyMembers = [];
  const familyMemberMap = new Map();

  // Always include the currently viewed customer as "Self"
  const selfMember = {
    customerId: customer._id,
    _id: customer._id,
    name: customer.name,
    customerCode: customer.customerCode,
    mobile: customer.mobile,
    gender: customer.gender || null,
    relation: "Self",
    isSelf: true,
  };
  familyMembers.push(selfMember);
  familyMemberMap.set(customer._id.toString(), selfMember);

  // If customer is part of a SharedContactGroup, resolve all members and pairwise relations
  if (customer.sharedContactGroupId) {
    try {
      const group = await SharedContactGroup.findOne({
        _id: customer.sharedContactGroupId,
        workspaceId,
        companyId,
      }).lean();

      if (group && Array.isArray(group.members) && group.members.length > 0) {
        const sortedMembers = [...group.members].sort(
          (a, b) => (a.sequence || 1) - (b.sequence || 1)
        );
        const otherMemberIds = sortedMembers
          .map((m) => m.customerId)
          .filter((id) => id && id.toString() !== customer._id.toString());

        if (otherMemberIds.length > 0) {
          const [relatedCustomers, relationshipRecords] = await Promise.all([
            Customer.find({
              _id: { $in: otherMemberIds },
              workspaceId,
              companyId,
              isDeleted: false,
            })
              .select("_id customerCode name mobile gender")
              .lean(),
            CustomerRelationship.find({
              workspaceId,
              companyId,
              sourceCustomerId: customer._id,
              targetCustomerId: { $in: otherMemberIds },
            }).lean(),
          ]);

          const relMap = new Map(
            relationshipRecords.map((r) => [r.targetCustomerId.toString(), r])
          );
          const custMap = new Map(
            relatedCustomers.map((c) => [c._id.toString(), c])
          );

          for (const m of sortedMembers) {
            const mIdStr = m.customerId?.toString();
            if (!mIdStr || mIdStr === customer._id.toString()) continue;
            const targetCust = custMap.get(mIdStr);
            if (!targetCust) continue;

            const relRecord = relMap.get(mIdStr);
            const relation = relRecord?.relationship || "Other";
            const memberObj = {
              customerId: targetCust._id,
              _id: targetCust._id,
              name: targetCust.name,
              customerCode: targetCust.customerCode,
              mobile: targetCust.mobile,
              gender: targetCust.gender || null,
              relation,
              isSelf: false,
            };
            familyMembers.push(memberObj);
            familyMemberMap.set(mIdStr, memberObj);
          }
        }
      }
    } catch (err) {
      console.warn("Failed to load family members for customer sales:", err.message);
    }
  }

  // Determine query targets based on memberId filter & includeFamily flag
  if (memberId && mongoose.Types.ObjectId.isValid(memberId)) {
    targetCustomerIds = [memberId];
  } else if (includeFamily && familyMembers.length > 1) {
    targetCustomerIds = familyMembers.map((m) => m.customerId);
  } else {
    targetCustomerIds = [customerId];
  }

  const result = await invoiceRepository.getInvoicesByCustomerId(
    targetCustomerIds,
    companyId,
    workspaceId,
    { branchId },
    { page, limit }
  );

  const enrichedSales = (result.sales || []).map((inv) => {
    const custIdStr = (inv.customerId?._id || inv.customerId)?.toString();
    const memberInfo = familyMemberMap.get(custIdStr);

    // Slim down items array - strip heavy embedded workspaceProduct object
    const items = (inv.items || []).map((item) => ({
      id: item.id || item._id || item.productId,
      productId: item.productId || item._id,
      name: item.name || item.productName || item.workspaceProduct?.name || "Product",
      batch: item.batch || item.batchNo || "",
      qty: item.qty || 1,
      returnedQty: Number(item.returnedQty || 0),
      isReturned: Boolean(item.isReturned || (Number(item.returnedQty || 0) >= Number(item.qty || 1))),
      returnStatus: item.returnStatus || (Number(item.returnedQty || 0) >= Number(item.qty || 1) ? "FULL" : (Number(item.returnedQty || 0) > 0 ? "PARTIAL" : "NONE")),
      rate: Number(item.rate ?? item.price ?? item.rateC ?? item.mrp ?? 0),
      price: Number(item.price ?? item.rate ?? 0),
      mrp: Number(item.mrp ?? 0),
      disc: Number(item.disc ?? 0),
    }));

    return {
      _id: inv._id,
      invoiceNo: inv.invoiceNo,
      date: inv.date,
      billingMode: inv.billingMode,
      subtotal: inv.subtotal,
      discount: inv.discount,
      tax: inv.tax,
      grandTotal: inv.grandTotal,
      paymentMethod: inv.paymentMethod,
      status: inv.status,
      returnInvoiceIds: inv.returnInvoiceIds || [],
      returnInvoices: inv.returnInvoices || [],
      returnStatus: inv.returnStatus || "NONE",
      isReturned: Boolean(inv.isReturned),
      isFullyReturned: Boolean(inv.isFullyReturned),
      totalReturnedAmount: Number(inv.totalReturnedAmount || 0),
      customerId: inv.customerId,
      branchId: inv.branchId?._id || inv.branchId || null,
      branchName: inv.branchId?.name || null,
      branchCode: inv.branchId?.branchCode || null,
      memberName: memberInfo?.name || inv.customerId?.name || "",
      memberRelation:
        memberInfo?.relation || (custIdStr === customer._id.toString() ? "Self" : "Customer"),
      memberGender: memberInfo?.gender || inv.customerId?.gender || null,
      isSelf: memberInfo?.isSelf ?? (custIdStr === customer._id.toString()),
      items,
    };
  });

  return {
    data: enrichedSales,
    familyMembers,
    selectedMemberId: memberId || null,
    meta: {
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalSalesAmount: result.totalSalesAmount,
    },
  };
};

const getAllCustomerSales = async (companyId, workspaceId, filters = {}, pagination = {}) => {
  const result = await invoiceRepository.getAllInvoices(
    companyId,
    workspaceId,
    filters,
    pagination
  );

  return {
    data: result.sales,
    meta: {
      total: result.total,
      page: result.page,
      limit: result.limit,
    },
    summary: result.summary,
  };
};


const cancelCustomerSale = async (
  invoiceId,
  companyId,
  workspaceId,
  user,
  cancelReason = null,
  refundDenominations = null,
  customerChangeDenominations = null
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const invoice = await SalesInvoice.findOne({ _id: invoiceId, companyId, workspaceId }).session(session);

    if (!invoice) {
      throw new ApiError(404, "Invoice not found");
    }

    if (invoice.status === "Cancelled") {
      throw new ApiError(400, "Invoice is already cancelled");
    }

    // Calculate net cash portion paid on this bill
    let invoiceCashAmount = 0;
    const paymentsList = Array.isArray(invoice.payments) ? invoice.payments : [];
    if (paymentsList.length > 0) {
      for (const p of paymentsList) {
        const pType = String(p.paymentType || p.mode || "").toLowerCase();
        if (pType === "cash") {
          invoiceCashAmount += Number(p.amount || 0);
        }
      }
    } else if (String(invoice.paymentMethod || "").toLowerCase() === "cash") {
      invoiceCashAmount = Number(invoice.grandTotal || 0);
    }

    // Normalize refund denominations (cash dispensed from drawer to customer)
    const normalizedRefundDenoms = (Array.isArray(refundDenominations) ? refundDenominations : [])
      .map((d) => ({
        denomination: Number(d.denomination || d.val || d.note || 0),
        quantity: Number(d.quantity || d.count || d.qty || 0),
      }))
      .filter((d) => d.denomination > 0 && d.quantity > 0);

    // Normalize customer change denominations (change received from customer back into drawer)
    const normalizedCustomerChangeDenoms = (Array.isArray(customerChangeDenominations) ? customerChangeDenominations : [])
      .map((d) => ({
        denomination: Number(d.denomination || d.val || d.note || 0),
        quantity: Number(d.quantity || d.count || d.qty || 0),
      }))
      .filter((d) => d.denomination > 0 && d.quantity > 0);

    // If refund denominations provided for cash bill, validate net refund equality
    if (invoiceCashAmount > 0 && normalizedRefundDenoms.length > 0) {
      const refundTotal = normalizedRefundDenoms.reduce(
        (sum, d) => sum + d.denomination * d.quantity,
        0
      );
      const changeTotal = normalizedCustomerChangeDenoms.reduce(
        (sum, d) => sum + d.denomination * d.quantity,
        0
      );
      const netRefund = refundTotal - changeTotal;

      if (Math.abs(netRefund - invoiceCashAmount) > 0.01) {
        throw new ApiError(
          400,
          `Net refund (₹${netRefund.toFixed(2)}) must equal invoice cash amount (₹${invoiceCashAmount.toFixed(2)}). Dispensed from drawer: ₹${refundTotal.toFixed(2)}, Customer change: ₹${changeTotal.toFixed(2)}`
        );
      }
    }

    // Guardrail: Block cancellation of settled or partially settled credit invoices
    if (
      invoice.creditStatus === "SETTLED" ||
      invoice.creditStatus === "PARTIAL" ||
      Number(invoice.creditPaidAmount || 0) > 0
    ) {
      throw new ApiError(
        400,
        "Cannot cancel a partially or fully settled credit invoice. Please reverse all settlement receipts first."
      );
    }

    // Cancel linked CustomerCreditTransaction if pending
    if (invoice.creditTransactionId || invoice.creditStatus === "PENDING") {
      await CustomerCreditTransaction.updateMany(
        { invoiceId: invoice._id, status: "PENDING" },
        { status: "CANCELLED" },
        { session }
      );
    }

    // Revert any advance deduction for this invoice to restore customer's advance balance
    const advanceDeductions = await CustomerAdvanceTransaction.find({
      referenceId: invoice._id,
      type: CUSTOMER_TRANSACTION_TYPE.ADVANCE_SETTLED,
      status: "ACTIVE",
    }).session(session);

    for (const adv of advanceDeductions) {
      adv.status = "REVERSED";
      await adv.save({ session });
      if (invoice.customerId) {
        await Customer.findByIdAndUpdate(
          invoice.customerId,
          { $inc: { advanceBalance: adv.amount } },
          { session }
        );
      }
    }

    // Shift-gate check: Only allow cancellation if shift is open (or invoice has no shift assigned)
    const { Shift } = await import("../../../operations/shifts/shift.model.js");
    let shift = null;
    if (invoice.shiftId) {
      shift = await Shift.findById(invoice.shiftId).session(session);
      if (shift && shift.status !== "open") {
        throw new ApiError(403, "Cannot cancel an invoice after its shift is closed");
      }
    } else if (invoice.branchId) {
      // If invoice has no shiftId, check if there is an active open shift at this branch and link it
      const openShift = await Shift.findOne({ branchId: invoice.branchId, status: "open" }).session(session);
      if (openShift) {
        invoice.shiftId = openShift._id;
        shift = openShift;
      }
    }

    // 1. Revert Inventory Qty for all items
    await revertInvoiceInventory(invoice.items, invoice.branchId, session);

    // 2. Clean up accounting entries (GSTR-1, Cash Transactions, Bank Transactions, JVs)
    await cleanInvoiceAccountingEntries(
      invoice._id,
      invoice.invoiceNo,
      companyId,
      user?._id || user?.id,
      session,
      normalizedRefundDenoms.length > 0 ? normalizedRefundDenoms : null,
      invoice.branchId,
      normalizedCustomerChangeDenoms.length > 0 ? normalizedCustomerChangeDenoms : null
    );

    // 6. Update invoice status & cancellation audit fields
    invoice.status = "Cancelled";
    invoice.cancelledAt = new Date();
    invoice.cancelledBy = user?._id || user?.id || null;
    if (cancelReason) invoice.cancelReason = cancelReason;
    if (normalizedRefundDenoms.length > 0) {
      invoice.refundDenominations = normalizedRefundDenoms;
    }
    if (normalizedCustomerChangeDenoms.length > 0) {
      invoice.customerChangeDenominations = normalizedCustomerChangeDenoms;
    }
    await invoice.save({ session });

    await session.commitTransaction();
    return invoice;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const getNextInvoiceNumber = async (companyId, workspaceId, branchId, date = new Date()) => {
  const saleDateObj = date ? new Date(date) : new Date();
  let earlyFyString = "";
  const month = saleDateObj.getMonth();
  const year = saleDateObj.getFullYear();
  if (month >= 3) {
    earlyFyString = `${year.toString().slice(-2)}${(year + 1).toString().slice(-2)}`;
  } else {
    earlyFyString = `${(year - 1).toString().slice(-2)}${year.toString().slice(-2)}`;
  }

  const [activeBranches, periods] = await Promise.all([
    branchRepository.getCompanyBranches(companyId),
    financialPeriodRepository.getPeriods(workspaceId, companyId, { isCurrent: true, all: true }),
  ]);

  let resolvedBranchId = branchId || null;
  let targetBranch = null;

  if (Array.isArray(activeBranches) && activeBranches.length > 0) {
    if (resolvedBranchId) {
      targetBranch = activeBranches.find(
        (b) => b._id && b._id.toString() === resolvedBranchId.toString()
      ) || null;
    }
    if (!targetBranch) {
      targetBranch = activeBranches[0];
      resolvedBranchId = targetBranch._id;
    }
  }

  const branchInitials = getBranchInitials(targetBranch);

  let period = periods.periods && periods.periods[0];
  let fyString = earlyFyString;
  if (period && period.startDate && period.endDate) {
    const startYear = new Date(period.startDate).getFullYear();
    const endYear = new Date(period.endDate).getFullYear();
    fyString = `${startYear.toString().slice(-2)}${endYear.toString().slice(-2)}`;
  }

  const finalInvoicePrefix = `${branchInitials}-${fyString}-`;

  const lastInvoice = await invoiceRepository.getLatestInvoiceByPrefix(
    companyId,
    workspaceId,
    finalInvoicePrefix,
    resolvedBranchId
  );

  let sequenceNo = 1;
  if (lastInvoice && lastInvoice.invoiceNo && lastInvoice.invoiceNo.startsWith(finalInvoicePrefix)) {
    const parts = lastInvoice.invoiceNo.split('-');
    if (parts.length >= 3) {
      const lastSeq = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastSeq)) {
        sequenceNo = lastSeq + 1;
      }
    }
  }

  let candidateSeq = sequenceNo;
  let nextInvoiceNo = `${finalInvoicePrefix}${candidateSeq.toString().padStart(4, '0')}`;
  let collision = await invoiceRepository.getInvoiceByInvoiceNo(companyId, workspaceId, nextInvoiceNo, resolvedBranchId);
  while (collision) {
    candidateSeq += 1;
    nextInvoiceNo = `${finalInvoicePrefix}${candidateSeq.toString().padStart(4, '0')}`;
    collision = await invoiceRepository.getInvoiceByInvoiceNo(companyId, workspaceId, nextInvoiceNo, resolvedBranchId);
  }

  return {
    nextInvoiceNo,
    nextInvoiceNumber: nextInvoiceNo,
    prefix: finalInvoicePrefix,
    sequenceNo: candidateSeq,
    branchId: resolvedBranchId,
    branchInitials,
    fyString,
  };
};

const getInvoiceById = async (invoiceId, companyId, workspaceId) => {
  const invoice = await invoiceRepository.getInvoiceById(invoiceId, companyId, workspaceId);
  if (!invoice) {
    throw new ApiError(404, "Invoice not found");
  }
  return invoice;
};

export default {
  recordCustomerSale,
  updateCustomerSale,
  cancelCustomerSale,
  getCustomerSales,
  getAllCustomerSales,
  getNextInvoiceNumber,
  getInvoiceById,
};
