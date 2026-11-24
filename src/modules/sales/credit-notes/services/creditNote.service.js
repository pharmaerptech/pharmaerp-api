import mongoose from "mongoose";
import CreditNote from "../models/creditNote.model.js";
import creditNoteRepository from "../repositories/creditNote.repository.js";
import Customer from "../../../parties/customers/models/customer.model.js";
import { CREDIT_NOTE_STATUS, CREDIT_NOTE_SOURCE, DEFAULT_CREDIT_NOTE_VALIDITY_DAYS } from "../constants/creditNote.constant.js";
import ApiError from "../../../../utils/ApiError.js";

/**
 * Issue an official Credit Note (from sales return or manual adjustment)
 */
export const issueCreditNote = async (data, options = {}) => {
  const session = options.session || null;
  const user = options.user || null;

  const {
    workspaceId,
    companyId,
    branchId = null,
    financialPeriodId = null,
    shiftId = null,
    businessDayId = null,
    customerId: rawCustomerId,
    customerName = null,
    customerPhone = null,
    customerGst = null,
    billingMode = "B2C",
    source = CREDIT_NOTE_SOURCE.SALES_RETURN,
    sourceReturnId = null,
    sourceReturnNo = null,
    originalInvoiceId = null,
    originalInvoiceNo = null,
    subtotal = 0,
    discount = 0,
    tax = 0,
    cgst = 0,
    sgst = 0,
    igst = 0,
    roundOff = 0,
    totalAmount,
    items = [],
    notes = null,
    expiryDays = DEFAULT_CREDIT_NOTE_VALIDITY_DAYS,
  } = data;

  if (!totalAmount || Number(totalAmount) <= 0) {
    throw new ApiError(400, "Credit note total amount must be greater than zero");
  }

  const finalTotal = Math.round(Number(totalAmount) * 100) / 100;

  // Resolve sequential Credit Note number
  const creditNoteNo = await creditNoteRepository.getNextCreditNoteNumber(
    companyId,
    workspaceId,
    branchId,
    new Date(),
    session
  );

  // Compute expiry date
  let expiryDate = null;
  if (expiryDays && expiryDays > 0) {
    const exp = new Date();
    exp.setDate(exp.getDate() + expiryDays);
    expiryDate = exp;
  }

  const isSupplier = data.partyType === "SUPPLIER" || Boolean(data.supplierId);
  const partyType = isSupplier ? "SUPPLIER" : "CUSTOMER";
  const customerId = isSupplier ? null : (data.customerId || null);
  const supplierId = isSupplier ? (data.supplierId || null) : null;
  const supplierName = isSupplier ? (data.supplierName || null) : null;
  const supplierPhone = isSupplier ? (data.supplierPhone || null) : null;
  const supplierGst = isSupplier ? (data.supplierGst || null) : null;

  // Create Credit Note
  const creditNotePayload = {
    workspaceId,
    companyId,
    branchId,
    financialPeriodId,
    shiftId,
    businessDayId,
    creditNoteNo,
    partyType,
    customerId,
    customerName: isSupplier ? null : customerName,
    customerPhone: isSupplier ? null : customerPhone,
    customerGst: isSupplier ? null : customerGst,
    supplierId,
    supplierName,
    supplierPhone,
    supplierGst,
    billingMode,
    source,
    sourceReturnId,
    sourceReturnNo,
    originalInvoiceId,
    originalInvoiceNo,
    subtotal: Number(subtotal) || 0,
    discount: Number(discount) || 0,
    tax: Number(tax) || 0,
    cgst: Number(cgst) || 0,
    sgst: Number(sgst) || 0,
    igst: Number(igst) || 0,
    roundOff: Number(roundOff) || 0,
    totalAmount: finalTotal,
    redeemedAmount: 0,
    balanceAmount: finalTotal,
    status: CREDIT_NOTE_STATUS.ACTIVE,
    issueDate: new Date(),
    expiryDate,
    items: Array.isArray(items) ? items : [],
    redemptions: [],
    notes,
    createdBy: user?._id || null,
    createdByName: user?.name || null,
  };

  const [createdNote] = await CreditNote.create([creditNotePayload], { session });

  if (isSupplier && supplierId) {
    try {
      const resolvedCompanyId = companyId?._id || companyId;
      const resolvedWorkspaceId = workspaceId?._id || workspaceId;
      const resolvedUserId = user?._id || user || null;
      const resolvedSupplierId = supplierId?._id || supplierId;

      const Supplier = mongoose.model("Supplier");
      const supplier = await Supplier.findById(resolvedSupplierId);
      if (supplier) {
        const { ensureSupplierLedgerAccount } = await import(
          "../../../parties/suppliers/services/supplier.service.js"
        );
        const supplierAccountId = await ensureSupplierLedgerAccount(
          supplier,
          resolvedCompanyId,
          resolvedWorkspaceId,
          resolvedUserId
        );

        const { ensurePurchaseAccounts } = await import(
          "../../../catalog/purchase-returns/services/purchaseReturn.service.js"
        );
        const { cogsAccount: purchaseAccount, taxAccount } = await ensurePurchaseAccounts(
          resolvedWorkspaceId,
          resolvedCompanyId,
          resolvedUserId
        );

        if (supplierAccountId && purchaseAccount) {
          const lines = [
            {
              accountId: supplierAccountId.toString(),
              debit: finalTotal,
              credit: 0,
              narration: `Credit Note #${creditNoteNo} to ${supplier.businessName || supplier.name || "Supplier"}`,
            },
            {
              accountId: purchaseAccount._id.toString(),
              debit: 0,
              credit: Number(subtotal) || finalTotal,
              narration: `Credit Note reversal #${creditNoteNo}`,
            },
          ];

          if (taxAccount && Number(tax) > 0) {
            lines.push({
              accountId: taxAccount._id.toString(),
              debit: 0,
              credit: Number(tax),
              narration: `ITC Reversal for Credit Note #${creditNoteNo}`,
            });
          }

          const totDebit = lines.reduce((acc, l) => acc + l.debit, 0);
          const totCredit = lines.reduce((acc, l) => acc + l.credit, 0);
          if (Math.abs(totDebit - totCredit) > 0.0001) {
            lines[1].credit += totDebit - totCredit;
          }

          const { default: journalVoucherService } = await import(
            "../../../finance/journal-vouchers/services/journalVoucher.service.js"
          );
          const { VOUCHER_TYPE } = await import(
            "../../../finance/journal-vouchers/constants/voucherType.constant.js"
          );
          const { VOUCHER_STATUS } = await import(
            "../../../finance/journal-vouchers/constants/voucherStatus.constant.js"
          );

          const createdJV = await journalVoucherService.createJournalVoucher(
            resolvedWorkspaceId,
            resolvedCompanyId,
            resolvedUserId,
            {
              lines,
              voucherDate: new Date(),
              voucherType: VOUCHER_TYPE.PURCHASE_RETURN,
              referenceNumber: creditNoteNo,
              narration: `Credit Note #${creditNoteNo} to ${supplier.businessName || supplier.name || "Supplier"}`,
              status: VOUCHER_STATUS.POSTED,
            },
            session ? { session } : {}
          );

          if (createdJV?._id) {
            const { default: journalPostingService } = await import(
              "../../../finance/journal-vouchers/services/journalPosting.service.js"
            );
            await journalPostingService.postJournalVoucher(
              createdJV._id,
              resolvedCompanyId,
              resolvedWorkspaceId,
              resolvedUserId,
              session ? { session } : {}
            );
          }
        }
      }
    } catch (suppJvErr) {
      console.error("Failed to post journal voucher for supplier credit note:", suppJvErr);
    }
  } else if (customerId) {
    // Atomically increment customer's creditNoteBalance
    await Customer.findByIdAndUpdate(
      customerId,
      { $inc: { creditNoteBalance: finalTotal } },
      { session }
    );
  }

  return createdNote;
};

