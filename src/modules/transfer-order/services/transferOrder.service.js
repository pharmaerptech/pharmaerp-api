import mongoose from "mongoose";
import TransferOrder from "../models/transferOrder.model.js";
import Batch from "../../catalog/products/models/batch.model.js";
import ProductFacility from "../../catalog/products/models/productFacility.model.js";
import branchRepository from "../../organization/branches/repositories/branch.repository.js";
import financialPeriodRepository from "../../finance/financial-periods/repositories/financialPeriod.repository.js";
import { getBranchInitials } from "../../../utils/branchInitials.js";
import ApiError from "../../../utils/ApiError.js";

/**
 * Generates a branch-wise sequential transfer order number.
 * Format: {BRANCH_INITIALS}-TR-{FY}-{0001}
 * e.g., NN-TR-2627-0001
 * Follows the same pattern and reliability as sales invoice numbering.
 */
export const generateBranchTransferNo = async (
  workspaceId,
  sourceBranch,
  companyId,
  session
) => {
  const branchInitials = getBranchInitials(sourceBranch);

  let fyString = "";
  if (companyId) {
    try {
      const periods = await financialPeriodRepository.getFinancialPeriods(
        companyId,
        workspaceId,
        { status: "ACTIVE" }
      );
      const period = periods?.periods?.[0];
      if (period && period.startDate && period.endDate) {
        const startYear = new Date(period.startDate).getFullYear();
        const endYear = new Date(period.endDate).getFullYear();
        fyString = `${startYear.toString().slice(-2)}${endYear.toString().slice(-2)}`;
      }
    } catch {
      // Fallback to calendar-based fiscal year (Apr-Mar)
    }
  }

  if (!fyString) {
    const now = new Date();
    const currentMonth = now.getMonth(); // 0 = Jan, 3 = Apr
    const currentYear = now.getFullYear();
    const startYear = currentMonth >= 3 ? currentYear : currentYear - 1;
    const endYear = startYear + 1;
    fyString = `${startYear.toString().slice(-2)}${endYear.toString().slice(-2)}`;
  }

  const finalPrefix = `${branchInitials}-TR-${fyString}-`;

  // Find latest transfer order created by this branch matching this prefix
  const lastOrder = await TransferOrder.findOne({
    workspaceId,
    sourceBranchId: sourceBranch._id,
    transferNo: { $regex: `^${finalPrefix}` },
  })
    .sort({ createdAt: -1, _id: -1 })
    .session(session);

  let sequenceNo = 1;
  if (
    lastOrder &&
    lastOrder.transferNo &&
    lastOrder.transferNo.startsWith(finalPrefix)
  ) {
    const parts = lastOrder.transferNo.split("-");
    if (parts.length >= 4) {
      const lastSeq = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastSeq)) {
        sequenceNo = lastSeq + 1;
      }
    }
  }

  // Ensure collision avoidance across workspace
  let candidateSeq = sequenceNo;
  let finalTransferNo = `${finalPrefix}${candidateSeq.toString().padStart(4, "0")}`;
  let collision = await TransferOrder.findOne({
    workspaceId,
    transferNo: finalTransferNo,
  }).session(session);

  while (collision) {
    candidateSeq += 1;
    finalTransferNo = `${finalPrefix}${candidateSeq.toString().padStart(4, "0")}`;
    collision = await TransferOrder.findOne({
      workspaceId,
      transferNo: finalTransferNo,
    }).session(session);
  }

  return finalTransferNo;
};

