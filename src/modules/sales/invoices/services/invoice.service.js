import mongoose from "mongoose";
import ApiError from "../../../../utils/ApiError.js";
import invoiceRepository from "../repositories/invoice.repository.js";
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
import cashDenominationRepository from "../../../finance/treasury/cash-management/cash-denominations/repositories/cashDenomination.repository.js";
import SalesInvoice from "../models/invoice.model.js";
import GstLedger from "../../../finance/gst-ledger/models/gstLedger.model.js";
import JournalVoucher from "../../../finance/journal-vouchers/models/journalVoucher.model.js";
import branchCashRepository from "../../../finance/treasury/cash-management/branch-cash/repositories/branchCash.repository.js";
import CashTransaction from "../../../finance/treasury/cash-management/cash-transactions/models/cashTransaction.model.js";
import BankTransaction from "../../../finance/treasury/bank-management/bank-transactions/models/bankTransaction.model.js";

/**
 * Validates that all cash payments have explicit denomination breakdowns
 * and that received - returned exactly equals the cash amount.
 */

const revertCashTransactionsForInvoice = async (invoiceNo, companyId, userId, session) => {
  const cashTxns = await CashTransaction.find({ referenceNumber: invoiceNo }).session(session);
  for (const ct of cashTxns) {
    if (ct.cashDenominationId) {
      const denomRecord = await mongoose.model("CashDenomination").findOne({ _id: ct.cashDenominationId }).session(session);
      if (denomRecord) {
        const processedDenominations = denomRecord.denominations || [];
        const partition = ct.cashPartition || "running";
        const branchId = ct.branchId;
        const ctDirection = ct.direction;
        
        if (ctDirection === "CREDIT") {
          if (partition === "running") {
            await branchCashRepository.subtractRunningDenominations(branchId, companyId, processedDenominations, userId, { session });
          } else {
            await branchCashRepository.subtractFrozenDenominations(branchId, companyId, processedDenominations, userId, { session });
          }
        } else {
          if (partition === "running") {
            await branchCashRepository.addRunningDenominations(branchId, companyId, processedDenominations, userId, { session });
          } else {
            await branchCashRepository.addFrozenDenominations(branchId, companyId, processedDenominations, userId, { session });
          }
        }
        await mongoose.model("CashDenomination").deleteOne({ _id: denomRecord._id }, { session });
      }
    }
  }
  await CashTransaction.deleteMany({ referenceNumber: invoiceNo }, { session });
};