/**
 * Redeem Credit Notes against a Sales Invoice
 */
export const redeemCreditNotesForInvoice = async (
  customerId,
  amountToRedeem,
  invoice,
  options = {}
) => {
  const session = options.session || null;
  const user = options.user || null;
  const shiftId = options.shiftId || invoice.shiftId || null;
  const specificAllocations = options.creditNoteAllocations || [];

  const neededAmount = Math.round(Number(amountToRedeem) * 100) / 100;
  if (neededAmount <= 0) return { redeemedNotes: [], totalRedeemed: 0 };

  const invoiceGrandTotal = invoice?.grandTotal !== undefined ? Math.round(Number(invoice.grandTotal) * 100) / 100 : null;
  if (invoiceGrandTotal !== null && invoiceGrandTotal > 0 && neededAmount > invoiceGrandTotal + 0.01) {
    throw new ApiError(
      400,
      `Credit note redemption amount (₹${neededAmount.toFixed(2)}) cannot exceed invoice grand total (₹${invoiceGrandTotal.toFixed(2)})`
    );
  }

  const customer = await Customer.findOne({
    _id: customerId,
    isDeleted: false,
  }).session(session);

  if (!customer) {
    throw new ApiError(404, "Customer not found for credit note redemption");
  }

  const curBal = Math.round(Number(customer.creditNoteBalance || 0) * 100) / 100;
  if (curBal < neededAmount - 0.01) {
    throw new ApiError(
      400,
      `Insufficient Credit Note balance. Customer has ₹${curBal.toFixed(
        2
      )} available, but invoice requires ₹${neededAmount.toFixed(2)}`
    );
  }

  let remaining = neededAmount;
  const redemptionsApplied = [];

  // Path A: Specific user-chosen allocations
  if (Array.isArray(specificAllocations) && specificAllocations.length > 0) {
    for (const alloc of specificAllocations) {
      if (remaining <= 0.001) break;
      const cnId = alloc.creditNoteId || alloc._id;
      const reqAmt = Math.min(Number(alloc.amount || 0), remaining);
      if (reqAmt <= 0) continue;

      const cn = await CreditNote.findOne({
        _id: cnId,
        customerId: customer._id,
        isDeleted: false,
        status: { $in: [CREDIT_NOTE_STATUS.ACTIVE, CREDIT_NOTE_STATUS.PARTIALLY_REDEEMED] },
        balanceAmount: { $gte: reqAmt - 0.01 },
      }).session(session);

      if (!cn) {
        throw new ApiError(400, `Selected Credit Note is invalid or has insufficient balance`);
      }

      const deduct = Math.min(Number(cn.balanceAmount), reqAmt);
      cn.redeemedAmount = Math.round((Number(cn.redeemedAmount || 0) + deduct) * 100) / 100;
      cn.balanceAmount = Math.max(0, Math.round((Number(cn.balanceAmount) - deduct) * 100) / 100);

      if (cn.balanceAmount <= 0.001) {
        cn.status = CREDIT_NOTE_STATUS.FULLY_REDEEMED;
        cn.balanceAmount = 0;
      } else {
        cn.status = CREDIT_NOTE_STATUS.PARTIALLY_REDEEMED;
      }

      cn.redemptions.push({
        invoiceId: invoice._id,
        invoiceNo: invoice.invoiceNo,
        amount: deduct,
        redeemedAt: new Date(),
        shiftId,
        createdBy: user?._id || null,
        notes: `Redeemed on bill #${invoice.invoiceNo}`,
      });

      await cn.save({ session });

      redemptionsApplied.push({
        creditNoteId: cn._id,
        creditNoteNo: cn.creditNoteNo,
        amount: deduct,
      });

      remaining -= deduct;
    }
  }

  // Path B: Automatic FIFO allocation for any remaining redemption
  if (remaining > 0.001) {
    const activeNotes = await creditNoteRepository.findActiveCustomerCreditNotes(
      customer._id,
      invoice.companyId,
      invoice.workspaceId,
      session
    );

    for (const cn of activeNotes) {
      if (remaining <= 0.001) break;
      const curNoteBal = Number(cn.balanceAmount || 0);
      if (curNoteBal <= 0) continue;

      const deduct = Math.min(curNoteBal, remaining);
      cn.redeemedAmount = Math.round((Number(cn.redeemedAmount || 0) + deduct) * 100) / 100;
      cn.balanceAmount = Math.max(0, Math.round((curNoteBal - deduct) * 100) / 100);

      if (cn.balanceAmount <= 0.001) {
        cn.status = CREDIT_NOTE_STATUS.FULLY_REDEEMED;
        cn.balanceAmount = 0;
      } else {
        cn.status = CREDIT_NOTE_STATUS.PARTIALLY_REDEEMED;
      }

      cn.redemptions.push({
        invoiceId: invoice._id,
        invoiceNo: invoice.invoiceNo,
        amount: deduct,
        redeemedAt: new Date(),
        shiftId,
        createdBy: user?._id || null,
        notes: `Auto-redeemed on bill #${invoice.invoiceNo}`,
      });

      await cn.save({ session });

      redemptionsApplied.push({
        creditNoteId: cn._id,
        creditNoteNo: cn.creditNoteNo,
        amount: deduct,
      });

      remaining -= deduct;
    }
  }

  if (remaining > 0.01) {
    throw new ApiError(
      400,
      `Could not fulfill credit note redemption. Unallocated: ₹${remaining.toFixed(2)}`
    );
  }

  // Atomically decrement customer's aggregate credit note balance
  await Customer.findByIdAndUpdate(
    customer._id,
    { $inc: { creditNoteBalance: -neededAmount } },
    { session }
  );

  return {
    redeemedNotes: redemptionsApplied,
    totalRedeemed: neededAmount,
  };
};