export const createTransferOrder = async (
  workspaceId,
  data,
  user,
  companyId = null,
  branchId = null
) => {
  const {
    sourceBranchId,
    destinationBranchId,
    items,
    remarks,
    transferType = "STANDARD",
  } = data;

  if (!items || items.length === 0) {
    throw new ApiError(400, "Items cannot be empty");
  }

  if (!sourceBranchId) {
    throw new ApiError(400, "Source branch is required");
  }

  if (!destinationBranchId) {
    throw new ApiError(400, "Destination branch is required");
  }

  if (String(sourceBranchId) === String(destinationBranchId)) {
    throw new ApiError(400, "Source and destination branches cannot be the same");
  }

  // Enforce dispatching strictly from the user's active branch if scoped
  if (branchId && String(sourceBranchId) !== String(branchId)) {
    throw new ApiError(403, "Transfer orders can only be dispatched from your current active branch");
  }

  // Resolve source branch details to obtain branch initials and companyId
  const sourceBranch = await branchRepository.findBranchById(sourceBranchId);
  if (!sourceBranch) {
    throw new ApiError(404, "Source branch not found");
  }

  const resolvedCompanyId =
    companyId || data.companyId || sourceBranch.companyId || null;
  const resolvedBranchId = branchId || data.branchId || sourceBranchId;

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const transferNo = await generateBranchTransferNo(
      workspaceId,
      sourceBranch,
      resolvedCompanyId,
      session
    );

    const isScrapOrder = transferType === "SCRAP";

    const preparedItems = [];

    for (const item of items) {
      const batch = await Batch.findOne({
        _id: item.batch,
        workspaceId,
        branch_id: sourceBranchId,
      }).session(session);

      if (!batch) {
        throw new ApiError(404, `Batch ${item.batchNo} not found in source branch`);
      }

      const isItemScrap =
        isScrapOrder ||
        (item.scrapType && item.scrapType !== "NONE") ||
        item.isScrap;

      let sourceBin = "SELLABLE";
      const resolvedScrapType =
        item.scrapType ||
        (item.category === "broken"
          ? "BROKEN"
          : item.category === "scrap_expired"
          ? "EXPIRED"
          : isScrapOrder
          ? "EXPIRED"
          : "NONE");

      const originalBatchNo =
        item.originalBatchNo ||
        batch.originalBatchNo ||
        (batch.batchNo
          ? batch.batchNo.replace(/\s*\[(EXPIRED|BROKEN|SCRAP)\]/gi, "").trim()
          : item.batchNo);

      if (isItemScrap) {
        // Check if scrap bin has sufficient stock
        const availScrap = Number(batch.scrapQty || 0);
        const availShelf = Number(batch.batchQty || 0);

        if (availScrap >= item.transferQty) {
          sourceBin = "SCRAP";
          batch.scrapQty = Math.max(0, availScrap - item.transferQty);

          if (resolvedScrapType === "BROKEN" || Number(batch.brokenQty || 0) > 0) {
            batch.brokenQty = Math.max(0, Number(batch.brokenQty || 0) - item.transferQty);
          } else {
            batch.expiredQty = Math.max(0, Number(batch.expiredQty || 0) - item.transferQty);
          }
          await batch.save({ session });

          const sourceFacility = await ProductFacility.findOne({
            workspaceId,
            facility_id: sourceBranchId,
            product_id: item.product,
          }).session(session);

          if (sourceFacility) {
            sourceFacility.scrapQty = Math.max(0, Number(sourceFacility.scrapQty || 0) - item.transferQty);
            await sourceFacility.save({ session });
          }
        } else if (availShelf >= item.transferQty) {
          // Shelf-expired batch being transferred as scrap
          sourceBin = "SELLABLE";
          batch.batchQty -= item.transferQty;
          await batch.save({ session });

          const sourceFacility = await ProductFacility.findOne({
            workspaceId,
            facility_id: sourceBranchId,
            product_id: item.product,
          }).session(session);

          if (sourceFacility) {
            sourceFacility.total_qty_available = Math.max(
              0,
              Number(sourceFacility.total_qty_available || 0) - item.transferQty
            );
            sourceFacility.qoh = Math.max(
              0,
              Number(sourceFacility.qoh || 0) - item.transferQty
            );
            await sourceFacility.save({ session });
          }
        } else {
          throw new ApiError(
            400,
            `Insufficient quantity in batch ${item.batchNo}. Available scrap: ${availScrap}, shelf: ${availShelf}`
          );
        }
      } else {
        // Standard sellable stock transfer
        if (batch.batchQty <= 0) {
          throw new ApiError(400, `Cannot transfer from empty batch ${item.batchNo}`);
        }

        if (batch.batchQty < item.transferQty) {
          throw new ApiError(400, `Insufficient quantity in batch ${item.batchNo}`);
        }

        // Deduct from source batch
        batch.batchQty -= item.transferQty;
        await batch.save({ session });

        // Deduct from source product facility
        const sourceFacility = await ProductFacility.findOne({
          workspaceId,
          facility_id: sourceBranchId,
          product_id: item.product,
        }).session(session);

        if (sourceFacility) {
          sourceFacility.total_qty_available -= item.transferQty;
          sourceFacility.qoh -= item.transferQty;
          await sourceFacility.save({ session });
        }
      }

      preparedItems.push({
        product: item.product,
        batch: item.batch,
        batchNo: item.batchNo,
        originalBatchNo,
        scrapType: resolvedScrapType,
        sourceBin,
        transferQty: item.transferQty,
      });
    }

    const transferOrder = new TransferOrder({
      workspaceId,
      companyId: resolvedCompanyId,
      branchId: resolvedBranchId,
      transferNo,
      sourceBranchId,
      destinationBranchId,
      transferType: isScrapOrder ? "SCRAP" : "STANDARD",
      status: "IN_TRANSIT",
      items: preparedItems,
      remarks,
      createdBy: user._id,
    });

    await transferOrder.save({ session });
    await session.commitTransaction();
    session.endSession();

    return transferOrder;
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

export const receiveTransferOrder = async (workspaceId, transferOrderId, user) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const transferOrder = await TransferOrder.findOne({
      _id: transferOrderId,
      workspaceId,
    }).session(session);

    if (!transferOrder) {
      throw new ApiError(404, "Transfer Order not found");
    }

    if (transferOrder.status !== "IN_TRANSIT") {
      throw new ApiError(400, "Only IN_TRANSIT orders can be received");
    }

    const isScrapOrder = transferOrder.transferType === "SCRAP";

    for (const item of transferOrder.items) {
      // Find source batch to copy properties like mrp, rates, etc.
      const sourceBatch = await Batch.findOne({
        _id: item.batch,
      }).session(session);

      if (!sourceBatch) {
        throw new ApiError(404, `Source batch ${item.batchNo} not found`);
      }

      const isItemScrap =
        isScrapOrder ||
        (item.scrapType && item.scrapType !== "NONE") ||
        item.sourceBin === "SCRAP";

      if (isItemScrap) {
        // Destination receives this item as quarantined scrap stock
        const isBroken =
          item.scrapType === "BROKEN" ||
          (item.batchNo && item.batchNo.includes("[BROKEN]"));
        const resolvedScrapType = isBroken ? "BROKEN" : "EXPIRED";
        const originalBatchNo =
          item.originalBatchNo ||
          sourceBatch.originalBatchNo ||
          (sourceBatch.batchNo
            ? sourceBatch.batchNo.replace(/\s*\[(EXPIRED|BROKEN|SCRAP)\]/gi, "").trim()
            : item.batchNo);

        const targetBatchNo = `${originalBatchNo} [${resolvedScrapType}]`;

        let destBatch = await Batch.findOne({
          workspaceId,
          branch_id: transferOrder.destinationBranchId,
          product: item.product,
          batchNo: targetBatchNo,
        }).session(session);

        if (destBatch) {
          destBatch.scrapQty = (destBatch.scrapQty || 0) + item.transferQty;
          if (resolvedScrapType === "BROKEN") {
            destBatch.brokenQty = (destBatch.brokenQty || 0) + item.transferQty;
          } else {
            destBatch.expiredQty = (destBatch.expiredQty || 0) + item.transferQty;
          }
          destBatch.scrapType = resolvedScrapType;
          destBatch.originalBatchNo = originalBatchNo;
          destBatch.isIncoming = true;
          destBatch.sourceBranchId = transferOrder.sourceBranchId;
          destBatch.sourceTransferOrderId = transferOrder._id;
          destBatch.sourceTransferOrderNo = transferOrder.transferNo;
          await destBatch.save({ session });
        } else {
          destBatch = new Batch({
            workspaceId,
            branch_id: transferOrder.destinationBranchId,
            product: item.product,
            batchNo: targetBatchNo,
            originalBatchNo,
            scrapType: resolvedScrapType,
            batchQty: 0, // IMPORTANT: Sellable shelf stock remains 0!
            scrapQty: item.transferQty,
            brokenQty: resolvedScrapType === "BROKEN" ? item.transferQty : 0,
            expiredQty: resolvedScrapType === "EXPIRED" ? item.transferQty : 0,
            isIncoming: true,
            sourceBranchId: transferOrder.sourceBranchId,
            sourceTransferOrderId: transferOrder._id,
            sourceTransferOrderNo: transferOrder.transferNo,
            purchaseBillId: sourceBatch.purchaseBillId || null,
            mrp: sourceBatch.mrp,
            MRP: sourceBatch.MRP,
            ptr: sourceBatch.ptr,
            pts: sourceBatch.pts,
            rate: sourceBatch.rate,
            finalRateA: sourceBatch.finalRateA,
            finalRateB: sourceBatch.finalRateB,
            finalRateC: sourceBatch.finalRateC,
            rateA: sourceBatch.rateA,
            rateB: sourceBatch.rateB,
            rateC: sourceBatch.rateC,
            expiryDate: sourceBatch.expiryDate,
          });
          await destBatch.save({ session });
        }

        // Update destination product facility scrap quantity
        let destFacility = await ProductFacility.findOne({
          workspaceId,
          facility_id: transferOrder.destinationBranchId,
          product_id: item.product,
        }).session(session);

        if (destFacility) {
          destFacility.scrapQty = (destFacility.scrapQty || 0) + item.transferQty;
          await destFacility.save({ session });
        } else {
          destFacility = new ProductFacility({
            workspaceId,
            facility_id: transferOrder.destinationBranchId,
            product_id: item.product,
            total_qty_available: 0,
            qoh: 0,
            scrapQty: item.transferQty,
          });
          await destFacility.save({ session });
        }
      } else {
        // Standard sellable transfer receipt
        let destBatch = await Batch.findOne({
          workspaceId,
          branch_id: transferOrder.destinationBranchId,
          product: item.product,
          batchNo: item.batchNo,
          expiryDate: sourceBatch.expiryDate, // using expiry as key
        }).session(session);

        if (destBatch) {
          destBatch.batchQty += item.transferQty;
          destBatch.isIncoming = true;
          destBatch.sourceBranchId = transferOrder.sourceBranchId;
          destBatch.sourceTransferOrderId = transferOrder._id;
          destBatch.sourceTransferOrderNo = transferOrder.transferNo;
          await destBatch.save({ session });
        } else {
          // Create new batch for destination
          destBatch = new Batch({
            workspaceId,
            branch_id: transferOrder.destinationBranchId,
            product: item.product,
            batchNo: item.batchNo,
            batchQty: item.transferQty,
            isIncoming: true,
            sourceBranchId: transferOrder.sourceBranchId,
            sourceTransferOrderId: transferOrder._id,
            sourceTransferOrderNo: transferOrder.transferNo,
            purchaseBillId: sourceBatch.purchaseBillId || null,
            mrp: sourceBatch.mrp,
            MRP: sourceBatch.MRP,
            ptr: sourceBatch.ptr,
            pts: sourceBatch.pts,
            rate: sourceBatch.rate,
            finalRateA: sourceBatch.finalRateA,
            finalRateB: sourceBatch.finalRateB,
            finalRateC: sourceBatch.finalRateC,
            rateA: sourceBatch.rateA,
            rateB: sourceBatch.rateB,
            rateC: sourceBatch.rateC,
            expiryDate: sourceBatch.expiryDate,
          });
          await destBatch.save({ session });
        }

        // Update destination product facility
        let destFacility = await ProductFacility.findOne({
          workspaceId,
          facility_id: transferOrder.destinationBranchId,
          product_id: item.product,
        }).session(session);

        if (destFacility) {
          destFacility.total_qty_available += item.transferQty;
          destFacility.qoh += item.transferQty;
          await destFacility.save({ session });
        } else {
          destFacility = new ProductFacility({
            workspaceId,
            facility_id: transferOrder.destinationBranchId,
            product_id: item.product,
            total_qty_available: item.transferQty,
            qoh: item.transferQty,
          });
          await destFacility.save({ session });
        }
      }
    }

    transferOrder.status = "COMPLETED";
    transferOrder.receivedBy = user._id;
    transferOrder.receivedAt = new Date();
    await transferOrder.save({ session });

    await session.commitTransaction();
    session.endSession();

    return transferOrder;
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

export const cancelTransferOrder = async (
  workspaceId,
  transferOrderId,
  user,
  cancelReason = ""
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const transferOrder = await TransferOrder.findOne({
      _id: transferOrderId,
      workspaceId,
    }).session(session);

    if (!transferOrder) {
      throw new ApiError(404, "Transfer Order not found");
    }

    if (transferOrder.status === "COMPLETED") {
      throw new ApiError(400, "Cannot cancel a completed transfer order");
    }

    if (transferOrder.status === "CANCELLED") {
      throw new ApiError(400, "Transfer order is already cancelled");
    }

    if (transferOrder.status !== "IN_TRANSIT" && transferOrder.status !== "PENDING") {
      throw new ApiError(
        400,
        `Cannot cancel transfer order with status ${transferOrder.status}`
      );
    }

    const isScrapOrder = transferOrder.transferType === "SCRAP";

    // Restore stock to source branch batches and product facility
    for (const item of transferOrder.items) {
      const sourceBatch = await Batch.findOne({
        _id: item.batch,
        workspaceId,
        branch_id: transferOrder.sourceBranchId,
      }).session(session);

      const isItemScrap =
        isScrapOrder ||
        (item.scrapType && item.scrapType !== "NONE") ||
        item.sourceBin === "SCRAP";

      if (isItemScrap && item.sourceBin === "SCRAP") {
        // Restore to source scrap bin
        if (sourceBatch) {
          sourceBatch.scrapQty = (sourceBatch.scrapQty || 0) + item.transferQty;
          if (item.scrapType === "BROKEN") {
            sourceBatch.brokenQty = (sourceBatch.brokenQty || 0) + item.transferQty;
          } else {
            sourceBatch.expiredQty = (sourceBatch.expiredQty || 0) + item.transferQty;
          }
          await sourceBatch.save({ session });
        }

        let sourceFacility = await ProductFacility.findOne({
          workspaceId,
          facility_id: transferOrder.sourceBranchId,
          product_id: item.product,
        }).session(session);

        if (sourceFacility) {
          sourceFacility.scrapQty = (sourceFacility.scrapQty || 0) + item.transferQty;
          await sourceFacility.save({ session });
        }
      } else {
        // Restore to regular sellable stock (or shelf)
        if (sourceBatch) {
          sourceBatch.batchQty += item.transferQty;
          await sourceBatch.save({ session });
        } else {
          // Fallback by product & batchNo in source branch
          const fallbackBatch = await Batch.findOne({
            product_id: item.product,
            batchNo: item.batchNo,
            branch_id: transferOrder.sourceBranchId,
            workspaceId,
          }).session(session);

          if (fallbackBatch) {
            fallbackBatch.batchQty += item.transferQty;
            await fallbackBatch.save({ session });
          }
        }

        // Restore to source product facility
        let sourceFacility = await ProductFacility.findOne({
          workspaceId,
          facility_id: transferOrder.sourceBranchId,
          product_id: item.product,
        }).session(session);

        if (sourceFacility) {
          sourceFacility.total_qty_available += item.transferQty;
          sourceFacility.qoh += item.transferQty;
          await sourceFacility.save({ session });
        } else {
          sourceFacility = new ProductFacility({
            workspaceId,
            facility_id: transferOrder.sourceBranchId,
            product_id: item.product,
            total_qty_available: item.transferQty,
            qoh: item.transferQty,
          });
          await sourceFacility.save({ session });
        }
      }
    }

    transferOrder.status = "CANCELLED";
    transferOrder.cancelledBy = user._id;
    transferOrder.cancelledAt = new Date();
    if (cancelReason) {
      transferOrder.cancelReason = cancelReason;
    }
    await transferOrder.save({ session });

    await session.commitTransaction();
    session.endSession();

    return await TransferOrder.findById(transferOrder._id)
      .populate("sourceBranchId", "name branchCode type")
      .populate("destinationBranchId", "name branchCode type")
      .populate("createdBy", "name")
      .populate("receivedBy", "name")
      .populate({ path: "cancelledBy", select: "name", strictPopulate: false })
      .populate("items.product", "name")
      .lean();
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

export const updateTransferOrder = async (
  workspaceId,
  transferOrderId,
  data,
  user
) => {
  const { destinationBranchId, items, remarks } = data;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const transferOrder = await TransferOrder.findOne({
      _id: transferOrderId,
      workspaceId,
    }).session(session);

    if (!transferOrder) {
      throw new ApiError(404, "Transfer Order not found");
    }

    if (transferOrder.status === "COMPLETED") {
      throw new ApiError(400, "Cannot edit a completed transfer order");
    }

    if (transferOrder.status === "CANCELLED") {
      throw new ApiError(400, "Cannot edit a cancelled transfer order");
    }

    if (destinationBranchId) {
      if (String(destinationBranchId) === String(transferOrder.sourceBranchId)) {
        throw new ApiError(
          400,
          "Destination branch cannot be the same as source branch"
        );
      }
      transferOrder.destinationBranchId = destinationBranchId;
    }

    if (remarks !== undefined) {
      transferOrder.remarks = remarks;
    }

    // If items are being modified, restore old stock first and then deduct new stock
    if (items && Array.isArray(items) && items.length > 0) {
      // 1. Restore previous quantities to source branch
      for (const oldItem of transferOrder.items) {
        const sourceBatch = await Batch.findOne({
          _id: oldItem.batch,
          workspaceId,
          branch_id: transferOrder.sourceBranchId,
        }).session(session);

        if (sourceBatch) {
          sourceBatch.batchQty += oldItem.transferQty;
          await sourceBatch.save({ session });
        }

        const sourceFacility = await ProductFacility.findOne({
          workspaceId,
          facility_id: transferOrder.sourceBranchId,
          product_id: oldItem.product,
        }).session(session);

        if (sourceFacility) {
          sourceFacility.total_qty_available += oldItem.transferQty;
          sourceFacility.qoh += oldItem.transferQty;
          await sourceFacility.save({ session });
        }
      }

      // 2. Validate and deduct new items
      for (const newItem of items) {
        const batch = await Batch.findOne({
          _id: newItem.batch,
          workspaceId,
          branch_id: transferOrder.sourceBranchId,
        }).session(session);

        if (!batch) {
          throw new ApiError(
            404,
            `Batch ${newItem.batchNo || ""} not found in source branch`
          );
        }

        if (batch.batchQty < newItem.transferQty) {
          throw new ApiError(
            400,
            `Insufficient quantity in batch ${newItem.batchNo || ""}. Available: ${batch.batchQty}`
          );
        }

        batch.batchQty -= newItem.transferQty;
        await batch.save({ session });

        const sourceFacility = await ProductFacility.findOne({
          workspaceId,
          facility_id: transferOrder.sourceBranchId,
          product_id: newItem.product,
        }).session(session);

        if (sourceFacility) {
          sourceFacility.total_qty_available = Math.max(
            0,
            sourceFacility.total_qty_available - newItem.transferQty
          );
          sourceFacility.qoh = Math.max(0, sourceFacility.qoh - newItem.transferQty);
          await sourceFacility.save({ session });
        }
      }

      transferOrder.items = items;
    }

    await transferOrder.save({ session });
    await session.commitTransaction();
    session.endSession();

    return await TransferOrder.findById(transferOrder._id)
      .populate("sourceBranchId", "name branchCode type")
      .populate("destinationBranchId", "name branchCode type")
      .populate("createdBy", "name")
      .populate("receivedBy", "name")
      .populate({ path: "cancelledBy", select: "name", strictPopulate: false })
      .populate("items.product", "name")
      .lean();
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

export const getTransferOrders = async (
  workspaceId,
  filters = {},
  pagination = {},
  companyId = null,
  branchId = null
) => {
  const { page = 1, limit = 10 } = pagination;
  const skip = (page - 1) * limit;

  const query = { workspaceId };

  const targetCompanyId = companyId || filters.companyId;
  if (targetCompanyId) {
    query.$or = [{ companyId: targetCompanyId }, { companyId: null }];
  }

  if (filters.status && filters.status !== "all") {
    query.status = filters.status;
  }

  if (filters.sourceBranchId && filters.sourceBranchId !== "all") {
    query.sourceBranchId = filters.sourceBranchId;
  }

  if (filters.destinationBranchId && filters.destinationBranchId !== "all") {
    query.destinationBranchId = filters.destinationBranchId;
  }

  if (filters.transferType && filters.transferType !== "all") {
    query.transferType = filters.transferType;
  }

  // Branch-specific query: if branchId is provided and neither source nor destination filter was specified
  const targetBranchId = branchId || filters.branchId;
  if (
    targetBranchId &&
    targetBranchId !== "all" &&
    (!filters.sourceBranchId || filters.sourceBranchId === "all") &&
    (!filters.destinationBranchId || filters.destinationBranchId === "all")
  ) {
    const branchOrConditions = [
      { sourceBranchId: targetBranchId },
      { destinationBranchId: targetBranchId },
      { branchId: targetBranchId },
    ];
    if (query.$or) {
      query.$and = [{ $or: query.$or }, { $or: branchOrConditions }];
      delete query.$or;
    } else {
      query.$or = branchOrConditions;
    }
  }

  const total = await TransferOrder.countDocuments(query);
  const transferOrders = await TransferOrder.find(query)
    .populate("sourceBranchId", "name branchCode type")
    .populate("destinationBranchId", "name branchCode type")
    .populate("createdBy", "name")
    .populate("receivedBy", "name")
    .populate({ path: "cancelledBy", select: "name", strictPopulate: false })
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  return { total, transferOrders, page, limit };
};

export const getTransferOrderById = async (workspaceId, transferOrderId) => {
  const transferOrder = await TransferOrder.findOne({
    _id: transferOrderId,
    workspaceId,
  })
    .populate("sourceBranchId", "name branchCode type")
    .populate("destinationBranchId", "name branchCode type")
    .populate("createdBy", "name")
    .populate("receivedBy", "name")
    .populate({ path: "cancelledBy", select: "name", strictPopulate: false })
    .populate("items.product", "name")
    .lean();

  if (!transferOrder) {
    throw new ApiError(404, "Transfer Order not found");
  }

  return transferOrder;
};

export default {
  createTransferOrder,
  receiveTransferOrder,
  cancelTransferOrder,
  updateTransferOrder,
  getTransferOrders,
  getTransferOrderById,
};
