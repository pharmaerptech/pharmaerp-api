import mongoose from "mongoose";
import ApiError from "../../../../utils/ApiError.js";
import invoiceRepository from "../../invoices/repositories/invoice.repository.js";
import salesReturnRepository from "../repositories/salesReturn.repository.js";
import SalesReturn from "../models/salesReturn.model.js";
import { getBranchInitials } from "../../../../utils/branchInitials.js";
import customerRepository from "../../../parties/customers/repositories/customer.repository.js";
import branchRepository from "../../../organization/branches/repositories/branch.repository.js";
import financialPeriodRepository from "../../../finance/financial-periods/repositories/financialPeriod.repository.js";
import Batch from "../../../catalog/products/models/batch.model.js";
import ProductFacility from "../../../catalog/products/models/productFacility.model.js";
import WorkspaceProduct from "../../../catalog/products/models/workspaceProduct.model.js";
import gstLedgerRepository from "../../../finance/gst-ledger/repositories/gstLedger.repository.js";
import Company from "../../../organization/companies/models/company.model.js";
import SalesInvoice from "../../invoices/models/invoice.model.js";
import creditNoteService from "../../credit-notes/services/creditNote.service.js";
import Customer from "../../../parties/customers/models/customer.model.js";
import CustomerAdvanceTransaction from "../../../parties/customers/models/customerAdvanceTransaction.model.js";
import CustomerCreditTransaction from "../../../parties/customers/models/customerCreditTransaction.model.js";
import { CUSTOMER_TRANSACTION_TYPE } from "../../../parties/customers/constants/customer.constant.js";
import { Shift } from "../../../operations/shifts/shift.model.js";
import BusinessDay from "../../../operations/business-days/businessDay.model.js";
import branchCashRepository from "../../../finance/treasury/cash-management/branch-cash/repositories/branchCash.repository.js";
import cashTransactionService from "../../../finance/treasury/cash-management/cash-transactions/services/cashTransaction.service.js";
import Branch from "../../../organization/branches/models/branch.model.js";
import { decomposeCashAmount } from "../../../parties/customers/services/customerAdvance.service.js";
import PurchaseReturn from "../../../catalog/purchase-returns/models/purchaseReturn.model.js";

/**
 * Restock inventory for returned items (increment Batch & ProductFacility quantities)
 * For general returns: increments sellable stock (batchQty, total_qty_available, qoh, atp).
 * For scrap/broken/expired returns: increments quarantine scrap bin stock (scrapQty, brokenQty, expiredQty) in the branch.
 */
const restockReturnInventory = async (items, branchId, workspaceId, session, isScrap = false) => {
  if (!Array.isArray(items) || items.length === 0) return;

  const branchObjId =
    branchId && mongoose.Types.ObjectId.isValid(branchId)
      ? new mongoose.Types.ObjectId(branchId)
      : null;

  const workspaceObjId =
    workspaceId && mongoose.Types.ObjectId.isValid(workspaceId)
      ? new mongoose.Types.ObjectId(workspaceId)
      : null;

  for (const item of items) {
    const qtyToRestock = Number(item.qty || item.returnQty || 0) + Number(item.freeQty || 0);
    if (qtyToRestock <= 0) continue;

    const itemMotive = (item.motive || "").toLowerCase();
    const isScrapItem = isScrap || itemMotive === "expired" || itemMotive === "broken";

    // 1. Resolve product ID (handle string, object, composite "<id>-<batch>", or lookup by name)
    let rawProductId =
      item.productId ||
      item.product_id ||
      item.workspaceProductId ||
      (item.workspaceProduct && (item.workspaceProduct._id || item.workspaceProduct.id)) ||
      item.id;

    if (rawProductId && typeof rawProductId === "object") {
      rawProductId = rawProductId._id || rawProductId.id;
    }

    if (typeof rawProductId === "string") {
      rawProductId = rawProductId.trim();
      if (!mongoose.Types.ObjectId.isValid(rawProductId) && rawProductId.includes("-")) {
        const candidateId = rawProductId.split("-")[0];
        if (mongoose.Types.ObjectId.isValid(candidateId)) {
          rawProductId = candidateId;
        }
      }
    }

    let productObjId =
      rawProductId && mongoose.Types.ObjectId.isValid(rawProductId)
        ? new mongoose.Types.ObjectId(rawProductId)
        : null;

    // If productObjId was not valid, try finding by item name in this workspace
    if (!productObjId && workspaceObjId && (item.name || item.productName)) {
      const searchName = (item.name || item.productName || "").trim();
      if (searchName) {
        try {
          const escaped = searchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const foundProduct = await WorkspaceProduct.findOne({
            workspaceId: workspaceObjId,
            $or: [
              { name: { $regex: new RegExp(`^${escaped}$`, "i") } },
              { displayName: { $regex: new RegExp(`^${escaped}$`, "i") } },
              { workspaceProductCode: searchName.toUpperCase() },
            ],
            isDeleted: false,
          }).session(session);

          if (foundProduct) {
            productObjId = foundProduct._id;
          }
        } catch (err) {
          console.warn("restockReturnInventory: Error finding product by name:", err.message);
        }
      }
    }

    if (!productObjId) {
      console.warn("restockReturnInventory: Could not resolve valid product ID for item:", item.name || item);
      continue;
    }

    // Target branch: the explicitly provided branchId (current store branch) takes strict precedence
    const targetBranchId =
      branchObjId ||
      (item.branchId && mongoose.Types.ObjectId.isValid(item.branchId)
        ? new mongoose.Types.ObjectId(item.branchId)
        : null);

    // 2. Resolve batch information
    let rawBatchId =
      item.batchId ||
      item.batch_id ||
      (item.batch && typeof item.batch === "object" && (item.batch._id || item.batch.id)) ||
      (typeof item.batch === "string" && mongoose.Types.ObjectId.isValid(item.batch)
        ? item.batch
        : null);

    if (rawBatchId && typeof rawBatchId === "object") {
      rawBatchId = rawBatchId._id || rawBatchId.id;
    }

    const rawInputBatchNo = (
      item.batchNo ||
      item.batchNumber ||
      (typeof item.batch === "string" ? item.batch : (item.batch && (item.batch.batchNo || item.batch.batch))) ||
      "STANDARD"
    ).trim();

    // Clean base batch number from any existing tag
    const baseBatchNo =
      rawInputBatchNo.replace(/\s*\[(EXPIRED|BROKEN|SCRAP)\]/gi, "").trim() || "STANDARD";

    let targetBatchNo = baseBatchNo;
    let targetScrapType = "NONE";

    if (isScrapItem) {
      if (itemMotive === "broken") {
        targetScrapType = "BROKEN";
        targetBatchNo = `${baseBatchNo} [BROKEN]`;
      } else {
        targetScrapType = "EXPIRED";
        targetBatchNo = `${baseBatchNo} [EXPIRED]`;
      }
    }

    const expiryDate = (item.expiry || item.expiryDate || "").trim();

    // 3. Locate source batch (if any) to obtain master rates/mrp/expiry
    let sourceBatch = null;
    if (rawBatchId && mongoose.Types.ObjectId.isValid(rawBatchId)) {
      sourceBatch = await Batch.findById(rawBatchId).session(session);
    }
    if (!sourceBatch && workspaceObjId) {
      sourceBatch = await Batch.findOne({
        workspaceId: workspaceObjId,
        product: productObjId,
        batchNo: { $in: [baseBatchNo, rawInputBatchNo] },
        isDeleted: false,
      }).session(session);
    }
    if (!sourceBatch && workspaceObjId) {
      sourceBatch = await Batch.findOne({
        workspaceId: workspaceObjId,
        product: productObjId,
        isDeleted: false,
      }).session(session);
    }

    // 4. Find or Create Batch specifically in targetBranchId
    let targetBatch = null;

    if (targetBranchId && workspaceObjId) {
      if (isScrapItem) {
        // Look specifically for an existing scrap batch of this exact type (BROKEN or EXPIRED) in this branch
        targetBatch = await Batch.findOne({
          workspaceId: workspaceObjId,
          branch_id: targetBranchId,
          product: productObjId,
          batchNo: targetBatchNo,
        }).session(session);

        if (!targetBatch) {
          targetBatch = await Batch.findOne({
            workspaceId: workspaceObjId,
            branch_id: targetBranchId,
            product: productObjId,
            originalBatchNo: baseBatchNo,
            scrapType: targetScrapType,
          }).session(session);
        }
      } else {
        // Resellable / general return: strictly target sellable shelf batch (scrapType: NONE or null)
        if (expiryDate) {
          targetBatch = await Batch.findOne({
            workspaceId: workspaceObjId,
            branch_id: targetBranchId,
            product: productObjId,
            batchNo: baseBatchNo,
            expiryDate,
            scrapType: { $in: ["NONE", null] },
          }).session(session);
        }

        if (!targetBatch) {
          targetBatch = await Batch.findOne({
            workspaceId: workspaceObjId,
            branch_id: targetBranchId,
            product: productObjId,
            batchNo: baseBatchNo,
            scrapType: { $in: ["NONE", null] },
          }).session(session);
        }
      }
    }

    // Case 4c: Global batch (no branch_id) when targetBranchId is not specified
    if (!targetBatch && !targetBranchId && sourceBatch) {
      targetBatch = sourceBatch;
    }

    // 5. Update Existing Batch or Create Brand New Batch in targetBranchId
    if (targetBatch) {
      if (isScrapItem) {
        targetBatch.scrapQty = (Number(targetBatch.scrapQty) || 0) + qtyToRestock;
        if (targetScrapType === "BROKEN") {
          targetBatch.brokenQty = (Number(targetBatch.brokenQty) || 0) + qtyToRestock;
        } else {
          targetBatch.expiredQty = (Number(targetBatch.expiredQty) || 0) + qtyToRestock;
        }
        targetBatch.scrapType = targetScrapType;
        targetBatch.originalBatchNo = baseBatchNo;
      } else {
        targetBatch.batchQty = (Number(targetBatch.batchQty) || 0) + qtyToRestock;
      }
      targetBatch.isDeleted = false;
      if (!targetBatch.expiryDate && (expiryDate || sourceBatch?.expiryDate)) {
        targetBatch.expiryDate = expiryDate || sourceBatch?.expiryDate || "";
      }
      await targetBatch.save({ session });
    } else if (workspaceObjId && targetBranchId) {
      // Create a brand new batch document in the branch
      const resolvedMrp = Number(item.mrp || sourceBatch?.mrp || sourceBatch?.MRP || 0);
      const resolvedRate = Number(item.rate || item.price || sourceBatch?.rate || 0);
      const resolvedRateA = Number(item.rateA || sourceBatch?.rateA || sourceBatch?.finalRateA || resolvedRate);
      const resolvedRateB = Number(item.rateB || item.rateb || sourceBatch?.rateB || sourceBatch?.finalRateB || resolvedRate);
      const resolvedRateC = Number(item.rateC || sourceBatch?.rateC || sourceBatch?.finalRateC || resolvedRate);
      const resolvedExpiry = expiryDate || sourceBatch?.expiryDate || "";

      try {
        const createdBatches = await Batch.create(
          [
            {
              workspaceId: workspaceObjId,
              branch_id: targetBranchId,
              product: productObjId,
              batchNo: targetBatchNo,
              originalBatchNo: baseBatchNo,
              scrapType: targetScrapType,
              batchQty: isScrapItem ? 0 : qtyToRestock,
              scrapQty: isScrapItem ? qtyToRestock : 0,
              brokenQty: targetScrapType === "BROKEN" ? qtyToRestock : 0,
              expiredQty: targetScrapType === "EXPIRED" ? qtyToRestock : 0,
              mrp: resolvedMrp,
              MRP: resolvedMrp,
              rate: resolvedRate,
              ptr: Number(sourceBatch?.ptr || 0),
              pts: Number(sourceBatch?.pts || 0),
              rateA: resolvedRateA,
              rateB: resolvedRateB,
              rateC: resolvedRateC,
              finalRateA: resolvedRateA,
              finalRateB: resolvedRateB,
              finalRateC: resolvedRateC,
              expiryDate: resolvedExpiry,
              pack: item.pack || sourceBatch?.pack || "PCS",
              rack: item.rack || sourceBatch?.rack || "",
              isDeleted: false,
            },
          ],
          { session }
        );
        targetBatch = createdBatches[0];
      } catch (err) {
        if (err.code === 11000) {
          // If collision occurred, retrieve the existing batch of this exact targetBatchNo and increment it
          targetBatch = await Batch.findOne({
            workspaceId: workspaceObjId,
            branch_id: targetBranchId,
            product: productObjId,
            batchNo: targetBatchNo,
          }).session(session);

          if (targetBatch) {
            if (isScrapItem) {
              targetBatch.scrapQty = (Number(targetBatch.scrapQty) || 0) + qtyToRestock;
              if (targetScrapType === "BROKEN") {
                targetBatch.brokenQty = (Number(targetBatch.brokenQty) || 0) + qtyToRestock;
              } else {
                targetBatch.expiredQty = (Number(targetBatch.expiredQty) || 0) + qtyToRestock;
              }
              targetBatch.scrapType = targetScrapType;
              targetBatch.originalBatchNo = baseBatchNo;
            } else {
              targetBatch.batchQty = (Number(targetBatch.batchQty) || 0) + qtyToRestock;
            }
            targetBatch.isDeleted = false;
            await targetBatch.save({ session });
          }
        } else {
          console.error("restockReturnInventory: Error creating new batch:", err);
        }
      }
    }

    // 6. Atomically Upsert and Increment ProductFacility in targetBranchId
    if (targetBranchId && workspaceObjId) {
      try {
        if (isScrapItem) {
          await ProductFacility.findOneAndUpdate(
            {
              workspaceId: workspaceObjId,
              facility_id: targetBranchId,
              product_id: productObjId,
            },
            {
              $inc: {
                scrapQty: qtyToRestock,
                ...(targetScrapType === "BROKEN"
                  ? { brokenQty: qtyToRestock }
                  : { expiredQty: qtyToRestock }),
              },
              $setOnInsert: {
                itemCode: item.productCode || item.itemCode || "",
                total_qty_available: 0,
                qoh: 0,
                atp: 0,
                consumption: 0,
                poStatus: "NONE",
                isDeleted: false,
              },
            },
            {
              upsert: true,
              new: true,
              session,
            }
          );
        } else {
          await ProductFacility.findOneAndUpdate(
            {
              workspaceId: workspaceObjId,
              facility_id: targetBranchId,
              product_id: productObjId,
            },
            {
              $inc: {
                total_qty_available: qtyToRestock,
                qoh: qtyToRestock,
                atp: qtyToRestock,
              },
              $setOnInsert: {
                itemCode: item.productCode || item.itemCode || "",
                consumption: 0,
                poStatus: "NONE",
                isDeleted: false,
              },
            },
            {
              upsert: true,
              new: true,
              session,
            }
          );
        }
      } catch (facErr) {
        console.error("restockReturnInventory: Error updating ProductFacility:", facErr);
      }
    }
  }
};