/**
 * Revert Credit Note redemptions when an invoice is cancelled
 */
export const revertInvoiceCreditNotes = async (
  invoiceId,
  companyId = null,
  workspaceId = null,
  options = {}
) => {
  const session = options.session || null;
  if (!invoiceId) return { totalRestored: 0 };

  const query = {
    "redemptions.invoiceId": mongoose.Types.ObjectId.isValid(invoiceId)
      ? new mongoose.Types.ObjectId(invoiceId)
      : invoiceId,
  };
  if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
    query.companyId = new mongoose.Types.ObjectId(companyId);
  }
  if (workspaceId && mongoose.Types.ObjectId.isValid(workspaceId)) {
    query.workspaceId = new mongoose.Types.ObjectId(workspaceId);
  }

  const notesWithRedemption = await CreditNote.find(query).session(session);

  let totalRestored = 0;
  let customerId = null;

  for (const cn of notesWithRedemption) {
    customerId = cn.customerId;
    const matchingRedemptions = cn.redemptions.filter(
      (r) => String(r.invoiceId) === String(invoiceId)
    );

    for (const r of matchingRedemptions) {
      const amt = Number(r.amount || 0);
      cn.redeemedAmount = Math.max(0, Math.round((Number(cn.redeemedAmount || 0) - amt) * 100) / 100);
      cn.balanceAmount = Math.round((Number(cn.balanceAmount || 0) + amt) * 100) / 100;
      totalRestored += amt;
    }

    // Remove the redemptions matching this invoice
    cn.redemptions = cn.redemptions.filter(
      (r) => String(r.invoiceId) !== String(invoiceId)
    );

    if (cn.redeemedAmount <= 0.001) {
      cn.status = CREDIT_NOTE_STATUS.ACTIVE;
    } else {
      cn.status = CREDIT_NOTE_STATUS.PARTIALLY_REDEEMED;
    }

    await cn.save({ session });
  }

  if (totalRestored > 0 && customerId) {
    await Customer.findByIdAndUpdate(
      customerId,
      { $inc: { creditNoteBalance: totalRestored } },
      { session }
    );
  }

  return { totalRestored };
};

