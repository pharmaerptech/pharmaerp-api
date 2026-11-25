import mongoose from "mongoose";
import ApiError from "../../../../utils/ApiError.js";
import purchaseBillRepository from "../repositories/purchaseBill.repository.js";
import gstLedgerRepository from "../../../finance/gst-ledger/repositories/gstLedger.repository.js";
import financialPeriodRepository from "../../../finance/financial-periods/repositories/financialPeriod.repository.js";
import Batch from "../../products/models/batch.model.js";
import ProductFacility from "../../products/models/productFacility.model.js";
import Supplier from "../../../parties/suppliers/models/supplier.model.js";
import Company from "../../../organization/companies/models/company.model.js";
import WorkspaceProduct from "../../products/models/workspaceProduct.model.js";
import branchRepository from "../../../organization/branches/repositories/branch.repository.js";
import ledgerService from "../../../finance/ledger/services/ledger.service.js";
import journalVoucherService from "../../../finance/journal-vouchers/services/journalVoucher.service.js";
import Account from "../../../finance/chart-of-accounts/models/account.model.js";
import { VOUCHER_TYPE } from "../../../finance/journal-vouchers/constants/voucherType.constant.js";
import { VOUCHER_STATUS } from "../../../finance/journal-vouchers/constants/voucherStatus.constant.js";
import SalesInvoice from "../../../sales/invoices/models/invoice.model.js";

const formatExpiry = (val) => {
  if (!val) return "";
  let str = String(val).trim();
  if (/^\d{2}\/\d{2}$/.test(str)) return str;
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const mm = String(parsed.getMonth() + 1).padStart(2, "0");
    const yy = String(parsed.getFullYear()).slice(-2);
    return `${mm}/${yy}`;
  }
  const parts = str.split(/[\/\-]/);
  if (parts.length === 3) {
    const mm = parts[1].padStart(2, "0");
    const yy = parts[2].length === 4 ? parts[2].slice(-2) : parts[2];
    return `${mm}/${yy}`;
  } else if (parts.length === 2) {
    const mm = parts[0].padStart(2, "0");
    const yy = parts[1].length === 4 ? parts[1].slice(-2) : parts[1];
    return `${mm}/${yy}`;
  }
  return str;
};