/**
 * Record a sales return / refund bill
 */
const recordCustomerReturn = async (
  customerId,
  returnData,
  companyId,
  workspaceId,
  user = null,
  existingSession = null
) => {
  const session = existingSession || (await mongoose.startSession());
  if (!existingSession && !session.inTransaction()) session.startTransaction();

  try {
    // 1. Fetch customer and reference data
    const [customer, activeBranches, periods, company] = await Promise.all([
      (customerId
        ? customerRepository.findCustomerById(customerId, companyId, workspaceId)
        : customerRepository.findWalkInCustomer(companyId, workspaceId)),
      branchRepository.getCompanyBranches(companyId),
      financialPeriodRepository.getPeriods(workspaceId, companyId, { isCurrent: true, all: true }),
      Company.findOne({ _id: companyId, workspaceId }),
    ]);

    if (!customer) {
      throw new ApiError(404, "Customer not found for sales return");
    }

    // 2. Resolve branch and branch initials
    let resolvedBranchId = returnData.branchId || null;
    let targetBranch = null;

    if (Array.isArray(activeBranches) && activeBranches.length > 0) {
      if (resolvedBranchId) {
        targetBranch =
          activeBranches.find(
            (b) => b._id && b._id.toString() === resolvedBranchId.toString()
          ) || null;
      }
      if (!targetBranch) {
        targetBranch = activeBranches[0];
        resolvedBranchId = targetBranch._id;
      }
    }

    const branchInitials = getBranchInitials(targetBranch);

    // 3. Resolve Financial Year & Return Memo prefix
    const returnDateObj = returnData.date ? new Date(returnData.date) : new Date();
    let fyString = "";
    const month = returnDateObj.getMonth();
    const year = returnDateObj.getFullYear();
    if (month >= 3) {
      fyString = `${year.toString().slice(-2)}${(year + 1).toString().slice(-2)}`;
    } else {
      fyString = `${(year - 1).toString().slice(-2)}${year.toString().slice(-2)}`;
    }

    let period = periods?.periods?.[0];
    const financialPeriodId = period ? period._id : null;
    if (period && period.startDate && period.endDate) {
      const startYear = new Date(period.startDate).getFullYear();
      const endYear = new Date(period.endDate).getFullYear();
      fyString = `${startYear.toString().slice(-2)}${endYear.toString().slice(-2)}`;
    }

    const finalReturnPrefix = `RET-${branchInitials}-${fyString}-`;

    // 4. Generate sequential return memo number
    let finalReturnNo = returnData.invoiceNo || returnData.returnNo || null;
    let sequenceNo = 1;

    if (!finalReturnNo || !finalReturnNo.startsWith(finalReturnPrefix)) {
      const lastReturnDoc = await SalesReturn.findOne({
        companyId: new mongoose.Types.ObjectId(companyId),
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        ...(resolvedBranchId ? { branchId: new mongoose.Types.ObjectId(resolvedBranchId) } : {}),
        $or: [
          { returnNo: { $regex: `^${finalReturnPrefix}` } },
          { invoiceNo: { $regex: `^${finalReturnPrefix}` } },
        ],
      })
        .sort({ date: -1, createdAt: -1 })
        .session(session);

      const lastRetNum = lastReturnDoc?.returnNo || lastReturnDoc?.invoiceNo;
      if (lastRetNum && lastRetNum.startsWith(finalReturnPrefix)) {
        const parts = lastRetNum.split("-");
        if (parts.length >= 4) {
          const lastSeq = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(lastSeq)) sequenceNo = lastSeq + 1;
        }
      } else {
        const lastReturn = await invoiceRepository.getLatestInvoiceByPrefix(
          companyId,
          workspaceId,
          finalReturnPrefix,
          resolvedBranchId
        );
        if (lastReturn && lastReturn.invoiceNo && lastReturn.invoiceNo.startsWith(finalReturnPrefix)) {
          const parts = lastReturn.invoiceNo.split("-");
          if (parts.length >= 4) {
            const lastSeq = parseInt(parts[parts.length - 1], 10);
            if (!isNaN(lastSeq)) sequenceNo = lastSeq + 1;
          }
        }
      }

      finalReturnNo = `${finalReturnPrefix}${sequenceNo.toString().padStart(4, "0")}`;
    } else {
      const parts = finalReturnNo.split("-");
      if (parts.length >= 4) {
        const parsed = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(parsed)) sequenceNo = parsed;
      }
    }

    let candidateSeq = sequenceNo;
    let collision = await SalesReturn.findOne({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      $or: [{ returnNo: finalReturnNo }, { invoiceNo: finalReturnNo }],
    }).session(session);

    while (collision) {
      candidateSeq += 1;
      finalReturnNo = `${finalReturnPrefix}${candidateSeq.toString().padStart(4, "0")}`;
      collision = await SalesReturn.findOne({
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        $or: [{ returnNo: finalReturnNo }, { invoiceNo: finalReturnNo }],
      }).session(session);
    }

    // 5. Shift and Business Day Gatekeeper Resolution
    let resolvedShiftId = returnData.shiftId || null;
    let resolvedBusinessDayId = null;

    if (resolvedBranchId) {
      const [activeBusinessDay, candidateShift] = await Promise.all([
        BusinessDay.findOne({
          branchId: resolvedBranchId,
          status: { $in: ["open", "closing"] },
        }),
        resolvedShiftId
          ? Shift.findById(resolvedShiftId)
          : Shift.findOne({
              branchId: resolvedBranchId,
              status: { $in: ["open", "closing"] },
            }),
      ]);

      const isDayClosed = !activeBusinessDay || activeBusinessDay.status === "closed";
      const isDayClosing = activeBusinessDay && activeBusinessDay.status === "closing";
      const isShiftClosed = !candidateShift || candidateShift.status === "closed";
      const isShiftClosing = candidateShift && candidateShift.status === "closing";

      if (isDayClosing) {
        const err = new ApiError(
          409,
          "Cannot process return. Business Day closing has been initiated on another device. Returns are locked."
        );
        err.code = "BUSINESS_DAY_CLOSING_IN_PROGRESS";
        throw err;
      }

      if (isShiftClosing) {
        const err = new ApiError(
          409,
          "Cannot process return. Shift closing has been initiated on another device. Returns are locked."
        );
        err.code = "SHIFT_CLOSING_IN_PROGRESS";
        throw err;
      }

      if (isDayClosed && isShiftClosed) {
        throw new ApiError(
          400,
          "Cannot process return. The shift is closed, the business day is closed. Please open a business day and shift before processing returns."
        );
      }

      if (isDayClosed) {
        throw new ApiError(
          400,
          "Cannot process return. The Business Day is closed for this branch. Please open a Business Day before processing returns."
        );
      }

      if (isShiftClosed || candidateShift.status !== "open") {
        throw new ApiError(
          400,
          "Cannot process return. The shift is closed. Please open a new shift before processing returns."
        );
      }

      resolvedBusinessDayId = activeBusinessDay._id;
      resolvedShiftId = candidateShift._id;
    }

    const grandTotal = Number(returnData.grandTotal || 0);
    const rawReturnType = String(returnData.returnType || "").toLowerCase();
    const primaryPayMethod = String(returnData.payments?.[0]?.paymentType || returnData.paymentMethod || "").toLowerCase();
    const isAdvance =
      rawReturnType === "advance" ||
      rawReturnType === "advance_credit" ||
      primaryPayMethod === "advance";
    const isCredit =
      rawReturnType === "credit" ||
      rawReturnType === "credit_note" ||
      primaryPayMethod === "credit";
    const returnType = isAdvance
      ? "advance_credit"
      : isCredit
      ? "credit_note"
      : "cash_refund";

    if (customer.isWalkIn) {
      if (isAdvance || isCredit || returnType !== "cash_refund") {
        throw new ApiError(
          400,
          "Credit Note or Advance cannot be issued to anonymous Walk-in Customer. Please register the customer with a name and phone number to issue a Credit Note."
        );
      }
    }

    // Extract cash denominations (notes dispensed to customer, or change received)
    const rawPayments = Array.isArray(returnData.payments) ? returnData.payments : [];
    let dispensedDenoms = Array.isArray(returnData.denominations) && returnData.denominations.length > 0
      ? returnData.denominations
      : (Array.isArray(rawPayments[0]?.denominations) && rawPayments[0].denominations.length > 0
          ? rawPayments[0].denominations
          : []);

    let changeDenoms = Array.isArray(returnData.returnedDenominations) && returnData.returnedDenominations.length > 0
      ? returnData.returnedDenominations
      : (Array.isArray(rawPayments[0]?.returnedDenominations) && rawPayments[0].returnedDenominations.length > 0
          ? rawPayments[0].returnedDenominations
          : []);

    if (returnType === "cash_refund" && dispensedDenoms.length === 0 && grandTotal > 0) {
      dispensedDenoms = decomposeCashAmount(grandTotal);
    }

    // Resolve originalInvoiceNo and originalInvoiceId from items if not provided or self-referential
    let resolvedOriginalInvoiceNo = returnData.originalInvoiceNo || returnData.originalInvoice || null;
    let resolvedOriginalInvoiceId = returnData.originalInvoiceId || null;

    if (
      (!resolvedOriginalInvoiceNo ||
        resolvedOriginalInvoiceNo === finalReturnNo ||
        resolvedOriginalInvoiceNo.startsWith("RET-")) &&
      Array.isArray(returnData.items) &&
      returnData.items.length > 0
    ) {
      const itWithOrig = returnData.items.find(
        (it) => it.originalInvoiceNo && !it.originalInvoiceNo.startsWith("RET-")
      );
      if (itWithOrig) {
        resolvedOriginalInvoiceNo = itWithOrig.originalInvoiceNo;
        if (!resolvedOriginalInvoiceId && itWithOrig.originalInvoiceId) {
          resolvedOriginalInvoiceId = itWithOrig.originalInvoiceId;
        }
      }
    }

    // 5b. Find Original Invoice and Validate Against Double / Over-Return
    // 5b. Find Original Invoices and Validate Against Double / Over-Return
    const involvedInvoiceIds = new Set();
    if (resolvedOriginalInvoiceId && mongoose.Types.ObjectId.isValid(resolvedOriginalInvoiceId)) {
      involvedInvoiceIds.add(resolvedOriginalInvoiceId.toString());
    }
    if (Array.isArray(returnData.items)) {
      for (const it of returnData.items) {
        if (it.originalInvoiceId && mongoose.Types.ObjectId.isValid(it.originalInvoiceId)) {
          involvedInvoiceIds.add(it.originalInvoiceId.toString());
        }
      }
    }

    const originalInvoicesMap = new Map();
    const invFindQuery = {
      workspaceId: workspaceId || customer.workspaceId,
      companyId: companyId || customer.companyId,
      isDeleted: false,
    };

    if (involvedInvoiceIds.size > 0) {
      const invDocs = await SalesInvoice.find({
        ...invFindQuery,
        _id: { $in: Array.from(involvedInvoiceIds).map((id) => new mongoose.Types.ObjectId(id)) },
      }).session(session);

      for (const doc of invDocs) {
        originalInvoicesMap.set(doc._id.toString(), doc);
        if (doc.invoiceNo) {
          originalInvoicesMap.set(doc.invoiceNo, doc);
        }
      }
    }

    if (originalInvoicesMap.size === 0 && resolvedOriginalInvoiceNo) {
      const doc = await SalesInvoice.findOne({
        ...invFindQuery,
        invoiceNo: resolvedOriginalInvoiceNo,
      }).session(session);
      if (doc) {
        originalInvoicesMap.set(doc._id.toString(), doc);
        originalInvoicesMap.set(doc.invoiceNo, doc);
      }
    }

    let originalInvoiceDoc =
      (resolvedOriginalInvoiceId && originalInvoicesMap.get(resolvedOriginalInvoiceId.toString())) ||
      (resolvedOriginalInvoiceNo && originalInvoicesMap.get(resolvedOriginalInvoiceNo)) ||
      (originalInvoicesMap.size > 0 ? Array.from(originalInvoicesMap.values())[0] : null);

    if (originalInvoiceDoc) {
      resolvedOriginalInvoiceId = originalInvoiceDoc._id;
      resolvedOriginalInvoiceNo = originalInvoiceDoc.invoiceNo;
    }

    // Validate items against their corresponding original bills
    if (Array.isArray(returnData.items)) {
      for (const retItem of returnData.items) {
        const reqQty = Number(retItem.qty ?? retItem.quantity ?? retItem.returnQty ?? 0);
        if (reqQty <= 0) continue;

        const targetBill =
          (retItem.originalInvoiceId && originalInvoicesMap.get(retItem.originalInvoiceId.toString())) ||
          (retItem.originalInvoiceNo && originalInvoicesMap.get(retItem.originalInvoiceNo)) ||
          originalInvoiceDoc;

        if (targetBill && Array.isArray(targetBill.items)) {
          const matchedItem =
            targetBill.items.find((origIt) => {
              const matchById =
                origIt.productId &&
                retItem.productId &&
                origIt.productId.toString() === retItem.productId.toString();
              const matchByName =
                origIt.name &&
                retItem.name &&
                origIt.name.trim().toLowerCase() === retItem.name.trim().toLowerCase();
              const matchBatch =
                !origIt.batch || !retItem.batchNo || origIt.batch === retItem.batchNo;
              return (matchById || matchByName) && matchBatch;
            }) ||
            targetBill.items.find((origIt) => {
              return (
                (origIt.productId &&
                  retItem.productId &&
                  origIt.productId.toString() === retItem.productId.toString()) ||
                (origIt.name &&
                  retItem.name &&
                  origIt.name.trim().toLowerCase() === retItem.name.trim().toLowerCase())
              );
            });

          if (matchedItem) {
            const soldQty = Number(matchedItem.qty || 1);
            const alreadyReturnedQty = Number(matchedItem.returnedQty || 0);
            const availableQty = Math.max(0, soldQty - alreadyReturnedQty);

            if (availableQty <= 0) {
              throw new ApiError(
                400,
                `Cannot return item "${matchedItem.name || retItem.name}". All ${soldQty} units from bill #${targetBill.invoiceNo} have already been returned.`
              );
            }

            if (reqQty > availableQty) {
              throw new ApiError(
                400,
                `Cannot return ${reqQty} units of "${matchedItem.name || retItem.name}". Only ${availableQty} units remain available to return (Sold: ${soldQty}, Already Returned: ${alreadyReturnedQty}).`
              );
            }
          }
        }
      }
    }

    // 6. Build and save Sales Return Document in dedicated collection
    const customerGstinEarly = (customer?.gstNumber || customer?.gstin || returnData.customerGstin || "").trim().toUpperCase();
    const customerHasValidGstEarly = customerGstinEarly.length >= 15 && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(customerGstinEarly);
    let resolvedReturnBillingMode = returnData.billingMode || "B2C";
    if (String(resolvedReturnBillingMode).toUpperCase() === "B2B" && !customerHasValidGstEarly) {
      resolvedReturnBillingMode = "B2C";
    }

    const newReturnBill = {
      workspaceId: workspaceId || customer.workspaceId,
      companyId: companyId || customer.companyId,
      branchId: resolvedBranchId,
      customerId: customer._id,
      customerName: customer?.name || returnData.customerName || null,
      customerPhone: customer?.mobile || customer?.phone || returnData.customerPhone || null,
      returnNo: finalReturnNo,
      invoiceNo: finalReturnNo,
      date: returnData.date || new Date(),
      financialPeriodId,
      shiftId: resolvedShiftId || null,
      businessDayId: resolvedBusinessDayId || null,
      billingMode: resolvedReturnBillingMode,
      subtotal: returnData.subtotal || 0,
      discount: returnData.discount || 0,
      tax: returnData.tax || 0,
      roundOff: returnData.roundOff || 0,
      grandTotal,
      returnAmount: grandTotal,
      cashTendered: dispensedDenoms.reduce((s, d) => s + (Number(d.denomination) * Number(d.quantity)), 0) || grandTotal,
      changeDue: changeDenoms.reduce((s, d) => s + (Number(d.denomination) * Number(d.quantity)), 0) || 0,
      paymentMethod: returnData.paymentMethod || (returnType === "advance_credit" ? "Advance" : (returnType === "credit_note" ? "Credit" : "Cash")),
      refundMethod: returnData.paymentMethod || (returnType === "advance_credit" ? "Advance" : (returnType === "credit_note" ? "Credit" : "Cash")),
      paymentQrId: returnData.paymentQrId || null,
      payments: rawPayments.length > 0 ? rawPayments : [
        {
          paymentType: returnType === "advance_credit" ? "Advance" : (returnType === "credit_note" ? "Credit" : "Cash"),
          amount: grandTotal,
          denominations: dispensedDenoms,
          returnedDenominations: changeDenoms,
        }
      ],
      refundDenominations: dispensedDenoms,
      denominations: dispensedDenoms,
      returnedDenominations: changeDenoms,
      status: "Completed",
      creditDueDate: null,
      creditStatus: "NA",
      creditPaidAmount: 0,
      creditTransactionId: null,
      items: Array.isArray(returnData.items) ? returnData.items : [],
      doctor: returnData.doctor || null,
      doctorId: returnData.doctorId || null,
      notes: returnData.notes && !returnData.notes.includes(finalReturnNo)
        ? returnData.notes
        : `Sales return memo against invoice ${resolvedOriginalInvoiceNo || "original sale"}`,
      isReturn: true,
      returnType,
      returnMotive: returnData.returnMotive || "general",
      originalInvoiceId: resolvedOriginalInvoiceId,
      originalInvoiceNo: resolvedOriginalInvoiceNo,
      createdBy: user?._id || null,
      createdByName: user?.name || null,
      createdByEmail: user?.email || null,
    };

    const savedReturn = await salesReturnRepository.createSalesReturn(newReturnBill, { session });

    // 6b. Update all involved Original Sale Bills with Return IDs & Returned Item Quantities
    const distinctBillsToUpdate = Array.from(new Set(Array.from(originalInvoicesMap.values())));
    for (const billDoc of distinctBillsToUpdate) {
      const billIdStr = billDoc._id.toString();
      const billNoStr = billDoc.invoiceNo;

      // Filter return items that belong to this bill
      const itemsForThisBill = (newReturnBill.items || []).filter((rIt) => {
        if (rIt.originalInvoiceId) {
          return rIt.originalInvoiceId.toString() === billIdStr;
        }
        if (rIt.originalInvoiceNo) {
          return rIt.originalInvoiceNo === billNoStr;
        }
        return distinctBillsToUpdate.length === 1;
      });

      if (itemsForThisBill.length === 0) continue;

      let billRefundAmount = 0;

      if (Array.isArray(billDoc.items)) {
        billDoc.items = billDoc.items.map((origIt) => {
          let updatedReturnedQty = Number(origIt.returnedQty || 0);
          const retItem =
            itemsForThisBill.find((rIt) => {
              const matchById =
                origIt.productId &&
                rIt.productId &&
                origIt.productId.toString() === rIt.productId.toString();
              const matchByName =
                origIt.name &&
                rIt.name &&
                origIt.name.trim().toLowerCase() === rIt.name.trim().toLowerCase();
              const matchBatch =
                !origIt.batch || !rIt.batchNo || origIt.batch === rIt.batchNo;
              return (matchById || matchByName) && matchBatch;
            }) ||
            itemsForThisBill.find((rIt) => {
              return (
                (origIt.productId &&
                  rIt.productId &&
                  origIt.productId.toString() === rIt.productId.toString()) ||
                (origIt.name &&
                  rIt.name &&
                  origIt.name.trim().toLowerCase() === rIt.name.trim().toLowerCase())
              );
            });

          if (retItem) {
            const addedQty = Number(retItem.qty ?? retItem.quantity ?? retItem.returnQty ?? 0);
            updatedReturnedQty += addedQty;
            billRefundAmount += addedQty * Number(retItem.price || retItem.rate || origIt.rate || 0);
          }

          const soldQty = Number(origIt.qty || 1);
          const isReturned = updatedReturnedQty >= soldQty;
          const itemReturnStatus = isReturned
            ? "FULL"
            : updatedReturnedQty > 0
            ? "PARTIAL"
            : "NONE";

          return {
            ...origIt,
            returnedQty: updatedReturnedQty,
            isReturned,
            returnStatus: itemReturnStatus,
          };
        });
      }

      billDoc.returnInvoiceIds = billDoc.returnInvoiceIds || [];
      if (!billDoc.returnInvoiceIds.some((id) => id.toString() === savedReturn._id.toString())) {
        billDoc.returnInvoiceIds.push(savedReturn._id);
      }

      billDoc.returnInvoices = billDoc.returnInvoices || [];
      billDoc.returnInvoices.push({
        returnId: savedReturn._id,
        returnNo: savedReturn.returnNo || savedReturn.invoiceNo,
        date: savedReturn.date || new Date(),
        returnAmount: billRefundAmount || savedReturn.grandTotal || grandTotal,
        returnType: savedReturn.returnType,
        refundMethod: savedReturn.refundMethod || savedReturn.paymentMethod,
        items: itemsForThisBill.map((i) => ({
          productId: i.productId,
          batchNo: i.batch || i.batchNo,
          name: i.name,
          qty: i.qty || i.returnQty,
          price: i.price || i.rate,
          total: i.total || (Number(i.price || i.rate) * Number(i.qty || i.returnQty)),
        })),
      });

      billDoc.totalReturnedAmount =
        (Number(billDoc.totalReturnedAmount) || 0) + (billRefundAmount || grandTotal);
      billDoc.isReturned = true;

      const isAllFullyReturned =
        billDoc.items.length > 0 &&
        billDoc.items.every(
          (it) => (Number(it.returnedQty) || 0) >= Number(it.qty || 1)
        );

      billDoc.returnStatus = isAllFullyReturned ? "FULL" : "PARTIAL";
      billDoc.isFullyReturned = isAllFullyReturned;

      billDoc.markModified("items");
      billDoc.markModified("returnInvoices");
      billDoc.markModified("returnInvoiceIds");

      await billDoc.save({ session });
    }

    // 7. Inventory Restock & Automatic Scrap Transfer Order Handling
    const resolvedWorkspaceId = workspaceId || customer?.workspaceId || savedReturn?.workspaceId;
    const resolvedCompId = companyId || customer?.companyId || savedReturn?.companyId;

    const generalReturnItems = [];
    const scrapReturnItems = [];

    for (const item of (newReturnBill.items || [])) {
      const motive = String(item.motive || returnData.returnMotive || "general").toLowerCase().trim();
      if (motive === "expired" || motive === "broken" || motive === "damaged") {
        scrapReturnItems.push({ ...item, motive: motive === "broken" ? "broken" : "expired" });
      } else {
        generalReturnItems.push({ ...item, motive: "general" });
      }
    }

    // 7a. For General / Resellable items: increase current branch sellable stock
    if (generalReturnItems.length > 0) {
      await restockReturnInventory(generalReturnItems, resolvedBranchId, resolvedWorkspaceId, session, false);
    }

    // 7b. For Expired or Broken items: place directly in current branch's internal Scrap Bin (no transfer order, no separate branch)
    if (scrapReturnItems.length > 0) {
      await restockReturnInventory(scrapReturnItems, resolvedBranchId, resolvedWorkspaceId, session, true);

      savedReturn.returnMotive = generalReturnItems.length > 0 ? "mixed" : (scrapReturnItems[0]?.motive || "expired");
      savedReturn.transferOrderId = null;
      savedReturn.transferOrderNo = null;
      await savedReturn.save({ session });
    }

    // 8. Decrease GST: Create GSTR-1 Credit Note Ledger Entry
    // (In GSTR-1 summary calculator, credit notes are placed under creditDebitParent and subtracted from gross GST)
    try {
      const totalGst = Number(savedReturn.tax || 0);
      const halfGst = totalGst / 2;
      const taxableAmt = Number(
        returnData.taxableAmount !== undefined
          ? returnData.taxableAmount
          : (savedReturn.subtotal || 0) - (savedReturn.discount || 0)
      );

      const companyGstin = company?.gstin || "";
      const customerGstin = (customer?.gstNumber || customer?.gstin || returnData.customerGstin || "").trim().toUpperCase();
      const hasCustomerGst = customerGstin.length >= 15 && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(customerGstin);
      const isIgst = Boolean(
        returnData.isIgst ||
          (companyGstin &&
            customerGstin &&
            companyGstin.length >= 2 &&
            customerGstin.length >= 2 &&
            companyGstin.slice(0, 2) !== customerGstin.slice(0, 2))
      );

      const groupDescription = hasCustomerGst
        ? "Credit Note - Registered"
        : "Credit Note - Unregistered";

      await gstLedgerRepository.createGstLedgerEntry(
        {
          workspaceId: savedReturn.workspaceId,
          companyId: savedReturn.companyId,
          branchId: savedReturn.branchId || null,
          partyId: customer._id,
          voucherId: savedReturn._id,
          voucherNumber: savedReturn.invoiceNo,
          voucherDate: savedReturn.date ? new Date(savedReturn.date) : new Date(),
          gstType: "GSTR-1",
          groupDescription,
          taxableAmount: taxableAmt,
          cgst: isIgst ? 0 : halfGst,
          sgst: isIgst ? 0 : halfGst,
          igst: isIgst ? totalGst : 0,
          totalAmount: grandTotal,
          narration: `Credit Note / Sales Return ${savedReturn.invoiceNo} (${savedReturn.billingMode}) - Customer: ${customer.name || "Customer"}`,
        },
        { session }
      );
    } catch (gstErr) {
      console.error("[Sales Return] Failed to create GSTR-1 credit note entry:", gstErr);
    }

    // 9. Settlement & Refund Handling
    // A. Keep as Customer Advance
    if (returnType === "advance_credit") {
      customer.advanceBalance = (Number(customer.advanceBalance) || 0) + grandTotal;
      await customer.save({ session });

      await CustomerAdvanceTransaction.create(
        [
          {
            workspaceId: savedReturn.workspaceId,
            companyId: savedReturn.companyId,
            branchId: resolvedBranchId,
            customerId: customer._id,
            type: CUSTOMER_TRANSACTION_TYPE.ADVANCE_RECEIVED,
            amount: grandTotal,
            paymentMethod: "Advance",
            referenceId: savedReturn._id,
            narration: `Refund kept as advance deposit from return memo ${savedReturn.invoiceNo}`,
            status: "ACTIVE",
            shiftId: resolvedShiftId || null,
            createdBy: user?._id || null,
          },
        ],
        { session }
      );
    }

    // B. Credit Note: Issue official Credit Note voucher
    else if (returnType === "credit_note") {
      const isIgst = Boolean(
        customer?.gstNumber &&
        String(customer.gstNumber).slice(0, 2) !== String(savedReturn.workspaceId?.stateCode || "").slice(0, 2)
      );

      const issuedNote = await creditNoteService.issueCreditNote(
        {
          workspaceId: savedReturn.workspaceId,
          companyId: savedReturn.companyId,
          branchId: resolvedBranchId,
          financialPeriodId: savedReturn.financialPeriodId,
          shiftId: resolvedShiftId || null,
          businessDayId: savedReturn.businessDayId || null,
          customerId: customer._id,
          customerName: customer.name || savedReturn.customerName,
          customerPhone: customer.mobile || customer.phone || savedReturn.customerPhone,
          customerGst: customer.gstNumber || null,
          billingMode: savedReturn.billingMode || "B2C",
          source: "SALES_RETURN",
          sourceReturnId: savedReturn._id,
          sourceReturnNo: savedReturn.invoiceNo || savedReturn.returnNo,
          originalInvoiceId: savedReturn.originalInvoiceId || null,
          originalInvoiceNo: savedReturn.originalInvoiceNo || null,
          subtotal: savedReturn.subtotal || 0,
          discount: savedReturn.discount || 0,
          tax: savedReturn.tax || 0,
          cgst: isIgst ? 0 : Number(savedReturn.tax || 0) / 2,
          sgst: isIgst ? 0 : Number(savedReturn.tax || 0) / 2,
          igst: isIgst ? Number(savedReturn.tax || 0) : 0,
          roundOff: savedReturn.roundOff || 0,
          totalAmount: grandTotal,
          items: savedReturn.items || [],
          notes: savedReturn.notes || `Credit Note issued for Return Memo ${savedReturn.invoiceNo}`,
        },
        { session, user }
      );

      savedReturn.creditNoteId = issuedNote._id;
      savedReturn.creditNoteNo = issuedNote.creditNoteNo;
      await savedReturn.save({ session });
    }

    // C. Cash Refund: deduct from running cash counter & update Branch Cash
    else {
      try {
        if (resolvedBranchId) {
          await branchCashRepository.deductRunningCash(
            resolvedBranchId,
            companyId,
            grandTotal,
            dispensedDenoms,
            changeDenoms,
            user?._id,
            { session }
          );
        }
      } catch (cashErr) {
        console.warn("[Sales Return] Running cash deduction error:", cashErr.message);
      }
    }

    // 10. Real-time Active Shift Sync
    if (resolvedShiftId) {
      try {
        const returnInc = {
          returnInvoiceCount: 1,
          returnSalesTotal: grandTotal,
        };
        const pMethod = String(savedReturn.paymentMethod || "CASH").toUpperCase();
        const retType = String(returnType || "").toLowerCase();

        if (savedReturn.paymentMethod === "Split" && Array.isArray(savedReturn.payments) && savedReturn.payments.length > 0) {
          returnInc.returnSplitTotal = grandTotal;
          for (const p of savedReturn.payments) {
            const pt = String(p.paymentType || p.mode || "").toUpperCase();
            const amt = Math.abs(Number(p.amount || 0));
            if (pt.includes("CASH")) returnInc.returnCashTotal = (returnInc.returnCashTotal || 0) + amt;
            else if (pt.includes("UPI") || pt.includes("QR")) returnInc.returnUpiTotal = (returnInc.returnUpiTotal || 0) + amt;
            else if (pt.includes("ADVANCE") || pt.includes("WALLET")) returnInc.returnAdvanceTotal = (returnInc.returnAdvanceTotal || 0) + amt;
            else if (pt.includes("CREDIT")) returnInc.returnCreditTotal = (returnInc.returnCreditTotal || 0) + amt;
          }
        } else if (retType === "advance_credit" || pMethod.includes("ADVANCE") || pMethod.includes("WALLET")) {
          returnInc.returnAdvanceTotal = grandTotal;
        } else if (retType === "credit_note" || pMethod.includes("CREDIT")) {
          returnInc.returnCreditTotal = grandTotal;
          returnInc.returnCreditNoteTotal = grandTotal;
        } else if (pMethod.includes("UPI") || pMethod.includes("QR")) {
          returnInc.returnUpiTotal = grandTotal;
        } else {
          returnInc.returnCashTotal = grandTotal;
        }

        const returnEntry = {
          invoiceId: savedReturn._id,
          returnId: savedReturn._id,
          invoiceNo: savedReturn.invoiceNo || savedReturn.returnNo,
          returnNo: savedReturn.returnNo || savedReturn.invoiceNo,
          originalInvoiceNo: savedReturn.originalInvoiceNo || resolvedOriginalInvoiceNo || "—",
          originalInvoiceId: savedReturn.originalInvoiceId || resolvedOriginalInvoiceId || null,
          grandTotal,
          returnType: returnType || "cash_refund",
          paymentMethod: savedReturn.paymentMethod || "Cash",
          payments: savedReturn.payments || [],
          returnedAt: savedReturn.date || new Date(),
          returnedBy: user?._id || null,
          createdByName: user?.name || null,
          customerName: customer?.name || returnData.customerName || "Walk-in Customer",
          customerPhone: customer?.mobile || customer?.phone || returnData.customerPhone || "",
          itemsCount: Array.isArray(newReturnBill.items) ? newReturnBill.items.length : 0,
          items: (newReturnBill.items || []).map((it) => ({
            itemId: it.productId || it.itemId,
            itemName: it.name || it.itemName,
            quantity: it.qty || it.returnQty || it.quantity,
            price: it.price || it.saleRate,
            total: it.total || it.amount,
            batchNumber: it.batchNo || it.batch || it.batchNumber,
          })),
          notes: savedReturn.notes || "",
        };

        await Shift.updateOne(
          { _id: resolvedShiftId },
          {
            $inc: returnInc,
            $push: { returnInvoices: returnEntry },
          },
          { session }
        );
      } catch (shiftErr) {
        console.warn("[Sales Return] Shift real-time update error:", shiftErr.message);
      }
    }

    if (!existingSession) {
      if (session.inTransaction()) {
        await session.commitTransaction();
      }
      session.endSession();
    }

    return savedReturn;
  } catch (error) {
    if (!existingSession && session) {
      if (session.inTransaction()) {
        try {
          await session.abortTransaction();
        } catch (abortErr) {}
      }
      try {
        session.endSession();
      } catch (e) {}
    }
    throw error;
  }
};