/**
 * Cancel a Credit Note (only allowed if not yet redeemed)
 */
export const cancelCreditNote = async (
  creditNoteId,
  reason,
  user,
  companyId,
  workspaceId,
  options = {}
) => {
  const session = options.session || null;

  const creditNote = await CreditNote.findOne({
    _id: creditNoteId,
    companyId: new mongoose.Types.ObjectId(companyId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
  }).session(session);

  if (!creditNote) {
    throw new ApiError(404, "Credit Note not found");
  }

  if (creditNote.status === CREDIT_NOTE_STATUS.CANCELLED) {
    throw new ApiError(400, "Credit Note is already cancelled");
  }

  if (Number(creditNote.redeemedAmount || 0) > 0.001) {
    throw new ApiError(
      400,
      `Cannot cancel Credit Note ${creditNote.creditNoteNo} because ₹${creditNote.redeemedAmount.toFixed(
        2
      )} has already been redeemed.`
    );
  }

  const unredeemedBal = Number(creditNote.balanceAmount || creditNote.totalAmount || 0);

  creditNote.status = CREDIT_NOTE_STATUS.CANCELLED;
  creditNote.cancelledAt = new Date();
  creditNote.cancelledBy = user?._id || null;
  creditNote.cancelReason = reason;
  creditNote.balanceAmount = 0;

  await creditNote.save({ session });

  // Deduct remaining balance from customer aggregate
  if (unredeemedBal > 0) {
    await Customer.findByIdAndUpdate(
      creditNote.customerId,
      { $inc: { creditNoteBalance: -unredeemedBal } },
      { session }
    );
  }

  return creditNote;
};

/**
 * Get all credit notes with filters
 */
export const getCreditNotes = async (query = {}, options = {}) => {
  const { workspaceId, companyId, branchId, customerId, status, search, startDate, endDate, billingMode, partyType } = query;

  // Self-heal: ensure confirmed/dispatched PurchaseReturns with creditNoteNo exist in CreditNote collection
  try {
    const PurchaseReturnModel = mongoose.models.PurchaseReturn;
    if (PurchaseReturnModel && workspaceId && companyId) {
      const prsToSync = await PurchaseReturnModel.find({
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        companyId: new mongoose.Types.ObjectId(companyId),
        creditNoteNo: { $exists: true, $ne: "" },
        status: { $ne: "CANCELLED" },
        isDeleted: false,
      })
        .populate("supplierId", "businessName name contactPerson mobile phone gstNumber")
        .lean();

      for (const pr of prsToSync) {
        const supp = pr.supplierId || {};
        await CreditNote.findOneAndUpdate(
          {
            workspaceId: pr.workspaceId,
            companyId: pr.companyId,
            sourceReturnId: pr._id,
            source: CREDIT_NOTE_SOURCE.PURCHASE_RETURN,
          },
          {
            $set: {
              workspaceId: pr.workspaceId,
              companyId: pr.companyId,
              branchId: pr.branchId,
              creditNoteNo: pr.creditNoteNo,
              partyType: "SUPPLIER",
              customerId: null,
              supplierId: supp._id || pr.supplierId || null,
              supplierName: supp.businessName || supp.name || "Supplier",
              supplierPhone: supp.mobile || supp.phone || null,
              supplierGst: supp.gstNumber || null,
              billingMode: "B2B",
              source: CREDIT_NOTE_SOURCE.PURCHASE_RETURN,
              sourceReturnModel: "PurchaseReturn",
              sourceReturnId: pr._id,
              sourceReturnNo: pr.debitNoteNo || pr.returnNo,
              subtotal: pr.taxableSubtotal || 0,
              discount: 0,
              tax: pr.totalGst || 0,
              cgst: 0,
              sgst: 0,
              igst: 0,
              roundOff: pr.roundOff || 0,
              totalAmount: pr.grandTotal || 0,
              balanceAmount: pr.grandTotal || 0,
              status: CREDIT_NOTE_STATUS.ACTIVE,
              issueDate: pr.creditNoteDate || pr.shippingDetails?.dispatchedAt || pr.returnDate || new Date(),
              items: (pr.items || []).map((it) => ({
                productId: it.productId,
                productName: it.productName,
                pack: it.pack,
                batchNo: it.batchNo,
                batchNumber: it.batchNo,
                batch: it.batchNo,
                expiry: it.expiry || "",
                expiryDate: it.expiry || "",
                qty: it.returnQty,
                quantity: it.returnQty,
                rate: it.rate,
                unitPrice: it.rate,
                taxableAmount: it.taxableAmount,
                gstPct: it.gstPct,
                gstRate: it.gstPct,
                totalAmount: it.totalAmount,
                total: it.totalAmount,
              })),
              notes: `Purchase Return Credit Note for #${pr.debitNoteNo || pr.returnNo}`,
            },
            $setOnInsert: {
              redeemedAmount: 0,
            },
          },
          { upsert: true }
        );
      }
    }
  } catch (syncErr) {
    console.error("Self-healing sync for PurchaseReturn credit notes failed:", syncErr);
  }

  const mongoQuery = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    companyId: new mongoose.Types.ObjectId(companyId),
    isDeleted: false,
  };

  if (branchId) {
    mongoQuery.branchId = new mongoose.Types.ObjectId(branchId);
  }

  if (customerId) {
    mongoQuery.customerId = new mongoose.Types.ObjectId(customerId);
  }

  if (partyType && partyType !== "ALL") {
    mongoQuery.partyType = partyType;
  }

  if (status && status !== "ALL") {
    mongoQuery.status = status;
  }

  if (billingMode) {
    mongoQuery.billingMode = billingMode;
  }

  if (startDate || endDate) {
    mongoQuery.issueDate = {};
    if (startDate) {
      const s = new Date(startDate);
      s.setHours(0, 0, 0, 0);
      mongoQuery.issueDate.$gte = s;
    }
    if (endDate) {
      const e = new Date(endDate);
      e.setHours(23, 59, 59, 999);
      mongoQuery.issueDate.$lte = e;
    }
  }

  if (search) {
    const term = search.trim();
    mongoQuery.$or = [
      { creditNoteNo: { $regex: term, $options: "i" } },
      { customerName: { $regex: term, $options: "i" } },
      { customerPhone: { $regex: term, $options: "i" } },
      { supplierName: { $regex: term, $options: "i" } },
      { supplierPhone: { $regex: term, $options: "i" } },
      { sourceReturnNo: { $regex: term, $options: "i" } },
      { originalInvoiceNo: { $regex: term, $options: "i" } },
    ];
  }

  return creditNoteRepository.findCreditNotes(mongoQuery, options);
};