const resolveOrProvisionItems = async (workspaceId, items, userId) => {
  if (!items || !Array.isArray(items)) return [];
  const resolved = [];

  for (const item of items) {
    let resolvedProductId = item.productId || null;

    if (!resolvedProductId && item.name && String(item.name).trim()) {
      const cleanName = String(item.name).trim();
      let wsProd = await WorkspaceProduct.findOne({
        workspaceId,
        isDeleted: false,
        name: { $regex: new RegExp(`^${cleanName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
      });

      if (!wsProd) {
        try {
          wsProd = await WorkspaceProduct.create({
            workspaceId,
            name: cleanName,
            productType: "medicine",
            pack: item.pack || "10's",
            hsn: item.hsn ? String(item.hsn) : "3004",
            hsnTaxpercent: item.gst !== undefined ? Number(item.gst) : 5,
            mrp: Number(item.mrp) || 0,
            pts: Number(item.rate) || 0,
            ptr: Number(item.rateB || item.rate) || 0,
            rateA: Number(item.rateA || item.rate) || 0,
            rateB: Number(item.rateB || item.rate) || 0,
            rateC: Number(item.rateC || item.rate) || 0,
            finalRateA: Number(item.rateA || item.rate) || 0,
            finalRateB: Number(item.rateB || item.rate) || 0,
            finalRateC: Number(item.rateC || item.rate) || 0,
            source: "workspace",
            status: "active",
            createdBy: userId,
          });
        } catch (createErr) {
          wsProd = await WorkspaceProduct.findOne({
            workspaceId,
            isDeleted: false,
            name: cleanName,
          });
        }
      }
      if (wsProd) {
        resolvedProductId = wsProd._id;
      }
    }

    resolved.push({
      ...item,
      hsn: item.hsn ? String(item.hsn).trim() : "3004",
      productId: resolvedProductId,
    });
  }

  return resolved;
};

const createPurchaseBill = async (workspaceId, companyId, userId, payload) => {
  const {
    supplierId,
    branchId,
    purchaseBillNo,
    invoiceDate,
    rateBasis,
    items,
    extraDiscountPct,
    extraDiscountAmt,
    grossTotal,
    schemeDiscount,
    tradeDiscount,
    taxableSubtotal,
    taxableAfterExtraDisc,
    totalGst,
    grandTotal,
    amountPaid = 0,
    amountDue,
    gstSlabs,
    supplierInvoiceNo,
  } = payload;

  if (!items || items.length === 0) {
    throw new ApiError(400, "Purchase bill must have at least one item");
  }

  if (!supplierId) {
    throw new ApiError(400, "Supplier is required");
  }

  let resolvedBranchId = branchId || null;
  let branchCode = "BR01";
  if (!resolvedBranchId) {
    try {
      const activeBranches = await branchRepository.getCompanyBranches(companyId);
      if (Array.isArray(activeBranches) && activeBranches.length > 0) {
        resolvedBranchId = activeBranches[0]._id;
        branchCode = activeBranches[0].branchCode || branchCode;
      }
    } catch (bErr) { }
  } else {
    try {
      const branchDoc = await branchRepository.findBranchById(resolvedBranchId);
      if (branchDoc && branchDoc.branchCode) {
        branchCode = branchDoc.branchCode;
      }
    } catch (bErr) { }
  }

  // Determine financial period based on invoice date
  let period = await financialPeriodRepository.findPeriodByDate(companyId, workspaceId, invoiceDate ? new Date(invoiceDate) : new Date());
  if (!period) {
    // Fallback: get the current open financial period
    const periods = await financialPeriodRepository.getPeriods(workspaceId, companyId, { isCurrent: true, all: true });
    period = periods.periods && periods.periods[0];
  }
  const financialPeriodId = period ? period._id : null;

  // Calculate Financial Year string
  let fyString;
  if (period && period.startDate && period.endDate) {
    const startYear = new Date(period.startDate).getFullYear();
    const endYear = new Date(period.endDate).getFullYear();
    fyString = `${startYear.toString().slice(-2)}${endYear.toString().slice(-2)}`;
  } else {
    const saleDate = invoiceDate ? new Date(invoiceDate) : new Date();
    const month = saleDate.getMonth();
    const year = saleDate.getFullYear();
    let startYear, endYear;
    if (month >= 3) {
      startYear = year;
      endYear = year + 1;
    } else {
      startYear = year - 1;
      endYear = year;
    }
    fyString = `${startYear.toString().slice(-2)}${endYear.toString().slice(-2)}`;
  }

  let sequenceNo = 1;
  const numericBranchCode = branchCode.replace(/^BR/i, '');
  const invoicePrefix = `PB${numericBranchCode}-${fyString}-`;

  try {
    const lastInvoice = await purchaseBillRepository.getLatestBillByPrefix(
      companyId,
      workspaceId,
      invoicePrefix
    );
    if (lastInvoice && lastInvoice.purchaseBillNo) {
      const parts = lastInvoice.purchaseBillNo.split('-');
      if (parts.length >= 3) {
        const lastSeq = parseInt(parts[2], 10);
        if (!isNaN(lastSeq)) {
          sequenceNo = lastSeq + 1;
        }
      }
    }
  } catch (err) {
    console.error("Error generating purchase bill sequence:", err);
  }

  const generatedBillNo = purchaseBillNo || `${invoicePrefix}${sequenceNo.toString().padStart(4, '0')}`;

  const resolvedItems = await resolveOrProvisionItems(workspaceId, items, userId);

  const bill = await purchaseBillRepository.createPurchaseBill({
    workspaceId,
    companyId,
    branchId: resolvedBranchId,
    supplierId,
    purchaseBillNo: generatedBillNo,
    supplierInvoiceNo: supplierInvoiceNo || "",
    invoiceDate: invoiceDate || "",
    financialPeriodId,
    rateBasis: rateBasis || "PTS",
    items: resolvedItems,
    extraDiscountPct: extraDiscountPct || 0,
    extraDiscountAmt: extraDiscountAmt || 0,
    grossTotal: grossTotal || 0,
    schemeDiscount: schemeDiscount || 0,
    tradeDiscount: tradeDiscount || 0,
    taxableSubtotal: taxableSubtotal || 0,
    taxableAfterExtraDisc: taxableAfterExtraDisc || 0,
    totalGst: totalGst || 0,
    grandTotal: grandTotal || 0,
    amountPaid: amountPaid || 0,
    amountDue: amountDue !== undefined ? amountDue : ((grandTotal || 0) - (amountPaid || 0)),
    status: "CONFIRMED",
    createdBy: userId,
    isInterCompany: Boolean(payload.isInterCompany || payload.originSaleInvoiceId),
    originSaleInvoiceId: payload.originSaleInvoiceId || null,
    originCompanyId: payload.originCompanyId || null,
  });

  if (payload.originSaleInvoiceId) {
    try {
      await SalesInvoice.updateOne(
        {
          _id: payload.originSaleInvoiceId,
          inwardStatus: { $ne: "ACCEPTED" },
        },
        {
          $set: {
            inwardStatus: "ACCEPTED",
            inwardPurchaseBillId: bill._id,
            inwardPurchaseBillNo: bill.purchaseBillNo,
            inwardAcceptedAt: new Date(),
            inwardAcceptedBy: userId || null,
          },
        }
      );
    } catch (invErr) {
      console.error("Error updating origin sale invoice inward status:", invErr);
    }
  }

  return bill;
};

const updatePurchaseBill = async (billId, workspaceId, companyId, userId, payload) => {
  const existingBill = await purchaseBillRepository.findPurchaseBillByIdAndWorkspace(
    billId,
    workspaceId,
    companyId
  );

  if (!existingBill) {
    throw new ApiError(404, "Purchase bill not found");
  }

  const {
    supplierId,
    branchId,
    purchaseBillNo,
    invoiceDate,
    rateBasis,
    items,
    extraDiscountPct,
    extraDiscountAmt,
    grossTotal,
    schemeDiscount,
    tradeDiscount,
    taxableSubtotal,
    taxableAfterExtraDisc,
    totalGst,
    grandTotal,
    amountPaid = 0,
    amountDue,
    gstSlabs,
    supplierInvoiceNo,
  } = payload;

  if (!items || items.length === 0) {
    throw new ApiError(400, "Purchase bill must have at least one item");
  }

  if (!supplierId) {
    throw new ApiError(400, "Supplier is required");
  }

  // Determine financial period based on (updated) invoice date
  let period = await financialPeriodRepository.findPeriodByDate(companyId, workspaceId, invoiceDate ? new Date(invoiceDate) : new Date());
  if (!period) {
    const periods = await financialPeriodRepository.getPeriods(workspaceId, companyId, { isCurrent: true, all: true });
    period = periods.periods && periods.periods[0];
  }
  const financialPeriodId = period ? period._id : null;
  const resolvedItems = await resolveOrProvisionItems(workspaceId, items, userId);
  const updatedBill = await purchaseBillRepository.updatePurchaseBill(
    billId,
    workspaceId,
    companyId,
    {
      branchId: branchId || null,
      supplierId,
      purchaseBillNo: purchaseBillNo || existingBill.purchaseBillNo,
      supplierInvoiceNo: supplierInvoiceNo !== undefined ? supplierInvoiceNo : existingBill.supplierInvoiceNo,
      invoiceDate: invoiceDate || "",
      financialPeriodId,
      rateBasis: rateBasis || "PTS",
      items: resolvedItems,
      extraDiscountPct: extraDiscountPct || 0,
      extraDiscountAmt: extraDiscountAmt || 0,
      grossTotal: grossTotal || 0,
      schemeDiscount: schemeDiscount || 0,
      tradeDiscount: tradeDiscount || 0,
      taxableSubtotal: taxableSubtotal || 0,
      taxableAfterExtraDisc: taxableAfterExtraDisc || 0,
      totalGst: totalGst || 0,
      grandTotal: grandTotal || 0,
      amountPaid: amountPaid || 0,
      amountDue: amountDue !== undefined ? amountDue : ((grandTotal || 0) - (amountPaid || 0)),
      gstSlabs: gstSlabs || [],
    }
  );

  return updatedBill;
};

const getPurchaseBills = async (workspaceId, companyId, query = {}) => {
  const { page, limit, sort, ...filters } = query;
  return purchaseBillRepository.getPurchaseBills(
    workspaceId,
    companyId,
    filters,
    { page, limit, sort }
  );
};

const getPurchaseBillById = async (billId, companyId, workspaceId) => {
  const bill = await purchaseBillRepository.findPurchaseBillByIdAndWorkspace(
    billId,
    workspaceId,
    companyId
  );

  if (!bill) {
    throw new ApiError(404, "Purchase bill not found");
  }

  return bill;
};

const ingestPurchaseBill = async (billId, workspaceId, companyId, branchId, userId) => {
  const bill = await purchaseBillRepository.findPurchaseBillByIdAndWorkspace(
    billId,
    workspaceId,
    companyId
  );

  if (!bill) {
    throw new ApiError(404, "Purchase bill not found");
  }

  if (bill.status === "RECEIVED") {
    throw new ApiError(400, "Purchase bill has already been ingested (RECEIVED).");
  }

  // Determine effective target branch:
  // 1. Priority to bill.branchId if recorded on the purchase bill
  // 2. Caller/header branchId
  // 3. Fallback to first company active branch if neither was specified
  let effectiveBranchId = bill.branchId || branchId || null;
  if (!effectiveBranchId) {
    try {
      const activeBranches = await branchRepository.getCompanyBranches(companyId);
      if (Array.isArray(activeBranches) && activeBranches.length > 0) {
        effectiveBranchId = activeBranches[0]._id;
      }
    } catch (bErr) { }
  }

  // Ensure bill has branchId persisted if missing
  if (effectiveBranchId && !bill.branchId) {
    bill.branchId = effectiveBranchId;
    await bill.save();
  }

  // Iterate over all items in the purchase bill
  for (const item of bill.items) {
    if (!item.productId && item.name && String(item.name).trim()) {
      const cleanName = String(item.name).trim();
      let wsProd = await WorkspaceProduct.findOne({
        workspaceId,
        isDeleted: false,
        name: { $regex: new RegExp(`^${cleanName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
      });
      if (!wsProd) {
        try {
          wsProd = await WorkspaceProduct.create({
            workspaceId,
            name: cleanName,
            productType: "medicine",
            pack: item.pack || "10's",
            hsn: item.hsn ? String(item.hsn) : "3004",
            hsnTaxpercent: item.gst !== undefined ? Number(item.gst) : 5,
            mrp: Number(item.mrp) || 0,
            pts: Number(item.rate) || 0,
            ptr: Number(item.rateB || item.rate) || 0,
            rateA: Number(item.rateA || item.rate) || 0,
            rateB: Number(item.rateB || item.rate) || 0,
            rateC: Number(item.rateC || item.rate) || 0,
            source: "workspace",
            status: "active",
            createdBy: bill.createdBy,
          });
        } catch (e) {
          wsProd = await WorkspaceProduct.findOne({ workspaceId, isDeleted: false, name: cleanName });
        }
      }
      if (wsProd) {
        item.productId = wsProd._id;
        await bill.save();
      }
    }

    if (!item.productId) continue;

    const totalIngestQty = (Number(item.qty) || 0) + (Number(item.freeQty) || 0);
    if (totalIngestQty <= 0) continue;

    const formattedExpiry = formatExpiry(item.expiry);

    // Calculate effective scheme percentage:
    // 1. item.saleScheme (explicit sale scheme override if > 0)
    // 2. item.schPct (direct scheme percentage entered on purchase bill)
    // 3. item.schemeDiscountPercent / item.scheme
    // 4. calculated from freeQty: (freeQty / (qty + freeQty)) * 100
    const calculatedFreeScheme = (Number(item.qty) > 0 && Number(item.freeQty) > 0)
      ? Number(((Number(item.freeQty) / (Number(item.qty) + Number(item.freeQty))) * 100).toFixed(2))
      : 0;

    const effectiveScheme = Number(
      (Number(item.saleScheme) > 0 ? Number(item.saleScheme) : 0) ||
      Number(item.schPct) ||
      Number(item.schemeDiscountPercent) ||
      Number(item.scheme) ||
      calculatedFreeScheme ||
      0
    );

    // 1. Update or Create Batch strictly scoped to effectiveBranchId
    const batchFilter = {
      workspaceId,
      product: item.productId,
      batchNo: item.batch,
      expiryDate: formattedExpiry,
    };
    if (effectiveBranchId) {
      batchFilter.branch_id = effectiveBranchId;
    }

    let batch = await Batch.findOne(batchFilter);

    if (batch) {
      batch.batchQty += totalIngestQty;
      // Update rates from the latest purchase bill
      batch.mrp = item.mrp || batch.mrp;
      batch.rate = item.rate || batch.rate;
      batch.rateA = item.rateA || batch.rateA;
      batch.rateB = item.rateB || batch.rateB;
      batch.rateC = item.rateC || batch.rateC;
      batch.finalRateA = item.finalRateA || batch.finalRateA;
      batch.finalRateB = item.finalRateB || batch.finalRateB;
      batch.finalRateC = item.finalRateC || batch.finalRateC;
      batch.schemeDiscountPercent = effectiveScheme > 0 ? effectiveScheme : batch.schemeDiscountPercent;
      batch.purchaseBillId = bill._id;
      await batch.save();
    } else {
      batch = await Batch.create({
        workspaceId,
        branch_id: effectiveBranchId || null,
        product: item.productId,
        batchNo: item.batch,
        expiryDate: formattedExpiry,
        batchQty: totalIngestQty,
        mrp: item.mrp || 0,
        rate: item.rate || 0,
        rateA: item.rateA || 0,
        rateB: item.rateB || 0,
        rateC: item.rateC || 0,
        finalRateA: item.finalRateA || 0,
        finalRateB: item.finalRateB || 0,
        finalRateC: item.finalRateC || 0,
        schemeDiscountPercent: effectiveScheme,
        purchaseBillId: bill._id,
      });
    }

    // 2. Update or Create ProductFacility strictly scoped to effectiveBranchId
    if (effectiveBranchId) {
      let facility = await ProductFacility.findOne({
        workspaceId,
        facility_id: effectiveBranchId,
        product_id: item.productId,
      });

      if (facility) {
        facility.total_qty_available += totalIngestQty;
        facility.qoh += totalIngestQty;
        facility.atp += totalIngestQty;
        await facility.save();
      } else {
        facility = await ProductFacility.create({
          workspaceId,
          facility_id: effectiveBranchId,
          product_id: item.productId,
          total_qty_available: totalIngestQty,
          qoh: totalIngestQty,
          atp: totalIngestQty,
        });
      }
    }

    // 3. Update Workspace Product with latest rates
    const productUpdate = {};
    if (item.mrp !== undefined) productUpdate.mrp = item.mrp;
    if (item.finalRateA !== undefined) {
      productUpdate.rateA = item.finalRateA;
      productUpdate.finalRateA = item.finalRateA;
      productUpdate.pts = item.finalRateA;
    }
    if (item.finalRateB !== undefined) {
      productUpdate.rateB = item.finalRateB;
      productUpdate.finalRateB = item.finalRateB;
      productUpdate.ptr = item.finalRateB;
    }
    if (item.rateC !== undefined) {
      productUpdate.rateC = item.rateC;
    }
    if (item.cRatePct !== undefined) {
      productUpdate.rateCPercentage = item.cRatePct;
    }
    if (item.finalRateC !== undefined) productUpdate.finalRateC = item.finalRateC;
    if (item.hsn) productUpdate.hsn = item.hsn;
    if (item.gst !== undefined) productUpdate.hsnTaxpercent = item.gst;

    if (Object.keys(productUpdate).length > 0) {
      await WorkspaceProduct.updateOne(
        { _id: item.productId, workspaceId },
        { $set: productUpdate }
      );
    }
  }

  // 3. Mark the Purchase Bill as RECEIVED
  const updatedBill = await purchaseBillRepository.updatePurchaseBill(
    billId,
    workspaceId,
    companyId,
    { status: "RECEIVED" }
  );

  // 4. Create Journal Voucher for Purchase
  console.log("Creating journal voucher for purchase...");
  try {
    const supplier = await Supplier.findById(bill.supplierId);
    let cogsAccount = await Account.findOne({ workspaceId, companyId, accountCode: "COGS" }) || await Account.findOne({ workspaceId, companyId, accountCategory: "PURCHASE" });
    let taxAccount = await Account.findOne({ workspaceId, companyId, accountCode: "TAX-PAYABLE" }) || await Account.findOne({ workspaceId, companyId, accountCategory: "GST" });

    if (supplier && supplier.ledgerAccountId && cogsAccount) {
      const lines = [];
      const cogsAmount = bill.taxableAfterExtraDisc > 0 ? bill.taxableAfterExtraDisc : bill.taxableSubtotal;
      
      lines.push({
        accountId: cogsAccount._id.toString(),
        debit: cogsAmount,
        credit: 0,
        narration: `Purchase against bill ${bill.purchaseBillNo}`,
      });

      if (taxAccount && bill.totalGst > 0) {
        lines.push({
          accountId: taxAccount._id.toString(),
          debit: bill.totalGst,
          credit: 0,
          narration: `Input GST for bill ${bill.purchaseBillNo}`,
        });
      }

      lines.push({
        accountId: supplier.ledgerAccountId.toString(),
        debit: 0,
        credit: bill.amountDue !== undefined ? bill.amountDue : bill.grandTotal,
        narration: `Purchase from supplier for bill ${bill.purchaseBillNo}`,
      });

      if (bill.amountPaid && bill.amountPaid > 0) {
        let paymentAccount = await Account.findOne({ workspaceId, companyId, accountCode: "CASH" }) 
                          || await Account.findOne({ workspaceId, companyId, accountCategory: "CASH" });
        if (paymentAccount) {
          lines.push({
            accountId: paymentAccount._id.toString(),
            debit: 0,
            credit: bill.amountPaid,
            narration: `Advance payment for bill ${bill.purchaseBillNo}`,
          });
        } else {
          // Fallback to avoid out-of-balance if Cash account is missing
          lines[lines.length - 1].credit += bill.amountPaid;
        }
      }

      // Handle small rounding differences
      let totalDebit = lines.reduce((acc, l) => acc + l.debit, 0);
      let totalCredit = lines.reduce((acc, l) => acc + l.credit, 0);
      if (Math.abs(totalDebit - totalCredit) > 0.0001) {
        // Adjust the COGS line to balance
        lines[0].debit += (totalCredit - totalDebit);
      }

      await journalVoucherService.createJournalVoucher(workspaceId, companyId, userId, {
        lines,
        voucherDate: bill.invoiceDate || bill.createdAt,
        voucherType: VOUCHER_TYPE.PURCHASE,
        referenceNumber: bill.purchaseBillNo,
        narration: `Purchase Bill Ingested: ${bill.purchaseBillNo}`,
        status: VOUCHER_STATUS.POSTED,
      });
      console.log("Purchase journal voucher created and posted successfully.");
    } else {
      console.log("Missing supplier ledger account or COGS account, skipped journal creation.");
    }
  } catch (e) {
    console.error("Error creating purchase journal voucher:", e);
  }

  // 5. Create GSTR-2 Ledger Entry on Ingestion
  try {
    const halfGst = (bill.totalGst || 0) / 2;
    const company = await Company.findOne({ _id: companyId, workspaceId });
    const supplier = await Supplier.findOne({ _id: bill.supplierId, workspaceId });
    const companyGstin = company?.gstin || "";
    const supplierGstin = supplier?.gstNumber || "";
    const isIgst = companyGstin && supplierGstin && companyGstin.substring(0, 2) !== supplierGstin.substring(0, 2);

    let resolvedBranchId = effectiveBranchId;
    if (!resolvedBranchId) {
      resolvedBranchId = (await branchRepository.getDefaultBranch(workspaceId))?._id || null;
    }

    // Clean up any existing GSTR-2 entries for this bill to guarantee idempotency
    await gstLedgerRepository.deleteGstLedgerEntriesByVoucherId(bill._id);

    await gstLedgerRepository.createGstLedgerEntry({
      workspaceId,
      companyId,
      branchId: resolvedBranchId || null,
      partyId: bill.supplierId,
      voucherId: bill._id,
      voucherNumber: bill.purchaseBillNo,
      voucherDate: bill.invoiceDate ? new Date(bill.invoiceDate) : new Date(),
      gstType: "GSTR-2",
      groupDescription: "B2B Supplies",
      taxableAmount: bill.taxableSubtotal || bill.taxableAfterExtraDisc || 0,
      cgst: isIgst ? 0 : halfGst,
      sgst: isIgst ? 0 : halfGst,
      igst: isIgst ? (bill.totalGst || 0) : 0,
      totalAmount: bill.grandTotal || 0,
      narration: `Purchase Bill Ingested #${bill.purchaseBillNo}`,
    });
    console.log(`[Service] Successfully created GSTR-2 entry for ingested bill: ${bill.purchaseBillNo}`);
  } catch (err) {
    console.error("Failed to auto-create GSTR-2 entry for ingested purchase bill:", err);
  }

  return updatedBill;
};

const getPurchaseHistory = async (productId, workspaceId, companyId, query = {}) => {
  return await purchaseBillRepository.getPurchaseHistory(
    productId,
    workspaceId,
    companyId,
    query
  );
};

const payPurchaseBill = async (billId, workspaceId, companyId, userId, payload) => {
  const { amount, accountId, paymentDate, referenceNumber, narration } = payload;
  
  if (!amount || amount <= 0) {
    throw new ApiError(400, "Valid payment amount is required");
  }

  const bill = await purchaseBillRepository.findPurchaseBillByIdAndWorkspace(
    billId,
    workspaceId,
    companyId
  );

  if (!bill) {
    throw new ApiError(404, "Purchase bill not found");
  }

  const supplier = await Supplier.findById(bill.supplierId);
  if (!supplier || !supplier.ledgerAccountId) {
    throw new ApiError(400, "Supplier ledger account is not configured properly");
  }

  // Find the payment source account (Cash/Bank)
  let paymentAccount = null;
  if (accountId) {
    paymentAccount = await Account.findOne({ _id: accountId, workspaceId, companyId });
  } else {
    // Default to a generic CASH account
    paymentAccount = await Account.findOne({ workspaceId, companyId, accountCode: "CASH" }) 
                  || await Account.findOne({ workspaceId, companyId, accountCategory: "CASH" });
  }

  if (!paymentAccount) {
    throw new ApiError(400, "Payment source account (Cash/Bank) could not be determined");
  }

  // 1. Update Bill Paid Amounts
  const newAmountPaid = (bill.amountPaid || 0) + Number(amount);
  const newAmountDue = Math.max(0, (bill.grandTotal || 0) - newAmountPaid);
  
  const updateData = {
    amountPaid: newAmountPaid, 
    amountDue: newAmountDue 
  };

  // If the bill is fully paid, change status to PAID
  if (newAmountDue === 0) {
    updateData.status = "PAID";
  } else if (bill.status === "RECEIVED") {
    // Optionally change to partially paid, but for now we keep it as RECEIVED or set to PARTIALLY_PAID
    // The user specifically requested to change to PAID when from received.
    updateData.status = "PARTIALLY_PAID"; 
  }

  const updatedBill = await purchaseBillRepository.updatePurchaseBill(
    billId,
    workspaceId,
    companyId,
    updateData
  );

  // 2. Create Journal Voucher for Payment
  // Supplier Payment: Supplier A/c Dr, Cash/Bank A/c Cr
  const lines = [
    {
      accountId: supplier.ledgerAccountId.toString(),
      debit: Number(amount),
      credit: 0,
      narration: narration || `Payment for Bill ${bill.purchaseBillNo}`,
    },
    {
      accountId: paymentAccount._id.toString(),
      debit: 0,
      credit: Number(amount),
      narration: narration || `Paid to supplier for Bill ${bill.purchaseBillNo}`,
    }
  ];

  await journalVoucherService.createJournalVoucher(workspaceId, companyId, userId, {
    lines,
    voucherDate: paymentDate ? new Date(paymentDate) : new Date(),
    voucherType: VOUCHER_TYPE.PAYMENT,
    referenceNumber: referenceNumber || bill.purchaseBillNo,
    narration: narration || `Payment made against Bill ${bill.purchaseBillNo}`,
    status: VOUCHER_STATUS.POSTED,
  });

  return updatedBill;
};

const bulkPayPurchaseBills = async (workspaceId, companyId, userId, payload) => {
  const { supplierId, totalAmount, allocations, accountId, paymentDate, paymentMode, referenceNumber, narration } = payload;
  
  if (!totalAmount || totalAmount <= 0) {
    throw new ApiError(400, "Valid total payment amount is required");
  }

  if (!allocations || !Array.isArray(allocations) || allocations.length === 0) {
    throw new ApiError(400, "Bill allocations are required for bulk payment");
  }

  const supplier = await Supplier.findById(supplierId);
  if (!supplier || !supplier.ledgerAccountId) {
    throw new ApiError(400, "Supplier ledger account is not configured properly");
  }

  let paymentAccount = null;
  if (accountId) {
    paymentAccount = await Account.findOne({ _id: accountId, workspaceId, companyId });
  } else {
    paymentAccount = await Account.findOne({ workspaceId, companyId, accountCode: "CASH" }) 
                  || await Account.findOne({ workspaceId, companyId, accountCategory: "CASH" });
  }

  if (!paymentAccount) {
    throw new ApiError(400, "Payment source account (Cash/Bank) could not be determined");
  }

  let actualTotalAllocated = 0;
  
  // 1. Update Each Bill
  for (const alloc of allocations) {
    if (alloc.amountPaid <= 0) continue;
    
    const bill = await purchaseBillRepository.findPurchaseBillByIdAndWorkspace(alloc.billId, workspaceId, companyId);
    if (!bill) continue;

    actualTotalAllocated += alloc.amountPaid;

    const newAmountPaid = (bill.amountPaid || 0) + Number(alloc.amountPaid);
    const newAmountDue = Math.max(0, (bill.grandTotal || 0) - newAmountPaid);
    
    const updateData = { amountPaid: newAmountPaid, amountDue: newAmountDue };
    
    if (newAmountDue === 0) {
      updateData.status = "PAID";
    } else if (bill.status === "RECEIVED" || bill.status === "CONFIRMED") {
      updateData.status = "PARTIALLY_PAID"; 
    }

    await purchaseBillRepository.updatePurchaseBill(bill._id, workspaceId, companyId, updateData);
  }

  if (actualTotalAllocated <= 0) {
    throw new ApiError(400, "No valid amounts allocated to bills");
  }

  // 2. Create Single Journal Voucher for Bulk Payment
  const lines = [
    {
      accountId: supplier.ledgerAccountId.toString(),
      debit: Number(actualTotalAllocated),
      credit: 0,
      narration: narration || `Bulk Payment via ${paymentMode || "Cash"}`,
    },
    {
      accountId: paymentAccount._id.toString(),
      debit: 0,
      credit: Number(actualTotalAllocated),
      narration: narration || `Bulk Paid to supplier`,
    }
  ];

  await journalVoucherService.createJournalVoucher(workspaceId, companyId, userId, {
    lines,
    voucherDate: paymentDate ? new Date(paymentDate) : new Date(),
    voucherType: VOUCHER_TYPE.PAYMENT,
    referenceNumber: referenceNumber || `BULK-${Date.now()}`,
    narration: narration || `Bulk Payment made to supplier (${allocations.length} bills)`,
    status: VOUCHER_STATUS.POSTED,
  });

  return { success: true, allocated: actualTotalAllocated };
};

const escapeRegex = (str) => String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Helper to resolve or auto-provision a Supplier record for an origin sister company in the receiving company
 */
const resolveOrCreateSupplierForOriginCompany = async (
  workspaceId,
  destinationCompanyId,
  originCompanyId,
  branchId = null
) => {
  if (!originCompanyId) return null;
  const originCompany = await Company.findById(originCompanyId).lean();
  if (!originCompany) return null;

  const originGst = (originCompany?.gstin || originCompany?.gstNumber || "").trim().toUpperCase();
  const originName = (originCompany?.name || originCompany?.legalName || "").trim();

  let supplier = null;
  if (originGst || originName) {
    supplier = await Supplier.findOne({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      companyId: new mongoose.Types.ObjectId(destinationCompanyId),
      isDeleted: false,
      $or: [
        ...(originGst ? [{ gstNumber: originGst }] : []),
        ...(originName ? [{ businessName: { $regex: new RegExp(`^${escapeRegex(originName)}$`, "i") } }] : []),
      ],
    }).lean();
  }

  if (!supplier) {
    const nextCode = `SUP-${Date.now().toString().slice(-4)}`;
    supplier = await Supplier.create({
      workspaceId,
      companyId: destinationCompanyId,
      branchId: branchId || null,
      supplierCode: nextCode,
      businessName: originName || "Inter-Company Supplier",
      gstNumber: originGst || null,
      panNumber: originGst && originGst.length >= 10 ? originGst.substring(2, 12) : null,
      contactPerson: originName || "Inter-Company",
      address: originCompany?.address || {},
      creditDays: 30,
      supplierType: "Distributor",
    });
  }

  return {
    _id: supplier._id,
    id: supplier._id,
    businessName: supplier.businessName,
    name: supplier.businessName,
    gstNumber: supplier.gstNumber || "",
    mobile: supplier.mobile || "",
  };
};

/**
 * Get paginated list of Incoming Inter-Company Consignments (Sales Invoices billed by sister companies)
 */
const getIncomingConsignments = async (workspaceId, companyId, query = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, parseInt(query.limit, 10) || 20);
  const skip = (page - 1) * limit;

  const filter = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    destinationCompanyId: new mongoose.Types.ObjectId(companyId),
    companyId: { $ne: new mongoose.Types.ObjectId(companyId) },
    isDeleted: { $ne: true },
    status: { $ne: "Cancelled" },
  };

  if (query.status && query.status !== "all") {
    if (query.status === "PENDING") {
      filter.inwardStatus = { $in: ["PENDING", null] };
    } else if (query.status === "ACCEPTED") {
      filter.inwardStatus = "ACCEPTED";
    } else {
      filter.inwardStatus = query.status;
    }
  }

  if (query.search) {
    const s = String(query.search).trim();
    const regex = new RegExp(escapeRegex(s), "i");
    filter.$or = [
      { invoiceNo: regex },
      { "items.name": regex },
      { "items.batch": regex },
    ];
  }

  const [invoices, total] = await Promise.all([
    SalesInvoice.find(filter)
      .populate("companyId", "name legalName gstin gstNumber code address phone")
      .populate("branchId", "name branchCode address")
      .populate("inwardPurchaseBillId", "purchaseBillNo status grandTotal createdAt")
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SalesInvoice.countDocuments(filter),
  ]);

  const mapped = await Promise.all(
    (invoices || []).map(async (doc) => {
      const originCompId = doc.companyId?._id || doc.companyId;
      let resolvedSupplier = null;
      try {
        resolvedSupplier = await resolveOrCreateSupplierForOriginCompany(
          workspaceId,
          companyId,
          originCompId
        );
      } catch (sErr) {
        console.error("Error resolving supplier for consignment:", sErr);
      }

      const cartItems = (doc.items || []).map((it) => {
        const qty = Number(it.qty || it.quantity || 0);
        const freeQty = Number(it.freeQty || 0);
        const rate = Number(it.rate || it.unitPrice || it.price || 0);
        const mrp = Number(it.mrp || rate);
        const gst = Number(it.gst || it.gstRate || it.hsnTaxpercent || 0);
        const disc = Number(it.disc || it.discount || it.itemDiscount || 0);
        const amount = Number(it.amount || it.total || qty * rate);
        const hsn = it.hsn ? String(it.hsn).trim() : (it.hsnCode ? String(it.hsnCode).trim() : "3004");
        const pack = it.pack || it.packSize || "";
        const name = it.name || it.productName || it.displayName || "Medicine";
        const batch = it.batch || it.batchNo || "";
        const expiry = it.expiry || it.expDate || it.expiryDate || "";

        const calculatedSch = (qty > 0 && freeQty > 0)
          ? Number(((freeQty / (qty + freeQty)) * 100).toFixed(2))
          : 0;
        const resolvedScheme = Number(
          it.schPct ||
          it.saleScheme ||
          it.schemeDiscountPercent ||
          it.schemePercent ||
          it.schemeDisc ||
          it.scheme ||
          calculatedSch ||
          0
        );

        return {
          id: `${it.productId || it._id || Date.now()}-${Math.random()}`,
          productId: it.productId || it.product_id || it.workspaceProductId || null,
          name,
          pack,
          batch,
          expiry,
          qty,
          freeQty,
          schPct: resolvedScheme,
          saleScheme: resolvedScheme,
          schemeDiscountPercent: resolvedScheme,
          disc,
          cRatePct: Number(it.cRatePct || 0),
          mrp,
          hsn,
          gst,
          rate,
          amount,
          rateA: Number(it.rateA || rate),
          rateB: Number(it.rateB || rate),
          rateC: Number(it.rateC || rate),
          retailerMarginPercent: 20,
          stockistMarginPercent: 10,
        };
      });

      return {
        _id: doc._id,
        invoiceNo: doc.invoiceNo,
        originCompany: {
          _id: originCompId,
          name: doc.companyId?.name || "Supplier Company",
          legalName: doc.companyId?.legalName || "",
          gstNumber: doc.companyId?.gstin || doc.companyId?.gstNumber || "",
          address: doc.companyId?.address || {},
          phone: doc.companyId?.phone || {},
        },
        originBranch: {
          _id: doc.branchId?._id || doc.branchId,
          name: doc.branchId?.name || "Main Branch",
          branchCode: doc.branchId?.branchCode || "",
        },
        supplier: resolvedSupplier,
        cartItems,
        date: doc.date,
        subtotal: doc.subtotal,
        discount: doc.discount,
        schemeDiscount: doc.schemeDiscount || 0,
        tax: doc.tax,
        grandTotal: doc.grandTotal,
        itemCount: (doc.items || []).length,
        items: doc.items || [],
        inwardStatus: doc.inwardStatus || "PENDING",
        inwardPurchaseBillId: doc.inwardPurchaseBillId?._id || doc.inwardPurchaseBillId,
        inwardPurchaseBillNo: doc.inwardPurchaseBillNo || doc.inwardPurchaseBillId?.purchaseBillNo || null,
        inwardAcceptedAt: doc.inwardAcceptedAt,
        createdAt: doc.createdAt,
      };
    })
  );

  const pendingCount = await SalesInvoice.countDocuments({
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    destinationCompanyId: new mongoose.Types.ObjectId(companyId),
    companyId: { $ne: new mongoose.Types.ObjectId(companyId) },
    isDeleted: { $ne: true },
    status: { $ne: "Cancelled" },
    inwardStatus: { $in: ["PENDING", null] },
  });

  return {
    data: mapped,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
    pendingCount,
  };
};

/**
 * Accept an Incoming Consignment and materialize it into an official Purchase Bill in the receiving company
 */
const acceptIncomingConsignment = async (
  invoiceId,
  workspaceId,
  destinationCompanyId,
  targetBranchId,
  userId,
  options = {}
) => {
  if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
    throw new ApiError(400, "Invalid invoice ID");
  }

  const invoice = await SalesInvoice.findOne({
    _id: invoiceId,
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    destinationCompanyId: new mongoose.Types.ObjectId(destinationCompanyId),
    isDeleted: { $ne: true },
  });

  if (!invoice) {
    throw new ApiError(404, "Incoming consignment record not found");
  }

  if (invoice.status === "Cancelled") {
    throw new ApiError(400, "Cannot accept a cancelled sale bill");
  }

  if (invoice.inwardStatus === "ACCEPTED") {
    throw new ApiError(
      400,
      `This consignment has already been accepted as purchase bill #${invoice.inwardPurchaseBillNo || ""}`
    );
  }

  // 1. Resolve Destination Branch
  let resolvedBranchId = targetBranchId || options.branchId || null;
  if (!resolvedBranchId) {
    try {
      const activeBranches = await branchRepository.getCompanyBranches(destinationCompanyId);
      if (Array.isArray(activeBranches) && activeBranches.length > 0) {
        resolvedBranchId = activeBranches[0]._id;
      }
    } catch {}
  }

  // 2. Resolve or provision Supplier record in destination company
  const originCompany = await Company.findById(invoice.companyId).lean();
  const originGst = (originCompany?.gstin || originCompany?.gstNumber || "").trim().toUpperCase();
  const originName = (originCompany?.name || originCompany?.legalName || "").trim();

  let supplier = null;
  if (originGst || originName) {
    supplier = await Supplier.findOne({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      companyId: new mongoose.Types.ObjectId(destinationCompanyId),
      isDeleted: false,
      $or: [
        ...(originGst ? [{ gstNumber: originGst }] : []),
        ...(originName ? [{ businessName: { $regex: new RegExp(`^${escapeRegex(originName)}$`, "i") } }] : []),
      ],
    });
  }

  if (!supplier) {
    const nextCode = `SUP-${Date.now().toString().slice(-4)}`;
    supplier = await Supplier.create({
      workspaceId,
      companyId: destinationCompanyId,
      branchId: resolvedBranchId || null,
      supplierCode: nextCode,
      businessName: originName || "Inter-Company Supplier",
      gstNumber: originGst || null,
      panNumber: originGst && originGst.length >= 10 ? originGst.substring(2, 12) : null,
      contactPerson: originName || "Inter-Company",
      address: originCompany?.address || {},
      creditDays: 30,
      supplierType: "Distributor",
    });
  }

  // 3. Map line items
  const mappedItems = (invoice.items || []).map((it) => {
    const qty = Number(it.qty || it.quantity || 0);
    const freeQty = Number(it.freeQty || 0);
    const rate = Number(it.rate || it.unitPrice || it.price || 0);
    const mrp = Number(it.mrp || rate);
    const gst = Number(it.gst || it.gstRate || it.hsnTaxpercent || 0);
    const disc = Number(it.disc || it.discount || it.itemDiscount || 0);
    const amount = Number(it.amount || it.total || (qty * rate));
    const hsn = it.hsn ? String(it.hsn).trim() : (it.hsnCode ? String(it.hsnCode).trim() : "3004");
    const pack = it.pack || it.packSize || "";
    const name = it.name || it.productName || it.displayName || "Medicine";
    const batch = it.batch || it.batchNo || "";
    const expiry = it.expiry || it.expDate || it.expiryDate || "";

    const calculatedSch = (qty > 0 && freeQty > 0)
      ? Number(((freeQty / (qty + freeQty)) * 100).toFixed(2))
      : 0;
    const resolvedScheme = Number(
      it.saleScheme ||
      it.schPct ||
      it.schemeDiscountPercent ||
      it.schemePercent ||
      it.schemeDisc ||
      it.scheme ||
      calculatedSch ||
      0
    );

    return {
      productId: it.productId || it.product_id || it.workspaceProductId || null,
      name,
      pack,
      batch,
      expiry,
      qty,
      freeQty,
      schPct: resolvedScheme,
      disc,
      cRatePct: 0,
      mrp,
      hsn,
      gst,
      rate,
      amount,
      rateA: Number(it.rateA || 0),
      rateB: Number(it.rateB || 0),
      rateC: Number(it.rateC || 0),
      finalRateA: Number(it.finalRateA || 0),
      finalRateB: Number(it.finalRateB || 0),
      finalRateC: Number(it.finalRateC || 0),
      saleScheme: resolvedScheme,
      schemeDiscountPercent: resolvedScheme,
    };
  });

  // 4. Create Purchase Bill
  const billPayload = {
    supplierId: supplier._id,
    branchId: resolvedBranchId,
    supplierInvoiceNo: invoice.invoiceNo,
    invoiceDate: invoice.date ? new Date(invoice.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    rateBasis: "PTS",
    items: mappedItems,
    grossTotal: invoice.subtotal || invoice.grandTotal,
    schemeDiscount: Number(invoice.schemeDiscount) || 0,
    tradeDiscount: invoice.discount || 0,
    taxableSubtotal: invoice.subtotal || 0,
    taxableAfterExtraDisc: invoice.subtotal || 0,
    totalGst: invoice.tax || 0,
    grandTotal: invoice.grandTotal || 0,
    amountPaid: 0,
    amountDue: invoice.grandTotal || 0,
    isInterCompany: true,
    originSaleInvoiceId: invoice._id,
    originCompanyId: originCompany?._id || invoice.companyId,
  };

  const createdBill = await createPurchaseBill(workspaceId, destinationCompanyId, userId, billPayload);

  // 5. Ingest stock if requested
  if (options.ingestStock !== false) {
    try {
      await ingestPurchaseBill(createdBill._id, workspaceId, destinationCompanyId, resolvedBranchId, userId);
      createdBill.inventoryMaterialized = true;
      await createdBill.save();
    } catch (ingestErr) {
      console.warn("[Inward Acceptance] Auto-ingest warning:", ingestErr?.message);
    }
  }

  // 6. Update SalesInvoice inward tracking fields
  invoice.inwardStatus = "ACCEPTED";
  invoice.inwardPurchaseBillId = createdBill._id;
  invoice.inwardPurchaseBillNo = createdBill.purchaseBillNo;
  invoice.inwardAcceptedAt = new Date();
  invoice.inwardAcceptedBy = new mongoose.Types.ObjectId(userId);
  await invoice.save();

  return {
    success: true,
    purchaseBill: createdBill,
    invoiceNo: invoice.invoiceNo,
  };
};

const purchaseBillService = {
  createPurchaseBill,
  updatePurchaseBill,
  getPurchaseBills,
  getPurchaseBillById,
  ingestPurchaseBill,
  getPurchaseHistory,
  payPurchaseBill,
  bulkPayPurchaseBills,
  getIncomingConsignments,
  acceptIncomingConsignment,
};

export default purchaseBillService;
