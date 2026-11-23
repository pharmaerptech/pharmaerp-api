import asyncHandler from "../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../utils/ApiResponse.js";
import ApiError from "../../../../utils/ApiError.js";
import purchaseReturnService from "../services/purchaseReturn.service.js";

export const createPurchaseReturn = asyncHandler(async (req, res) => {
  const payload = { ...req.body };
  if (!payload.branchId && req.headers["x-branch-id"]) {
    payload.branchId = req.headers["x-branch-id"];
  }

  const result = await purchaseReturnService.createPurchaseReturn(
    req.workspaceId,
    req.companyId,
    payload.branchId || req.branchId,
    req.user._id,
    payload
  );

  return res
    .status(201)
    .json(new ApiResponse(201, "Purchase return created and debit note issued successfully", result));
});

export const getPurchaseReturns = asyncHandler(async (req, res) => {
  const branchId = req.query.branchId || req.headers["x-branch-id"] || req.branchId;
  const result = await purchaseReturnService.getPurchaseReturns(
    req.workspaceId,
    req.companyId,
    branchId,
    req.query,
    {
      page: req.query.page,
      limit: req.query.limit,
    }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Purchase returns fetched successfully", result));
});

export const getPurchaseReturnById = asyncHandler(async (req, res) => {
  const result = await purchaseReturnService.getPurchaseReturnById(
    req.params.returnId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Purchase return details fetched successfully", result));
});

export const getEligibleBatches = asyncHandler(async (req, res) => {
  const branchId = req.query.branchId || req.headers["x-branch-id"] || req.branchId;
  const result = await purchaseReturnService.getEligibleBatchesForReturn(
    req.workspaceId,
    req.companyId,
    branchId,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Eligible return batches fetched successfully", result));
});

export const cancelPurchaseReturn = asyncHandler(async (req, res) => {
  const result = await purchaseReturnService.cancelPurchaseReturn(
    req.params.returnId,
    req.companyId,
    req.workspaceId,
    req.user._id,
    req.body.reason
  );

  return res
    .status(200)
    .json(new ApiResponse(200, result.message, result));
});

export const dispatchReturnBox = asyncHandler(async (req, res) => {
  const result = await purchaseReturnService.dispatchReturnBox(
    req.params.returnId,
    req.companyId,
    req.workspaceId,
    req.user._id,
    req.body
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Purchase return box dispatched to destination facility", result));
});

export const receiveReturnBox = asyncHandler(async (req, res) => {
  const branchId = req.headers["x-branch-id"] || req.branchId;
  const result = await purchaseReturnService.receiveReturnBox(
    req.params.returnId,
    req.companyId,
    branchId,
    req.workspaceId,
    req.user._id
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Consignment box marked as received successfully", result));
});

export const ingestFreshStockToStore = asyncHandler(async (req, res) => {
  const branchId =
    req.body?.branchId ||
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.user?.branch_id;

  const result = await purchaseReturnService.ingestFreshStockToStore(
    req.params.returnId,
    req.companyId,
    branchId,
    req.workspaceId,
    req.user?._id
  );

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        "Fresh return stock ingested into store shelf inventory successfully",
        result
      )
    );
});

const purchaseReturnController = {
  createPurchaseReturn,
  getPurchaseReturns,
  getPurchaseReturnById,
  getEligibleBatches,
  cancelPurchaseReturn,
  dispatchReturnBox,
  receiveReturnBox,
  ingestFreshStockToStore,
};

export default purchaseReturnController;