/**
 * Get active credit notes and total balance for a customer
 */
export const getCustomerCreditNotes = async (customerId, companyId, workspaceId) => {
  const customer = await Customer.findOne({
    _id: customerId,
    companyId,
    workspaceId,
    isDeleted: false,
  }).select("name mobile customerCode creditNoteBalance advanceBalance creditOutstanding");

  if (!customer) {
    throw new ApiError(404, "Customer not found");
  }

  const creditNotes = await CreditNote.find({
    customerId: customer._id,
    companyId,
    workspaceId,
    isDeleted: false,
  })
    .sort({ issueDate: -1, createdAt: -1 })
    .lean();

  const activeNotes = creditNotes.filter(
    (cn) =>
      (cn.status === CREDIT_NOTE_STATUS.ACTIVE || cn.status === CREDIT_NOTE_STATUS.PARTIALLY_REDEEMED) &&
      cn.balanceAmount > 0
  );

  const totalActiveBalance = activeNotes.reduce(
    (sum, cn) => sum + (Number(cn.balanceAmount) || 0),
    0
  );

  return {
    customer,
    creditNotes,
    activeNotes,
    totalActiveBalance: Math.round(totalActiveBalance * 100) / 100,
  };
};

/**
 * Get single Credit Note by ID or Number
 */