/**
 * Fetch next sequential return invoice number
 */
const getNextReturnNumber = async (companyId, workspaceId, { branchId, date }) => {
  const branches = await branchRepository.getCompanyBranches(companyId);
  let targetBranch = null;
  if (Array.isArray(branches) && branches.length > 0) {
    if (branchId) {
      targetBranch = branches.find((b) => b._id && b._id.toString() === branchId.toString()) || null;
    }
    if (!targetBranch) targetBranch = branches[0];
  }

  const branchInitials = getBranchInitials(targetBranch);
  const returnDateObj = date ? new Date(date) : new Date();
  let fyString = "";
  const month = returnDateObj.getMonth();
  const year = returnDateObj.getFullYear();
  if (month >= 3) {
    fyString = `${year.toString().slice(-2)}${(year + 1).toString().slice(-2)}`;
  } else {
    fyString = `${(year - 1).toString().slice(-2)}${year.toString().slice(-2)}`;
  }

  const finalReturnPrefix = `RET-${branchInitials}-${fyString}-`;
  const lastReturn = await SalesReturn.findOne({
    companyId: new mongoose.Types.ObjectId(companyId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    ...(branchId || targetBranch?._id
      ? { branchId: new mongoose.Types.ObjectId(branchId || targetBranch._id) }
      : {}),
    $or: [
      { returnNo: { $regex: `^${finalReturnPrefix}` } },
      { invoiceNo: { $regex: `^${finalReturnPrefix}` } },
    ],
  }).sort({ date: -1, createdAt: -1 });

  let sequenceNo = 1;
  const lastRetNum = lastReturn?.returnNo || lastReturn?.invoiceNo;
  if (lastRetNum && lastRetNum.startsWith(finalReturnPrefix)) {
    const parts = lastRetNum.split("-");
    if (parts.length >= 4) {
      const lastSeq = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastSeq)) sequenceNo = lastSeq + 1;
    }
  } else {
    const legacyReturn = await invoiceRepository.getLatestInvoiceByPrefix(
      companyId,
      workspaceId,
      finalReturnPrefix,
      branchId || targetBranch?._id
    );
    if (legacyReturn && legacyReturn.invoiceNo && legacyReturn.invoiceNo.startsWith(finalReturnPrefix)) {
      const parts = legacyReturn.invoiceNo.split("-");
      if (parts.length >= 4) {
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) sequenceNo = lastSeq + 1;
      }
    }
  }

  const nextReturnNumber = `${finalReturnPrefix}${sequenceNo.toString().padStart(4, "0")}`;
  return { nextReturnNumber, nextReturnNo: nextReturnNumber };
};

