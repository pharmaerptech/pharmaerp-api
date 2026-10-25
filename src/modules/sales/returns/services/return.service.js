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
import Customer from "../../../parties/customers/models/customer.model.js";
import CustomerAdvanceTransaction from "../../../parties/customers/models/customerAdvanceTransaction.model.js";
import CustomerCreditTransaction from "../../../parties/customers/models/customerCreditTransaction.model.js";
import { CUSTOMER_TRANSACTION_TYPE } from "../../../parties/customers/constants/customer.constant.js";
import { Shift } from "../../../operations/shifts/shift.model.js";
import branchCashRepository from "../../../finance/treasury/cash-management/branch-cash/repositories/branchCash.repository.js";
import cashTransactionService from "../../../finance/treasury/cash-management/cash-transactions/services/cashTransaction.service.js";
import { decomposeCashAmount } from "../../../parties/customers/services/customerAdvance.service.js";

/**
 * Restock inventory for returned items (increment Batch & ProductFacility quantities)
 */
const restockReturnInventory = async (items, branchId, workspaceId, session) => {
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
    const qtyToRestock = Number(item.qty || 0) + Number(item.freeQty || 0);
    if (qtyToRestock <= 0) continue;

    // 1. Resolve product ID (handle string, object, or lookup by name in catalog)
    let rawProductId =
      item.productId ||
      item.product_id ||
      item.workspaceProductId ||
      (item.workspaceProduct && (item.workspaceProduct._id || item.workspaceProduct.id)) ||
      item.id;

    let productObjId =
      rawProductId && mongoose.Types.ObjectId.isValid(rawProductId)
        ? new mongoose.Types.ObjectId(rawProductId)
        : null;

    // If productObjId was not valid, try finding by item name in this workspace
    if (!productObjId && workspaceObjId && (item.name || item.productName)) {
      const searchName = (item.name || item.productName || "").trim();
      if (searchName) {
        try {
          const foundProduct = await WorkspaceProduct.findOne({
            workspaceId: workspaceObjId,
            $or: [
              { name: searchName },
              { displayName: searchName },
              { workspaceProductCode: searchName },
            ],
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

    // Resolve branch for this specific item if present, else fallback to top-level resolved branch
    const itemBranchId =
      item.branchId && mongoose.Types.ObjectId.isValid(item.branchId)
        ? new mongoose.Types.ObjectId(item.branchId)
        : branchObjId;

    // 2. Resolve batch information
    const rawBatchId =
      item.batchId ||
      item.batch_id ||
      (item.batch && typeof item.batch === "object" && (item.batch._id || item.batch.id)) ||
      (typeof item.batch === "string" && mongoose.Types.ObjectId.isValid(item.batch)
        ? item.batch
        : null);

    const batchNo = (
      item.batchNo ||
      item.batchNumber ||
      (typeof item.batch === "string" ? item.batch : (item.batch && (item.batch.batchNo || item.batch.batch))) ||
      "STANDARD"
    ).trim();

    const expiryDate = (item.expiry || item.expiryDate || "").trim();

    // 3. Update or Create Batch
    let batch = null;

    // 3a. Search by batch _id if provided and valid
    if (rawBatchId && mongoose.Types.ObjectId.isValid(rawBatchId)) {
      batch = await Batch.findOne({
        _id: new mongoose.Types.ObjectId(rawBatchId),
        ...(workspaceObjId ? { workspaceId: workspaceObjId } : {}),
      }).session(session);
    }

    // 3b. Search by product + branch + batchNo + expiryDate
    if (!batch && workspaceObjId) {
      batch = await Batch.findOne({
        workspaceId: workspaceObjId,
        product: productObjId,
        ...(itemBranchId ? { branch_id: itemBranchId } : {}),
        batchNo,
        ...(expiryDate ? { expiryDate } : {}),
      }).session(session);
    }

    // 3c. Search by product + branch + batchNo
    if (!batch && workspaceObjId) {
      batch = await Batch.findOne({
        workspaceId: workspaceObjId,
        product: productObjId,
        ...(itemBranchId ? { branch_id: itemBranchId } : {}),
        batchNo,
      }).session(session);
    }

    // 3d. Fallback: Search by product + branch (any active batch)
    if (!batch && workspaceObjId) {
      batch = await Batch.findOne({
        workspaceId: workspaceObjId,
        product: productObjId,
        ...(itemBranchId ? { branch_id: itemBranchId } : {}),
        isDeleted: false,
      }).session(session);
    }

    if (batch) {
      batch.batchQty = (Number(batch.batchQty) || 0) + qtyToRestock;
      batch.isDeleted = false;
      await batch.save({ session });
    } else if (workspaceObjId) {
      // Create a new batch for this product so branch inventory is restored
      try {
        await Batch.create(
          [
            {
              workspaceId: workspaceObjId,
              branch_id: itemBranchId,
              product: productObjId,
              batchNo: batchNo || "STANDARD",
              batchQty: qtyToRestock,
              mrp: Number(item.mrp || 0),
              rate: Number(item.rate || item.price || 0),
              rateA: Number(item.rateA || 0),
              rateB: Number(item.rateB || item.rateb || 0),
              rateC: Number(item.rateC || item.rate || item.price || 0),
              expiryDate: expiryDate || "",
              isDeleted: false,
            },
          ],
          { session }
        );
      } catch (err) {
        if (err.code === 11000) {
          const existingBatch = await Batch.findOne({
            branch_id: itemBranchId,
            product: productObjId,
            batchNo: batchNo || "STANDARD",
          }).session(session);
          if (existingBatch) {
            existingBatch.batchQty = (Number(existingBatch.batchQty) || 0) + qtyToRestock;
            existingBatch.isDeleted = false;
            await existingBatch.save({ session });
          }
        } else {
          console.error("restockReturnInventory: Error creating new batch:", err);
        }
      }
    }

    // 4. Update or Create ProductFacility
    if (itemBranchId && workspaceObjId) {
      let facility = await ProductFacility.findOne({
        workspaceId: workspaceObjId,
        facility_id: itemBranchId,
        product_id: productObjId,
      }).session(session);

      if (facility) {
        facility.total_qty_available = (Number(facility.total_qty_available) || 0) + qtyToRestock;
        facility.qoh = (Number(facility.qoh) || 0) + qtyToRestock;
        facility.atp = (Number(facility.atp) || 0) + qtyToRestock;
        facility.isDeleted = false;
        await facility.save({ session });
      } else {
        try {
          await ProductFacility.create(
            [
              {
                workspaceId: workspaceObjId,
                facility_id: itemBranchId,
                product_id: productObjId,
                total_qty_available: qtyToRestock,
                qoh: qtyToRestock,
                atp: qtyToRestock,
                isDeleted: false,
              },
            ],
            { session }
          );
        } catch (err) {
          if (err.code === 11000) {
            const existingFacility = await ProductFacility.findOne({
              workspaceId: workspaceObjId,
              facility_id: itemBranchId,
              product_id: productObjId,
            }).session(session);
            if (existingFacility) {
              existingFacility.total_qty_available = (Number(existingFacility.total_qty_available) || 0) + qtyToRestock;
              existingFacility.qoh = (Number(existingFacility.qoh) || 0) + qtyToRestock;
              existingFacility.atp = (Number(existingFacility.atp) || 0) + qtyToRestock;
              existingFacility.isDeleted = false;
              await existingFacility.save({ session });
            }
          } else {
            console.error("restockReturnInventory: Error creating ProductFacility:", err);
          }
        }
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
  if (!existingSession) session.startTransaction();

  try {
    // 1. Fetch customer and reference data
    const [customer, activeBranches, periods, company] = await Promise.all([
      customerRepository.findCustomerById(customerId, companyId, workspaceId),
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

      let sequenceNo = 1;
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

      let candidateSeq = sequenceNo;
      finalReturnNo = `${finalReturnPrefix}${candidateSeq.toString().padStart(4, "0")}`;
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
    }

    // 5. Auto-resolve open shift for branch
    let resolvedShiftId = returnData.shiftId || null;
    if (resolvedShiftId && mongoose.Types.ObjectId.isValid(resolvedShiftId)) {
      const shiftDoc = await Shift.findById(resolvedShiftId).session(session);
      if (!shiftDoc || shiftDoc.status !== "open") {
        resolvedShiftId = null;
      }
    }
    if (!resolvedShiftId && resolvedBranchId) {
      const activeOpenShift = await Shift.findOne({
        workspaceId: workspaceId || customer.workspaceId,
        companyId: companyId || customer.companyId,
        branchId: resolvedBranchId,
        status: "open",
      }).session(session);
      if (activeOpenShift) {
        resolvedShiftId = activeOpenShift._id;
      }
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
    let originalInvoiceDoc = null;
    const invFindQuery = {
      workspaceId: workspaceId || customer.workspaceId,
      companyId: companyId || customer.companyId,
      isDeleted: false,
    };

    if (resolvedOriginalInvoiceId && mongoose.Types.ObjectId.isValid(resolvedOriginalInvoiceId)) {
      originalInvoiceDoc = await SalesInvoice.findOne({
        ...invFindQuery,
        _id: resolvedOriginalInvoiceId,
      }).session(session);
    }

    if (!originalInvoiceDoc && resolvedOriginalInvoiceNo) {
      originalInvoiceDoc = await SalesInvoice.findOne({
        ...invFindQuery,
        invoiceNo: resolvedOriginalInvoiceNo,
      }).session(session);
    }

    if (originalInvoiceDoc) {
      resolvedOriginalInvoiceId = originalInvoiceDoc._id;
      resolvedOriginalInvoiceNo = originalInvoiceDoc.invoiceNo;

      // Validate each item to return against original invoice line items
      if (Array.isArray(originalInvoiceDoc.items) && Array.isArray(returnData.items)) {
        for (const retItem of returnData.items) {
          const reqQty = Number(retItem.qty ?? retItem.quantity ?? retItem.returnQty ?? 0);
          if (reqQty <= 0) continue;

          const matchedItem =
            originalInvoiceDoc.items.find((origIt) => {
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
            originalInvoiceDoc.items.find((origIt) => {
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
                `Cannot return item "${matchedItem.name || retItem.name}". All ${soldQty} units from bill #${originalInvoiceDoc.invoiceNo} have already been returned.`
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
      billingMode: returnData.billingMode || "B2C",
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
      originalInvoiceId: resolvedOriginalInvoiceId,
      originalInvoiceNo: resolvedOriginalInvoiceNo,
      createdBy: user?._id || null,
      createdByName: user?.name || null,
      createdByEmail: user?.email || null,
    };

    const savedReturn = await salesReturnRepository.createSalesReturn(newReturnBill, { session });

    // 6b. Update Original Sale Bill with Return IDs & Returned Item Quantities
    if (originalInvoiceDoc) {
      if (Array.isArray(originalInvoiceDoc.items)) {
        originalInvoiceDoc.items = originalInvoiceDoc.items.map((origIt) => {
          let updatedReturnedQty = Number(origIt.returnedQty || 0);
          const retItem =
            (newReturnBill.items || []).find((rIt) => {
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
            (newReturnBill.items || []).find((rIt) => {
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

      originalInvoiceDoc.returnInvoiceIds = originalInvoiceDoc.returnInvoiceIds || [];
      if (
        !originalInvoiceDoc.returnInvoiceIds.some(
          (id) => id.toString() === savedReturn._id.toString()
        )
      ) {
        originalInvoiceDoc.returnInvoiceIds.push(savedReturn._id);
      }

      originalInvoiceDoc.returnInvoices = originalInvoiceDoc.returnInvoices || [];
      originalInvoiceDoc.returnInvoices.push({
        returnId: savedReturn._id,
        returnNo: savedReturn.returnNo || savedReturn.invoiceNo,
        date: savedReturn.date || new Date(),
        returnAmount: savedReturn.grandTotal || grandTotal,
        returnType: savedReturn.returnType,
        refundMethod: savedReturn.refundMethod || savedReturn.paymentMethod,
        items: (newReturnBill.items || []).map((i) => ({
          productId: i.productId,
          batchNo: i.batch || i.batchNo,
          name: i.name,
          qty: i.qty || i.returnQty,
          price: i.price || i.rate,
          total: i.total || (Number(i.price || i.rate) * Number(i.qty || i.returnQty)),
        })),
      });

      originalInvoiceDoc.totalReturnedAmount =
        (Number(originalInvoiceDoc.totalReturnedAmount) || 0) + grandTotal;
      originalInvoiceDoc.isReturned = true;

      const isAllFullyReturned =
        originalInvoiceDoc.items.length > 0 &&
        originalInvoiceDoc.items.every(
          (it) => (Number(it.returnedQty) || 0) >= Number(it.qty || 1)
        );

      originalInvoiceDoc.returnStatus = isAllFullyReturned ? "FULL" : "PARTIAL";
      originalInvoiceDoc.isFullyReturned = isAllFullyReturned;

      originalInvoiceDoc.markModified("items");
      originalInvoiceDoc.markModified("returnInvoices");
      originalInvoiceDoc.markModified("returnInvoiceIds");

      await originalInvoiceDoc.save({ session });
    }

    // 7. Increase Inventory (Restock Batch & ProductFacility)
    const resolvedWorkspaceId = workspaceId || customer?.workspaceId || savedReturn?.workspaceId;
    await restockReturnInventory(newReturnBill.items, resolvedBranchId, resolvedWorkspaceId, session);

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
      const customerGstin = customer?.gstNumber || "";
      const hasCustomerGst =
        customerGstin &&
        /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(
          customerGstin.trim().toUpperCase()
        );
      const isIgst = Boolean(
        returnData.isIgst ||
          (companyGstin &&
            customerGstin &&
            companyGstin.length >= 2 &&
            customerGstin.length >= 2 &&
            companyGstin.slice(0, 2) !== customerGstin.slice(0, 2))
      );

      const groupDescription = hasCustomerGst || String(savedReturn.billingMode).toUpperCase() === "B2B"
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

    // B. Credit Note adjustment against pending credit outstanding
    else if (returnType === "credit_note") {
      const pendingCredits = await CustomerCreditTransaction.find({
        customerId: customer._id,
        companyId: savedReturn.companyId,
        status: { $in: ["PENDING", "PARTIAL"] },
      })
        .sort({ invoiceDate: 1 })
        .session(session);

      let remainingRefund = grandTotal;
      for (const cr of pendingCredits) {
        if (remainingRefund <= 0) break;
        const curDue = Number(cr.balanceDue || 0);
        const settleAmt = Math.min(curDue, remainingRefund);

        cr.paidAmount = (Number(cr.paidAmount) || 0) + settleAmt;
        cr.balanceDue = curDue - settleAmt;
        if (cr.balanceDue <= 0.01) {
          cr.status = "SETTLED";
          cr.balanceDue = 0;
        } else {
          cr.status = "PARTIAL";
        }
        cr.settlements = cr.settlements || [];
        cr.settlements.push({
          settlementDate: new Date(),
          amount: settleAmt,
          paymentMethod: "Credit Note",
          referenceNumber: savedReturn.invoiceNo,
          narration: `Adjusted against Sales Return Memo ${savedReturn.invoiceNo}`,
        });
        await cr.save({ session });
        remainingRefund -= settleAmt;
      }

      // If credit note exceeded total outstanding debt, store excess into customer advance
      if (remainingRefund > 0.01) {
        customer.advanceBalance = (Number(customer.advanceBalance) || 0) + remainingRefund;
        await customer.save({ session });
        await CustomerAdvanceTransaction.create(
          [
            {
              workspaceId: savedReturn.workspaceId,
              companyId: savedReturn.companyId,
              branchId: resolvedBranchId,
              customerId: customer._id,
              type: CUSTOMER_TRANSACTION_TYPE.ADVANCE_RECEIVED,
              amount: remainingRefund,
              paymentMethod: "Advance",
              referenceId: savedReturn._id,
              narration: `Credit note excess advance balance from return memo ${savedReturn.invoiceNo}`,
              status: "ACTIVE",
              shiftId: resolvedShiftId || null,
              createdBy: user?._id || null,
            },
          ],
          { session }
        );
      }
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
      await session.commitTransaction();
      session.endSession();
    }

    return savedReturn;
  } catch (error) {
    if (!existingSession) {
      try {
        await session.abortTransaction();
      } catch (abortErr) {}
      session.endSession();
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

  return {
    ...result,
    returns: mappedReturns,
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
};