export const getCreditNoteById = async (idOrNo, companyId, workspaceId) => {
  const cn = await creditNoteRepository.findCreditNoteById(idOrNo, companyId, workspaceId);
  if (!cn) {
    throw new ApiError(404, "Credit Note not found");
  }

  // Convert to plain object if needed
  const cnObj = cn.toObject ? cn.toObject() : cn;

  // Enrich items with batch & expiry from source PurchaseReturn if missing
  if (cnObj.source === CREDIT_NOTE_SOURCE.PURCHASE_RETURN && cnObj.sourceReturnId) {
    try {
      const PurchaseReturnModel = mongoose.models.PurchaseReturn;
      if (PurchaseReturnModel) {
        const prId = cnObj.sourceReturnId._id || cnObj.sourceReturnId;
        const pr = await PurchaseReturnModel.findById(prId).lean();
        if (pr && Array.isArray(pr.items) && pr.items.length > 0) {
          const prItemsMap = new Map();
          pr.items.forEach((item) => {
            prItemsMap.set(String(item.productId), item);
          });

          cnObj.items = (cnObj.items || []).map((it, idx) => {
            const matchedPrItem = prItemsMap.get(String(it.productId)) || pr.items[idx] || pr.items[0];
            return {
              ...it,
              batchNo: it.batchNo || matchedPrItem?.batchNo || "",
              batchNumber: it.batchNumber || it.batchNo || matchedPrItem?.batchNo || "",
              batch: it.batch || it.batchNo || matchedPrItem?.batchNo || "",
              expiry: it.expiry || matchedPrItem?.expiry || "",
              expiryDate: it.expiryDate || it.expiry || matchedPrItem?.expiry || "",
            };
          });
        }
      }
    } catch (enrichErr) {
      console.warn("Could not enrich credit note items from PurchaseReturn:", enrichErr);
    }
  }

  return cnObj;
};