const escapeRegex = (str) =>
  String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Project an incoming Inter-Company PurchaseReturn into the standard SalesReturn shape.
 * Represents the return transaction from the recipient company's perspective (Customer Sales Return).
 */
export const projectPurchaseReturnToSalesReturn = async (pr, companyId, workspaceId) => {
  if (!pr) return null;

  // 1. Resolve Origin Company (Buyer that initiated the return)
  let originCompany = pr.companyId;
  if (!originCompany?.name && mongoose.Types.ObjectId.isValid(pr.companyId)) {
    originCompany = await Company.findById(pr.companyId)
      .select("name legalName gstin gstNumber code address phone")
      .lean();
  }

  // 2. Resolve Customer in current company representing Origin Company
  let customer = null;
  const originGst = (originCompany?.gstin || originCompany?.gstNumber || "").trim().toUpperCase();
  const originName = (originCompany?.name || originCompany?.legalName || "").trim();

  if (originGst || originName) {
    try {
      customer = await Customer.findOne({
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        companyId: new mongoose.Types.ObjectId(companyId),
        isDeleted: false,
        $or: [
          ...(originGst ? [{ gstNumber: originGst }] : []),
          ...(originName ? [{ name: { $regex: new RegExp(`^${escapeRegex(originName)}$`, "i") } }] : []),
        ],
      })
        .select("_id name mobile phone customerCode gstNumber billingAddress advanceBalance creditLimit")
        .lean();
    } catch {
      // non-blocking
    }
  }

  if (!customer) {
    customer = {
      _id: originCompany?._id || pr.companyId?._id || pr.companyId,
      name: originName || "Inter-Company Customer",
      customerCode: originCompany?.code || "INTER-CO",
      gstNumber: originGst || "",
      mobile: originCompany?.phone?.mobile || "—",
      phone: originCompany?.phone?.mobile || "—",
      billingAddress: originCompany?.address || {},
    };
  }

  // 3. Resolve Original Sale Bill in current company
  let originalInvoiceNo = "—";
  let originalInvoiceId = null;

  const candidateInvoiceNos = new Set();
  (pr.items || []).forEach((it) => {
    if (it.purchaseBillNo) candidateInvoiceNos.add(it.purchaseBillNo.trim());
  });

  if (candidateInvoiceNos.size > 0) {
    try {
      const invRegexes = Array.from(candidateInvoiceNos).map(
        (n) => new RegExp(`^${escapeRegex(n)}$`, "i")
      );
      const saleBill = await SalesInvoice.findOne({
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        companyId: new mongoose.Types.ObjectId(companyId),
        invoiceNo: { $in: invRegexes },
        isDeleted: { $ne: true },
      })
        .select("_id invoiceNo grandTotal date items customerId")
        .lean();

      if (saleBill) {
        originalInvoiceNo = saleBill.invoiceNo;
        originalInvoiceId = saleBill._id;
      } else {
        originalInvoiceNo = Array.from(candidateInvoiceNos)[0];
      }
    } catch {
      originalInvoiceNo = Array.from(candidateInvoiceNos)[0] || "—";
    }
  }

  // 4. Map line items to Sales Return format
  const mappedItems = (pr.items || []).map((it, idx) => ({
    _id: it._id || `item-${idx}`,
    productId: it.productId,
    productName: it.productName || "Product",
    pack: it.pack || "",
    batch: it.batchNo,
    batchNo: it.batchNo,
    expiry: it.expiry || "",
    returnQty: it.returnQty,
    quantity: it.returnQty,
    rate: it.rate,
    price: it.rate,
    discount: it.discountPct || 0,
    discountPct: it.discountPct || 0,
    gstRate: it.gstPct || 0,
    gstPct: it.gstPct || 0,
    taxableAmount: it.taxableAmount,
    tax: it.totalGst || 0,
    totalGst: it.totalGst || 0,
    total: it.totalAmount,
    totalAmount: it.totalAmount,
    sourceBin: it.sourceBin || "SELLABLE",
    originalInvoiceNo: it.purchaseBillNo || originalInvoiceNo,
    purchaseBillNo: it.purchaseBillNo || "",
  }));

  const refNo = pr.creditNoteNo || pr.debitNoteNo || pr.returnNo;

  return {
    _id: pr._id,
    returnNo: refNo,
    invoiceNo: refNo,
    isReturn: true,
    isInterCompany: true,
    isOriginalPurchaseReturn: true,
    date: pr.creditNoteDate || pr.shippingDetails?.dispatchedAt || pr.returnDate || pr.createdAt,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    billingMode: "B2B",
    subtotal: pr.taxableSubtotal,
    discount: 0,
    tax: pr.totalGst,
    roundOff: pr.roundOff || 0,
    grandTotal: pr.grandTotal,
    returnAmount: pr.grandTotal,
    returnType: "credit_note",
    paymentMethod: "Credit Note",
    refundMethod: "Credit Note",
    creditNoteNo: pr.creditNoteNo || refNo,
    creditNoteDate: pr.creditNoteDate || pr.returnDate,
    status: pr.status === "CONFIRMED" ? "Completed" : pr.status,
    returnMotive: (pr.returnMotive || "sellable").toLowerCase(),
    reason: pr.reason || pr.remarks || "Inter-Company Return",
    notes: pr.remarks || "",
    customerId: customer,
    customerName: customer.name || originName,
    customerGst: customer.gstNumber || originGst,
    originCompany: {
      _id: originCompany?._id || pr.companyId?._id || pr.companyId,
      name: originName,
      legalName: originCompany?.legalName || originName,
      gstin: originGst,
      code: originCompany?.code || "",
    },
    branchId: pr.shippingDetails?.destinationBranchId || pr.branchId,
    originalInvoiceNo,
    originalInvoiceId,
    items: mappedItems,
    shippingDetails: pr.shippingDetails || {},
    ingestionDetails: pr.ingestionDetails || {},
  };
};