const validateCashDenominations = (saleData) => {
  const isCashMethod = String(saleData.paymentMethod || "").toLowerCase() === "cash";
  const paymentsList = Array.isArray(saleData.payments) ? saleData.payments : [];

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
    const earlyBranchCode = "BR01"; // Fallback, will adjust later if needed
    const invoicePrefix = `${earlyBranchCode}-${earlyFyString}-`;

    // Fetch all required reference data concurrently to eliminate sequential network latency
    const [
      customer,
      activeBranches,
      periods,
      lastInvoice,
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
      invoiceRepository.getLatestInvoiceByPrefix(companyId, workspaceId, invoicePrefix),
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

  let resolvedBranchId = saleData.branchId || null;
  let branchCode = "BR01";
  if (!resolvedBranchId && Array.isArray(activeBranches) && activeBranches.length > 0) {
    resolvedBranchId = activeBranches[0]._id;
    branchCode = activeBranches[0].branchCode || branchCode;
  }

  let period = periods.periods && periods.periods[0];
  const financialPeriodId = period ? period._id : null;

  let fyString = earlyFyString;
  if (period && period.startDate && period.endDate) {
    const startYear = new Date(period.startDate).getFullYear();
    const endYear = new Date(period.endDate).getFullYear();
    fyString = `${startYear.toString().slice(-2)}${endYear.toString().slice(-2)}`;
  }

  const finalInvoicePrefix = `${branchCode}-${fyString}-`;
  let sequenceNo = 1;
  
  if (lastInvoice && lastInvoice.invoiceNo && lastInvoice.invoiceNo.startsWith(finalInvoicePrefix)) {
    const parts = lastInvoice.invoiceNo.split('-');
    if (parts.length >= 3) {
      const lastSeq = parseInt(parts[2], 10);
      if (!isNaN(lastSeq)) {
        sequenceNo = lastSeq + 1;
      }
    }
  }

  const generatedInvoiceNo = `${finalInvoicePrefix}${sequenceNo.toString().padStart(4, '0')}`;

  const isAutoGenerated = saleData.invoiceNo && (saleData.invoiceNo.startsWith("RET-INV") || saleData.invoiceNo.startsWith("TAX-INV"));
  const finalInvoiceNo = isAutoGenerated ? generatedInvoiceNo : (saleData.invoiceNo || generatedInvoiceNo);

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
    // Single-method UPI without explicit paymentQrId — keep null (unattributed)
    resolvedPaymentQrId = null;
  }

  const newSale = {
    workspaceId: workspaceId || customer.workspaceId,
    companyId: companyId || customer.companyId,
    branchId: resolvedBranchId,
    customerId: customer._id,
    invoiceNo: finalInvoiceNo,
    date: saleData.date || new Date(),
    financialPeriodId,
    billingMode: saleData.billingMode || "B2C",
    subtotal: saleData.subtotal || 0,
    discount: saleData.discount || 0,
    tax: saleData.tax || 0,
    grandTotal: saleData.grandTotal || 0,
    cashTendered: saleData.cashTendered || 0,
    changeDue: saleData.changeDue || 0,
    paymentMethod: saleData.paymentMethod || "Cash",
    paymentQrId: resolvedPaymentQrId || null,
    payments: Array.isArray(saleData.payments) ? saleData.payments : [],
    denominations: Array.isArray(saleData.denominations) ? saleData.denominations : [],
    status: saleData.status || "Paid",
    items: Array.isArray(saleData.items) ? saleData.items : [],
    doctor: saleData.doctor || null,
    notes: saleData.notes || null,
    createdBy: user?._id || null,
    createdByName: user?.name || null,
    createdByEmail: user?.email || null,
  };
  _logTime('Data setup completed');

  const savedInvoice = await invoiceRepository.createInvoice(newSale, { session });
  _logTime('Invoice created in DB');

  // Deduct inventory from Batch and ProductFacility using bulkWrite for O(1) queries
  if (Array.isArray(newSale.items) && newSale.items.length > 0) {
    const batchOps = [];
    const facilityOps = [];

    for (const item of newSale.items) {
      const qtyToDeduct = Number(item.qty) || 0;
      if (qtyToDeduct <= 0) continue;

      const productId = item.productId || item.workspaceProductId || item.id;
      const rawBatchId = item.batchId || (item.batch && item.batch._id) || item.batch;

      if (rawBatchId) {
        batchOps.push({
          updateOne: {
            filter: { _id: rawBatchId },
            update: { $inc: { batchQty: -qtyToDeduct } }
          }
        });
      }

      if (productId && resolvedBranchId) {
        facilityOps.push({
          updateOne: {
            filter: { product_id: productId, facility_id: resolvedBranchId },
            update: { $inc: { total_qty_available: -qtyToDeduct, qoh: -qtyToDeduct, atp: -qtyToDeduct } }
          }
        });
      }
    }

    if (batchOps.length > 0) {
      await Batch.bulkWrite(batchOps, { session });
    }
    if (facilityOps.length > 0) {
      await ProductFacility.bulkWrite(facilityOps, { session });
    }
    _logTime('Inventory bulk write completed');
  }

  // Auto-create GSTR-1 Entry for GST Ledger
  try {
    const totalGst = Number(newSale.tax || saleData.tax || 0);
    const halfGst = totalGst / 2;
    const taxableAmt = Number(
      saleData.taxableAmount !== undefined
        ? saleData.taxableAmount
        : (newSale.subtotal || 0) - (newSale.discount || 0)
    );

    const companyGstin = company?.gstin || "";
    const customerGstin = customer?.gstNumber || "";
    const isIgst = companyGstin && customerGstin && companyGstin.substring(0, 2) !== customerGstin.substring(0, 2);

    await gstLedgerRepository.createGstLedgerEntry({
      workspaceId: newSale.workspaceId,
      companyId: newSale.companyId,
      partyId: customer._id,
      voucherId: savedInvoice._id,
      voucherNumber: newSale.invoiceNo,
      voucherDate: newSale.date ? new Date(newSale.date) : new Date(),
      gstType: "GSTR-1",
      taxableAmount: taxableAmt,
      cgst: isIgst ? 0 : halfGst,
      sgst: isIgst ? 0 : halfGst,
      igst: isIgst ? totalGst : 0,
      totalAmount: Number(newSale.grandTotal || 0),
      narration: `Sale Bill ${newSale.invoiceNo} (${newSale.billingMode}) - Customer: ${customer.name || "Customer"}`,
    }, { session });
    _logTime('GST Ledger entry created');
  } catch (gstErr) {
    console.error("Failed to auto-create GSTR-1 entry for sale bill:", gstErr);
  }

  // Auto-create Journal Vouchers for Sale and Payment
  try {
    const isCashPaid = (String(newSale.paymentMethod).toLowerCase() === "cash" || newSale.cashTendered > 0) && String(newSale.status).toLowerCase() === "paid" && newSale.grandTotal > 0;
    const isUpiPaid = String(newSale.paymentMethod).toLowerCase() === "upi" && String(newSale.status).toLowerCase() === "paid" && newSale.grandTotal > 0;



    let salesAccount = null;
    if (salesAccountsResult.accounts && salesAccountsResult.accounts.length > 0) {
      const accounts = salesAccountsResult.accounts;
      salesAccount = accounts.find(a => a.accountCode === "SALES-REVENUE") 
                  || accounts.find(a => String(a.accountName).toLowerCase().includes("revenue")) 
                  || accounts[0];
    }

    if (salesAccount) {
      // Pre-calculate how many sequences we need to generate to run them in ONE concurrent burst
      let needsSaleJv = customer.ledgerAccountId ? 1 : 0;
      let needsReceiptJv = 0;
      let needsCashTx = 0;

      const paymentsList = Array.isArray(saleData.payments) ? saleData.payments : [];
      let prePayments = [...paymentsList];
      if (isCashPaid && prePayments.length === 0) prePayments.push({paymentType: 'cash', amount: newSale.grandTotal});
      else if (isUpiPaid && prePayments.length === 0) prePayments.push({paymentType: 'upi', amount: newSale.grandTotal});

      for (const p of prePayments) {
        if (String(p.paymentType || p.mode).toLowerCase() === "cash") {
           needsReceiptJv += 1;
           needsCashTx += 1; // CASH_IN
           let changeAmount = 0;
           if (Array.isArray(p.returnedDenominations) && p.returnedDenominations.length > 0) {
             changeAmount = p.returnedDenominations.reduce((sum, d) => sum + (Number(d.denomination) * Number(d.quantity)), 0);
           }
           if (changeAmount > 0) {
             needsReceiptJv += 1; 
             needsCashTx += 1; // CASH_OUT
           }
        } else if (String(p.paymentType || p.mode).toLowerCase() === "upi") {
           needsReceiptJv += 1; // fallback JV
        }
      }

      // Fire voucher sequence queries simultaneously (they use safe $inc)
      const salePromises = [];
      const receiptPromises = [];
      
      if (needsSaleJv) salePromises.push(voucherNumberService.generateVoucherNumber(newSale.companyId, newSale.workspaceId, "SALE", { session }));
      for(let i=0; i<needsReceiptJv; i++) receiptPromises.push(voucherNumberService.generateVoucherNumber(newSale.companyId, newSale.workspaceId, "JOURNAL", { session }));

      // For cashTx and count, fetch once from DB and increment locally to avoid uncommitted race conditions
      let baseCashTx = null;
      let baseCount = null;
      if (needsCashTx > 0) {
         baseCashTx = await cashTransactionRepository.getNextTransactionNumber(newSale.companyId, newSale.workspaceId, { session });
         baseCount = await cashDenominationRepository.getNextCountNumber(newSale.companyId, newSale.workspaceId, { session });
      }

      const [saleRes, receiptRes] = await Promise.all([
        Promise.all(salePromises),
        Promise.all(receiptPromises)
      ]);

      const cashTxRes = [];
      const countRes = [];
      
      if (needsCashTx > 0) {
        const txParts = baseCashTx.split("-");
        const txPrefix = txParts.slice(0, 2).join("-") + "-";
        const txSeq = parseInt(txParts[txParts.length - 1]) || 1;

        const countParts = baseCount.split("-");
        const countPrefix = countParts.slice(0, 2).join("-") + "-";
        const countSeq = parseInt(countParts[countParts.length - 1]) || 1;

        for (let i = 0; i < needsCashTx; i++) {
          cashTxRes.push(`${txPrefix}${String(txSeq + i).padStart(5, "0")}`);
          countRes.push(`${countPrefix}${String(countSeq + i).padStart(5, "0")}`);
        }
      }
      
      let saleIdx = 0, receiptIdx = 0, cashTxIdx = 0, countIdx = 0;
      
      const preSaleJv = needsSaleJv ? saleRes[0] : null;
      const nextReceiptJv = () => receiptRes[receiptIdx++];
      const nextCashTx = () => cashTxRes[cashTxIdx++];
      const nextCount = () => countRes[countIdx++];

      // 1. If customer has a ledger account, first create the SALE JV (Customer -> Sales)
      if (customer.ledgerAccountId) {
        const saleJvPayload = {
          voucherNumber: preSaleJv,
          voucherDate: newSale.date,
          voucherType: "SALE",
          referenceNumber: newSale.invoiceNo,
          narration: `Sale against Invoice ${newSale.invoiceNo}`,
          status: "POSTED",
          lines: [
            {
              accountId: customer.ledgerAccountId,
              debit: newSale.grandTotal,
              credit: 0,
              narration: `Amount due for Invoice ${newSale.invoiceNo}`
            },
            {
              accountId: salesAccount._id,
              debit: 0,
              credit: newSale.grandTotal,
              narration: `Sales from Invoice ${newSale.invoiceNo}`
            }
          ]
        };
        
        try {
          await journalVoucherService.createJournalVoucher(
            newSale.workspaceId,
            newSale.companyId,
            user?._id,
            saleJvPayload,
            { session }
          );
        } catch (jvErr) {
          console.error("--- FAILED TO CREATE SALES JV ---", jvErr);
        }
        _logTime('Sale Journal Voucher created');
      }

      // 2. Determine counterparty for the receipt (Customer if they have an account, otherwise Sales directly)
      const receiptCounterpartyId = customer.ledgerAccountId || salesAccount._id;
      const receiptNarrationSuffix = customer.ledgerAccountId ? "from Customer" : "Sale";

      if (isCashPaid && !saleData.payments) {
        saleData.payments = [{
          paymentType: "cash",
          amount: newSale.grandTotal,
          denominations: Array.isArray(saleData.denominations) ? saleData.denominations : [],
          returnedDenominations: Array.isArray(saleData.returnedDenominations) ? saleData.returnedDenominations : []
        }];
      } else if (isUpiPaid && !saleData.payments) {
        saleData.payments = [{
          paymentType: "upi",
          amount: newSale.grandTotal
        }];
      }

      for (const payment of paymentsList) {
        const paymentType = String(payment.paymentType || payment.mode || "").toLowerCase();
        const amount = Number(payment.amount || 0);
        
        if (amount <= 0) continue;

        if (paymentType === "cash") {
          // --- CASH RECEIPT ---
          // Transactions are routed directly to BranchCash (running partition)
          let cashLedgerAccountId = null;
            if (cashAccountsResult.accounts && cashAccountsResult.accounts.length > 0) {
              const accounts = cashAccountsResult.accounts;
              const bestCash = accounts.find(a => a.accountCode === "PETTY-CASH") 
                            || accounts.find(a => String(a.accountName).toLowerCase().includes("cash"))
                            || accounts[0];
              cashLedgerAccountId = bestCash._id;
            }

          if (cashLedgerAccountId) {
            let txSuccess = false;
              try {
                // Determine received vs returned based on validated denominations payload
                let receivedDenoms = Array.isArray(payment.denominations) && payment.denominations.length > 0
                  ? payment.denominations
                  : (Array.isArray(saleData.denominations) ? saleData.denominations : []);
                let returnedDenoms = Array.isArray(payment.returnedDenominations)
                  ? payment.returnedDenominations
                  : [];
                let receivedAmount = receivedDenoms.reduce((sum, d) => sum + (Number(d.denomination) * Number(d.quantity)), 0);

                if (receivedAmount === 0 && receivedDenoms.length === 0) {
                  throw new ApiError(400, "Cash denominations are required for cash payments.");
                }

                let changeAmount = returnedDenoms.reduce((sum, d) => sum + (Number(d.denomination) * Number(d.quantity)), 0);

                // 1. Process CASH_IN for exact received amount
                const cashInPayload = {
                  transactionNumber: nextCashTx(),
                  voucherNumber: nextReceiptJv(),
                  countNumber: nextCount(),
                  transactionDate: newSale.date || new Date(),
                  branchId: resolvedBranchId,
                  partition: "running",
                  transactionType: "CASH_IN",
                  direction: "CREDIT",
                  amount: receivedAmount,
                  referenceNumber: newSale.invoiceNo,
                  narration: `Cash Received ${receiptNarrationSuffix} for Invoice ${newSale.invoiceNo}`,
                  counterpartyAccountId: receiptCounterpartyId,
                  denominations: receivedDenoms,
                };
                
                console.log("Creating CASH_IN:", JSON.stringify(cashInPayload, null, 2));

                await cashTransactionService.createCashTransaction(
                  newSale.workspaceId,
                  newSale.companyId,
                  user?._id,
                  cashInPayload,
                  { session }
                );

                // 2. Process CASH_OUT if change was given
                if (changeAmount > 0) {
                  const cashOutPayload = {
                    transactionNumber: nextCashTx(),
                    voucherNumber: nextReceiptJv(),
                    countNumber: nextCount(),
                    transactionDate: newSale.date || new Date(),
                    branchId: resolvedBranchId,
                    partition: "running",
                    transactionType: "CASH_OUT",
                    direction: "DEBIT",
                    amount: changeAmount,
                    referenceNumber: newSale.invoiceNo,
                    narration: `Change Returned for Invoice ${newSale.invoiceNo}`,
                    counterpartyAccountId: receiptCounterpartyId, // Returning money to customer
                    denominations: returnedDenoms,
                  };

                  console.log("Creating CASH_OUT:", JSON.stringify(cashOutPayload, null, 2));

                  await cashTransactionService.createCashTransaction(
                    newSale.workspaceId,
                    newSale.companyId,
                    user?._id,
                    cashOutPayload,
                    { session }
                  );
                }

                txSuccess = true;
              } catch (ctErr) {
                console.error("Failed to create cash transactions in treasury, falling back to JV:", ctErr);
                import('fs').then(fs => fs.writeFileSync('c:\\Users\\Intel\\Desktop\\erp\\erp-backend\\scratch-err.txt', ctErr.stack || ctErr.message || String(ctErr)));
              }
            
            
            if (!txSuccess) {
              const fallbackJvPayload = {
                voucherNumber: nextReceiptJv(),
                voucherDate: newSale.date || new Date(),
                voucherType: "RECEIPT",
                referenceNumber: newSale.invoiceNo,
                narration: `Cash ${receiptNarrationSuffix} for Invoice ${newSale.invoiceNo}`,
                status: "POSTED",
                lines: [
                  {
                    accountId: cashLedgerAccountId,
                    debit: amount,
                    credit: 0,
                    narration: `Cash Received for Invoice ${newSale.invoiceNo}`
                  },
                  {
                    accountId: receiptCounterpartyId,
                    debit: 0,
                    credit: amount,
                    narration: `Offset for Invoice ${newSale.invoiceNo}`
                  }
                ]
              };
              
              await journalVoucherService.createJournalVoucher(
                newSale.workspaceId,
                newSale.companyId,
                user?._id,
                fallbackJvPayload,
                { session }
              );
            }
          }
        } else if (paymentType === "upi") {
          // --- UPI RECEIPT ---
          let bankAccount = null;
          
          const qrIdToLookup = payment.paymentQrId || resolvedPaymentQrId;
          if (qrIdToLookup) {
             const paymentQr = await PaymentQr.findById(qrIdToLookup).session(session);
             if (paymentQr && paymentQr.bankAccountId) {
                bankAccount = await BankAccount.findOne({ _id: paymentQr.bankAccountId, isDeleted: false, isActive: true }).session(session);
             }
          }
          
          if (!bankAccount) {
            bankAccount = primaryBankAccount || defaultBankAccount;
          }

          let txSuccess = false;
          if (bankAccount) {
            try {
              const bankTxPayload = {
                transactionDate: newSale.date || new Date(),
                bankAccountId: bankAccount._id,
                transactionType: "UPI",
                direction: "CREDIT",
                amount: amount,
                referenceNumber: payment.txnRefNo || payment.referenceNo || newSale.invoiceNo,
                narration: `UPI ${receiptNarrationSuffix} for Invoice ${newSale.invoiceNo}`,
                counterpartyAccountId: receiptCounterpartyId
              };
              
              await bankTransactionService.createBankTransaction(
                newSale.workspaceId,
                newSale.companyId,
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
            if (!bankLedgerAccountId && bankAccountsResult && bankAccountsResult.accounts && bankAccountsResult.accounts.length > 0) {
              bankLedgerAccountId = bankAccountsResult.accounts[0]._id;
            }
            if (bankLedgerAccountId) {
              const fallbackUpiJvPayload = {
                voucherNumber: nextReceiptJv(),
                voucherDate: newSale.date || new Date(),
                voucherType: "RECEIPT",
                referenceNumber: payment.txnRefNo || payment.referenceNo || newSale.invoiceNo,
                narration: `UPI ${receiptNarrationSuffix} for Invoice ${newSale.invoiceNo}`,
                status: "POSTED",
                lines: [
                  {
                    accountId: bankLedgerAccountId,
                    debit: amount,
                    credit: 0,
                    narration: `UPI Received for Invoice ${newSale.invoiceNo}`
                  },
                  {
                    accountId: receiptCounterpartyId,
                    debit: 0,
                    credit: amount,
                    narration: `Offset for Invoice ${newSale.invoiceNo}`
                  }
                ]
              };
              
              await journalVoucherService.createJournalVoucher(
                newSale.workspaceId,
                newSale.companyId,
                user?._id,
                fallbackUpiJvPayload,
                { session }
              );
            }
          }
        }
      }
    }
  } catch (jvErr) {
    console.error("Error generating journal vouchers for sale bill:", jvErr);
  }
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
    const oldInvoice = await invoiceRepository.getInvoiceById(invoiceId, companyId, workspaceId, session);
    if (!oldInvoice) {
      throw new ApiError(404, "Invoice not found");
    }

    // 1. Revert Inventory (Add quantities back)
    if (Array.isArray(oldInvoice.items) && oldInvoice.items.length > 0) {
      const batchOps = [];
      const facilityOps = [];
      const resolvedBranchId = oldInvoice.branchId;

      for (const item of oldInvoice.items) {
        const qtyToRevert = Number(item.qty) || 0;
        if (qtyToRevert <= 0) continue;

        const productId = item.productId || item.workspaceProductId || item.id;
        const rawBatchId = item.batchId || (item.batch && item.batch._id) || item.batch;

        if (rawBatchId) {
          batchOps.push({
            updateOne: {
              filter: { _id: rawBatchId },
              update: { $inc: { batchQty: qtyToRevert } }
            }
          });
        }

        if (productId && resolvedBranchId) {
          facilityOps.push({
            updateOne: {
              filter: { product_id: productId, facility_id: resolvedBranchId },
              update: { $inc: { total_qty_available: qtyToRevert, qoh: qtyToRevert, atp: qtyToRevert } }
            }
          });
        }
      }

      if (batchOps.length > 0) {
        // Need to import Batch and ProductFacility
        await mongoose.model('Batch').bulkWrite(batchOps, { session });
      }
      if (facilityOps.length > 0) {
        await mongoose.model('ProductFacility').bulkWrite(facilityOps, { session });
      }
    }

    // 2. Delete GSTR-1 entry
    await GstLedger.deleteMany({ voucherId: oldInvoice._id }, { session });

    // 3. Delete Cash Transactions & Revert Denominations
    await revertCashTransactionsForInvoice(oldInvoice.invoiceNo, companyId, user?._id || user?.id, session);

    // 4. Delete Bank Transactions
    await BankTransaction.deleteMany({ referenceNumber: oldInvoice.invoiceNo }, { session });

    // 5. Delete Journal Vouchers
    await JournalVoucher.deleteMany({ referenceNumber: oldInvoice.invoiceNo }, { session });

    // 6. Delete old invoice
    await SalesInvoice.deleteOne({ _id: oldInvoice._id }, { session });

    // Keep original invoice No and date
    saleData.invoiceNo = oldInvoice.invoiceNo;
    saleData.date = oldInvoice.date;

    // 7. Record the new sale in the same session
    const updatedInvoice = await recordCustomerSale(customerId, saleData, companyId, workspaceId, user, session);

    await session.commitTransaction();
    session.endSession();

    return updatedInvoice;
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch (abortErr) {}
    session.endSession();
    throw error;
  }
};

const getCustomerSales = async (customerId, companyId, workspaceId, branchId = null, pagination = {}) => {
  const customer = await customerRepository.findCustomerById(customerId);

  if (!customer) {
    throw new ApiError(404, "Customer not found");
  }

  const result = await invoiceRepository.getInvoicesByCustomerId(
    customerId,
    companyId,
    workspaceId,
    { branchId },
    pagination
  );

  return {
    data: result.sales,
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
  };
};


const cancelCustomerSale = async (invoiceId, companyId, workspaceId, user) => {
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

    // 1. Revert Inventory Qty for all items
    if (invoice.items && invoice.items.length > 0) {
      const batchOps = [];
      const facilityOps = [];
      const resolvedBranchId = invoice.branchId || null;

      for (const item of invoice.items) {
        const qtyToRevert = Number(item.qty || 0);
        if (qtyToRevert <= 0) continue;
        
        const rawBatchId = item.batchId || item.batch_id || null;
        const productId = item.productId || item.product_id;

        if (rawBatchId) {
          batchOps.push({
            updateOne: {
              filter: { _id: rawBatchId },
              update: { $inc: { batchQty: qtyToRevert } }
            }
          });
        }

        if (productId && resolvedBranchId) {
          facilityOps.push({
            updateOne: {
              filter: { product_id: productId, facility_id: resolvedBranchId },
              update: { $inc: { total_qty_available: qtyToRevert, qoh: qtyToRevert, atp: qtyToRevert } }
            }
          });
        }
      }

      if (batchOps.length > 0) {
        await mongoose.model('Batch').bulkWrite(batchOps, { session });
      }
      if (facilityOps.length > 0) {
        await mongoose.model('ProductFacility').bulkWrite(facilityOps, { session });
      }
    }

    // 2. Delete GSTR-1 entry
    await GstLedger.deleteMany({ voucherId: invoice._id }, { session });

    // 3. Delete Cash Transactions & Revert Denominations
    await revertCashTransactionsForInvoice(invoice.invoiceNo, companyId, user?._id || user?.id, session);

    // 4. Delete Bank Transactions
    await BankTransaction.deleteMany({ referenceNumber: invoice.invoiceNo }, { session });

    // 5. Delete Journal Vouchers
    await JournalVoucher.deleteMany({ referenceNumber: invoice.invoiceNo }, { session });

    // 6. Update invoice status
    invoice.status = "Cancelled";
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

export default {
  recordCustomerSale,
  updateCustomerSale,
  cancelCustomerSale,
  getCustomerSales,
  getAllCustomerSales,
};