/**
 * Summary stats for credit notes dashboard
 */
export const getCreditNoteSummaryStats = async (companyId, workspaceId, branchId = null) => {
  const match = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    companyId: new mongoose.Types.ObjectId(companyId),
    isDeleted: false,
  };

  if (branchId) {
    match.branchId = new mongoose.Types.ObjectId(branchId);
  }

  const [stats] = await CreditNote.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalIssuedCount: { $sum: 1 },
        totalIssuedAmount: { $sum: "$totalAmount" },
        totalRedeemedAmount: { $sum: "$redeemedAmount" },
        totalActiveBalance: {
          $sum: {
            $cond: [
              { $in: ["$status", [CREDIT_NOTE_STATUS.ACTIVE, CREDIT_NOTE_STATUS.PARTIALLY_REDEEMED]] },
              "$balanceAmount",
              0,
            ],
          },
        },
        activeCount: {
          $sum: {
            $cond: [
              { $in: ["$status", [CREDIT_NOTE_STATUS.ACTIVE, CREDIT_NOTE_STATUS.PARTIALLY_REDEEMED]] },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  return {
    totalIssuedCount: stats?.totalIssuedCount || 0,
    totalIssuedAmount: Math.round((stats?.totalIssuedAmount || 0) * 100) / 100,
    totalRedeemedAmount: Math.round((stats?.totalRedeemedAmount || 0) * 100) / 100,
    totalActiveBalance: Math.round((stats?.totalActiveBalance || 0) * 100) / 100,
    activeCount: stats?.activeCount || 0,
  };
};

export default {
  issueCreditNote,
  redeemCreditNotesForInvoice,
  revertInvoiceCreditNotes,
  cancelCreditNote,
  getCreditNotes,
  getCustomerCreditNotes,
  getCreditNoteById,
  getCreditNoteSummaryStats,
};