/**
 * Get all customer returns with filters and pagination
 */
const getAllCustomerReturns = async (companyId, workspaceId, filters = {}, pagination = {}) => {
  const page = Math.max(1, parseInt(pagination.page, 10) || 1);
  const limit = Math.max(1, parseInt(pagination.limit, 10) || 20);

  // Auto-sync legacy returns from SalesInvoice (isReturn: true) into SalesReturn if not already present
  try {
    const legacyReturns = await SalesInvoice.find({
      companyId: new mongoose.Types.ObjectId(companyId),
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      isReturn: true,
      isDeleted: false,
    }).lean();

    if (legacyReturns && legacyReturns.length > 0) {
      for (const lr of legacyReturns) {
        const retNo = lr.returnNo || lr.invoiceNo;
        if (!retNo) continue;
        const exists = await SalesReturn.findOne({
          workspaceId: lr.workspaceId,
          $or: [{ returnNo: retNo }, { invoiceNo: lr.invoiceNo }],
        })
          .select("_id")
          .lean();

        if (!exists) {
          await SalesReturn.create({
            workspaceId: lr.workspaceId,
            companyId: lr.companyId,
            branchId: lr.branchId || null,
            customerId: lr.customerId,
            financialPeriodId: lr.financialPeriodId || null,
            shiftId: lr.shiftId || null,
            returnNo: retNo,
            invoiceNo: lr.invoiceNo || retNo,
            date: lr.date || lr.createdAt || new Date(),
            billingMode: lr.billingMode || "B2C",
            subtotal: lr.subtotal || 0,
            discount: lr.discount || 0,
            tax: lr.tax || 0,
            roundOff: lr.roundOff || 0,
            grandTotal: lr.grandTotal || 0,
            returnAmount: lr.grandTotal || 0,
            returnType:
              lr.returnType ||
              (lr.paymentMethod === "Advance"
                ? "advance_credit"
                : lr.paymentMethod === "Credit Note"
                ? "credit_note"
                : "cash_refund"),
            paymentMethod: lr.paymentMethod || "Cash",
            refundMethod: lr.refundMethod || lr.paymentMethod || "Cash",
            refundDenominations: lr.refundDenominations || lr.returnedDenominations || [],
            payments: lr.payments || [],
            originalInvoiceId: lr.originalInvoiceId || null,
            originalInvoiceNo: lr.originalInvoiceNo || null,
            items: lr.items || [],
            doctor: lr.doctor || null,
            doctorId: lr.doctorId || null,
            notes: lr.notes || lr.cancelReason || null,
            status: lr.status || "Completed",
            createdBy: lr.createdBy || null,
            createdAt: lr.createdAt || new Date(),
            updatedAt: lr.updatedAt || new Date(),
          });
        }
      }
    }
  } catch (syncErr) {
    console.warn("[Sales Return] Legacy return auto-sync warning:", syncErr.message);
  }

  const andConditions = [
    { companyId: new mongoose.Types.ObjectId(companyId) },
    { workspaceId: new mongoose.Types.ObjectId(workspaceId) },
    { isDeleted: false },
  ];

  if (filters.branchId && mongoose.Types.ObjectId.isValid(filters.branchId)) {
    andConditions.push({ branchId: new mongoose.Types.ObjectId(filters.branchId) });
  }
  if (filters.customerId && mongoose.Types.ObjectId.isValid(filters.customerId)) {
    andConditions.push({ customerId: new mongoose.Types.ObjectId(filters.customerId) });
  }
  if (filters.shiftId && mongoose.Types.ObjectId.isValid(filters.shiftId)) {
    andConditions.push({ shiftId: new mongoose.Types.ObjectId(filters.shiftId) });
  }

  // Billing Mode Filter (Case-insensitive)
  if (filters.billingMode && filters.billingMode !== "all") {
    andConditions.push({
      billingMode: { $regex: new RegExp(`^${filters.billingMode.trim()}$`, "i") },
    });
  }

  // Refund / Return Type Filter
  if (filters.returnType && filters.returnType !== "all") {
    const rt = String(filters.returnType).trim().toLowerCase();
    if (rt.includes("cash")) {
      andConditions.push({
        $or: [
          { returnType: { $in: ["cash_refund", "CASH", "Cash", "cash"] } },
          { refundMethod: { $regex: /^cash/i } },
          { paymentMethod: { $regex: /^cash/i } },
        ],
      });
    } else if (rt.includes("adv")) {
      andConditions.push({
        $or: [
          { returnType: { $in: ["advance_credit", "ADVANCE", "Advance", "advance"] } },
          { refundMethod: { $regex: /^adv/i } },
          { paymentMethod: { $regex: /^adv/i } },
        ],
      });
    } else if (rt.includes("cred")) {
      andConditions.push({
        $or: [
          { returnType: { $in: ["credit_note", "CREDIT_NOTE", "Credit Note", "credit"] } },
          { refundMethod: { $regex: /^cred/i } },
          { paymentMethod: { $regex: /^cred/i } },
        ],
      });
    } else {
      andConditions.push({
        returnType: { $regex: new RegExp(`^${filters.returnType.trim()}$`, "i") },
      });
    }
  }

  // Search Filter: matches Return No, Bill No, Original Invoice No, or Customer Name / Phone / Mobile
  if (filters.search && typeof filters.search === "string" && filters.search.trim()) {
    const rawTerm = filters.search.trim();
    const escapedTerm = rawTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    let matchingCustomerIds = [];
    try {
      const customers = await Customer.find({
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        $or: [
          { name: { $regex: escapedTerm, $options: "i" } },
          { mobile: { $regex: escapedTerm, $options: "i" } },
          { phone: { $regex: escapedTerm, $options: "i" } },
          { customerCode: { $regex: escapedTerm, $options: "i" } },
        ],
      })
        .select("_id")
        .lean();

      matchingCustomerIds = customers.map((c) => c._id);
    } catch (custErr) {
      console.warn("[Sales Return] Customer search lookup warning:", custErr.message);
    }

    const searchOrConditions = [
      { returnNo: { $regex: escapedTerm, $options: "i" } },
      { invoiceNo: { $regex: escapedTerm, $options: "i" } },
      { originalInvoiceNo: { $regex: escapedTerm, $options: "i" } },
      { customerName: { $regex: escapedTerm, $options: "i" } },
      { customerPhone: { $regex: escapedTerm, $options: "i" } },
    ];

    if (matchingCustomerIds.length > 0) {
      searchOrConditions.push({ customerId: { $in: matchingCustomerIds } });
    }

    andConditions.push({ $or: searchOrConditions });
  }

  // Date Range Filter
  if (filters.dateFrom || filters.dateTo) {
    const dateCond = {};
    if (filters.dateFrom) {
      const fromDate = new Date(filters.dateFrom);
      if (!Number.isNaN(fromDate.getTime())) {
        dateCond.$gte = fromDate;
      }
    }
    if (filters.dateTo) {
      let toDate = new Date(filters.dateTo);
      if (!Number.isNaN(toDate.getTime())) {
        // If string date has no time portion (YYYY-MM-DD), set to end of that day
        if (typeof filters.dateTo === "string" && !filters.dateTo.includes("T")) {
          toDate.setHours(23, 59, 59, 999);
        }
        dateCond.$lte = toDate;
      }
    }

    if (dateCond.$gte || dateCond.$lte) {
      andConditions.push({
        $or: [{ date: dateCond }, { createdAt: dateCond }],
      });
    }
  }

  const query = { $and: andConditions };

  const result = await salesReturnRepository.findSalesReturns(query, { page, limit });

  // If no records found in dedicated sales_returns and first page, fallback to legacy SalesInvoice returns with matching query
  if (result.returns.length === 0 && page === 1) {
    const legacyAndConditions = [
      { companyId: new mongoose.Types.ObjectId(companyId) },
      { workspaceId: new mongoose.Types.ObjectId(workspaceId) },
      { isReturn: true },
      { isDeleted: false },
    ];

    if (filters.branchId && mongoose.Types.ObjectId.isValid(filters.branchId)) {
      legacyAndConditions.push({ branchId: new mongoose.Types.ObjectId(filters.branchId) });
    }
    if (filters.customerId && mongoose.Types.ObjectId.isValid(filters.customerId)) {
      legacyAndConditions.push({ customerId: new mongoose.Types.ObjectId(filters.customerId) });
    }
    if (filters.shiftId && mongoose.Types.ObjectId.isValid(filters.shiftId)) {
      legacyAndConditions.push({ shiftId: new mongoose.Types.ObjectId(filters.shiftId) });
    }
    if (filters.billingMode && filters.billingMode !== "all") {
      legacyAndConditions.push({
        billingMode: { $regex: new RegExp(`^${filters.billingMode.trim()}$`, "i") },
      });
    }
    if (filters.returnType && filters.returnType !== "all") {
      const rt = String(filters.returnType).trim().toLowerCase();
      if (rt.includes("cash")) {
        legacyAndConditions.push({
          $or: [
            { returnType: { $in: ["cash_refund", "CASH", "Cash", "cash"] } },
            { refundMethod: { $regex: /^cash/i } },
            { paymentMethod: { $regex: /^cash/i } },
          ],
        });
      } else if (rt.includes("adv")) {
        legacyAndConditions.push({
          $or: [
            { returnType: { $in: ["advance_credit", "ADVANCE", "Advance", "advance"] } },
            { refundMethod: { $regex: /^adv/i } },
            { paymentMethod: { $regex: /^adv/i } },
          ],
        });
      } else if (rt.includes("cred")) {
        legacyAndConditions.push({
          $or: [
            { returnType: { $in: ["credit_note", "CREDIT_NOTE", "Credit Note", "credit"] } },
            { refundMethod: { $regex: /^cred/i } },
            { paymentMethod: { $regex: /^cred/i } },
          ],
        });
      }
    }
    if (filters.search && typeof filters.search === "string" && filters.search.trim()) {
      const rawTerm = filters.search.trim();
      const escapedTerm = rawTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let matchingCustomerIds = [];
      try {
        const customers = await Customer.find({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          $or: [
            { name: { $regex: escapedTerm, $options: "i" } },
            { mobile: { $regex: escapedTerm, $options: "i" } },
            { phone: { $regex: escapedTerm, $options: "i" } },
            { customerCode: { $regex: escapedTerm, $options: "i" } },
          ],
        })
          .select("_id")
          .lean();
        matchingCustomerIds = customers.map((c) => c._id);
      } catch (custErr) {
        // silent
      }
      const searchOr = [
        { returnNo: { $regex: escapedTerm, $options: "i" } },
        { invoiceNo: { $regex: escapedTerm, $options: "i" } },
        { originalInvoiceNo: { $regex: escapedTerm, $options: "i" } },
      ];
      if (matchingCustomerIds.length > 0) {
        searchOr.push({ customerId: { $in: matchingCustomerIds } });
      }
      legacyAndConditions.push({ $or: searchOr });
    }
    if (filters.dateFrom || filters.dateTo) {
      const dateCond = {};
      if (filters.dateFrom) {
        const fromDate = new Date(filters.dateFrom);
        if (!Number.isNaN(fromDate.getTime())) dateCond.$gte = fromDate;
      }
      if (filters.dateTo) {
        let toDate = new Date(filters.dateTo);
        if (!Number.isNaN(toDate.getTime())) {
          if (typeof filters.dateTo === "string" && !filters.dateTo.includes("T")) {
            toDate.setHours(23, 59, 59, 999);
          }
          dateCond.$lte = toDate;
        }
      }
      if (dateCond.$gte || dateCond.$lte) {
        legacyAndConditions.push({
          $or: [{ date: dateCond }, { createdAt: dateCond }],
        });
      }
    }

    const legacyQuery = { $and: legacyAndConditions };

    const [legacyReturns, legacyTotal] = await Promise.all([
      SalesInvoice.find(legacyQuery)
        .populate("customerId", "name mobile phone customerCode gstNumber")
        .populate("doctorId", "name doctorCode specialty")
        .sort({ date: -1, createdAt: -1 })
        .limit(limit)
        .lean(),
      SalesInvoice.countDocuments(legacyQuery),
    ]);

    if (legacyReturns.length > 0) {
      return {
        returns: legacyReturns.map((r) => {
          let origNo = r.originalInvoiceNo;
          if (!origNo || origNo === r.returnNo || origNo === r.invoiceNo || origNo.startsWith("RET-")) {
            const itOrig = Array.isArray(r.items)
              ? r.items.find((it) => it.originalInvoiceNo && !it.originalInvoiceNo.startsWith("RET-"))
              : null;
            if (itOrig) origNo = itOrig.originalInvoiceNo;
          }
          return {
            ...r,
            returnNo: r.returnNo || r.invoiceNo,
            originalInvoiceNo: origNo || r.originalInvoiceNo || "—",
          };
        }),
        meta: {
          total: legacyTotal,
          page: 1,
          limit,
          totalPages: Math.ceil(legacyTotal / limit) || 1,
        },
      };
    }
  }

  const mappedReturns = (result.returns || []).map((r) => {
    let origNo = r.originalInvoiceNo;
    if (!origNo || origNo === r.returnNo || origNo === r.invoiceNo || origNo.startsWith("RET-")) {
      const itOrig = Array.isArray(r.items)
        ? r.items.find((it) => it.originalInvoiceNo && !it.originalInvoiceNo.startsWith("RET-"))
        : null;
      if (itOrig) origNo = itOrig.originalInvoiceNo;
    }
    return {
      ...r,
      originalInvoiceNo: origNo || r.originalInvoiceNo || "—",
    };
  });

  // Query incoming Inter-Company Purchase Returns where this company is the receiving supplier (destinationCompanyId)
  let interCompanySalesReturns = [];
  try {
    const isB2COnly = filters.billingMode && String(filters.billingMode).toLowerCase() === "b2c";
    const isCashOrAdvOnly =
      filters.returnType &&
      filters.returnType !== "all" &&
      !String(filters.returnType).toLowerCase().includes("cred");

    if (!isB2COnly && !isCashOrAdvOnly) {
      const icFilter = {
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        "shippingDetails.destinationCompanyId": new mongoose.Types.ObjectId(companyId),
        companyId: { $ne: new mongoose.Types.ObjectId(companyId) },
        isDeleted: false,
      };

      if (filters.branchId && mongoose.Types.ObjectId.isValid(filters.branchId)) {
        icFilter["shippingDetails.destinationBranchId"] = new mongoose.Types.ObjectId(filters.branchId);
      }

      if (filters.dateFrom || filters.dateTo) {
        const dateCond = {};
        if (filters.dateFrom) {
          const fDate = new Date(filters.dateFrom);
          if (!Number.isNaN(fDate.getTime())) dateCond.$gte = fDate;
        }
        if (filters.dateTo) {
          let tDate = new Date(filters.dateTo);
          if (!Number.isNaN(tDate.getTime())) {
            if (typeof filters.dateTo === "string" && !filters.dateTo.includes("T")) {
              tDate.setHours(23, 59, 59, 999);
            }
            dateCond.$lte = tDate;
          }
        }
        if (dateCond.$gte || dateCond.$lte) {
          icFilter.$or = [{ returnDate: dateCond }, { createdAt: dateCond }];
        }
      }

      if (filters.search && typeof filters.search === "string" && filters.search.trim()) {
        const rawTerm = filters.search.trim();
        const escapedTerm = rawTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = { $regex: escapedTerm, $options: "i" };
        icFilter.$or = [
          { returnNo: regex },
          { debitNoteNo: regex },
          { creditNoteNo: regex },
          { reason: regex },
          { remarks: regex },
          { "items.productName": regex },
          { "items.batchNo": regex },
        ];
      }

      const icDocs = await PurchaseReturn.find(icFilter)
        .populate("companyId", "name legalName gstin gstNumber code address phone")
        .populate("branchId", "name branchCode address")
        .populate("supplierId", "businessName gstNumber")
        .populate("shippingDetails.destinationCompanyId", "name legalName gstin")
        .populate("shippingDetails.destinationBranchId", "name branchCode address phone")
        .lean();

      if (Array.isArray(icDocs) && icDocs.length > 0) {
        interCompanySalesReturns = await Promise.all(
          icDocs.map((doc) => projectPurchaseReturnToSalesReturn(doc, companyId, workspaceId))
        );
      }
    }
  } catch (icErr) {
    console.warn("[Sales Return] Inter-company sales return aggregation warning:", icErr?.message);
  }

  const combinedReturns = [...mappedReturns, ...interCompanySalesReturns];
  combinedReturns.sort((a, b) => {
    const timeB = new Date(b.date || b.createdAt || 0).getTime();
    const timeA = new Date(a.date || a.createdAt || 0).getTime();
    return timeB - timeA;
  });

  const total = (result.meta?.total || mappedReturns.length) + interCompanySalesReturns.length;
  const paginatedReturns = interCompanySalesReturns.length > 0
    ? combinedReturns.slice(0, limit)
    : combinedReturns;

  return {
    ...result,
    returns: paginatedReturns,
    meta: {
      ...(result.meta || {}),
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

/**
 * Get single sales return by ID or memo number
 */
const getReturnById = async (returnId, companyId, workspaceId) => {
  let returnDoc = await salesReturnRepository.findSalesReturnById(
    returnId,
    companyId,
    workspaceId
  );

  if (!returnDoc) {
    const isObjectId = mongoose.Types.ObjectId.isValid(returnId);
    const legacyQuery = {
      companyId: new mongoose.Types.ObjectId(companyId),
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      isReturn: true,
      isDeleted: false,
      ...(isObjectId
        ? { $or: [{ _id: new mongoose.Types.ObjectId(returnId) }, { invoiceNo: returnId }] }
        : { invoiceNo: returnId }),
    };

    returnDoc = await SalesInvoice.findOne(legacyQuery)
      .populate(
        "customerId",
        "name mobile phone customerCode gstNumber billingAddress advanceBalance creditLimit"
      )
      .populate("doctorId", "name doctorCode specialty")
      .populate("shiftId", "shiftNo shiftNumber openedAt status")
      .lean();
  }

  // If still not found, check if it's an incoming Inter-Company PurchaseReturn
  if (!returnDoc) {
    try {
      const isObjectId = mongoose.Types.ObjectId.isValid(returnId);
      const prQuery = {
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        "shippingDetails.destinationCompanyId": new mongoose.Types.ObjectId(companyId),
        companyId: { $ne: new mongoose.Types.ObjectId(companyId) },
        isDeleted: false,
        ...(isObjectId
          ? {
              $or: [
                { _id: new mongoose.Types.ObjectId(returnId) },
                { returnNo: returnId },
                { debitNoteNo: returnId },
                { creditNoteNo: returnId },
              ],
            }
          : {
              $or: [
                { returnNo: returnId },
                { debitNoteNo: returnId },
                { creditNoteNo: returnId },
              ],
            }),
      };

      const prDoc = await PurchaseReturn.findOne(prQuery)
        .populate("companyId", "name legalName gstin gstNumber code address phone")
        .populate("branchId", "name branchCode address")
        .populate("supplierId", "businessName gstNumber")
        .populate("shippingDetails.destinationCompanyId", "name legalName gstin")
        .populate("shippingDetails.destinationBranchId", "name branchCode address phone")
        .lean();

      if (prDoc) {
        returnDoc = await projectPurchaseReturnToSalesReturn(prDoc, companyId, workspaceId);
      }
    } catch (icErr) {
      console.warn("[Sales Return] Inter-company return lookup warning:", icErr?.message);
    }
  }

  if (!returnDoc) {
    throw new ApiError(404, "Sales return record not found");
  }

  if (returnDoc) {
    let origNo = returnDoc.originalInvoiceNo;
    if (!origNo || origNo === returnDoc.returnNo || origNo === returnDoc.invoiceNo || origNo.startsWith("RET-")) {
      const itOrig = Array.isArray(returnDoc.items)
        ? returnDoc.items.find((it) => it.originalInvoiceNo && !it.originalInvoiceNo.startsWith("RET-"))
        : null;
      if (itOrig) {
        returnDoc.originalInvoiceNo = itOrig.originalInvoiceNo;
        if (!returnDoc.originalInvoiceId && itOrig.originalInvoiceId) {
          returnDoc.originalInvoiceId = itOrig.originalInvoiceId;
        }
      }
    }
  }

  return returnDoc;
};

export default {
  recordCustomerReturn,
  getNextReturnNumber,
  getAllCustomerReturns,
  getReturnById,
  projectPurchaseReturnToSalesReturn,
};
