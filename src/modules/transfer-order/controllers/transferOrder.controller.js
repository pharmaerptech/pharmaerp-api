import asyncHandler from "../../../utils/asyncHandler.js";
import ApiResponse from "../../../utils/ApiResponse.js";
import transferOrderService from "../services/transferOrder.service.js";

export const createTransferOrder = asyncHandler(async (req, res) => {
  const companyId =
    req.headers["x-company-id"] ||
    req.companyId ||
    req.body.companyId ||
    req.query.companyId ||
    null;

  const branchId =
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.body.branchId ||
    req.body.sourceBranchId ||
    req.query.branchId ||
    null;

  const transferOrder = await transferOrderService.createTransferOrder(
    req.workspaceId,
    req.body,
    req.user,
    companyId,
    branchId
  );

  return res
    .status(201)
    .json(
      new ApiResponse(201, "Transfer order created successfully", transferOrder)
    );
});

export const receiveTransferOrder = asyncHandler(async (req, res) => {
  const transferOrder = await transferOrderService.receiveTransferOrder(
    req.workspaceId,
    req.params.id,
    req.user
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, "Transfer order received successfully", transferOrder)
    );
});

export const cancelTransferOrder = asyncHandler(async (req, res) => {
  const { cancelReason } = req.body || {};
  const transferOrder = await transferOrderService.cancelTransferOrder(
    req.workspaceId,
    req.params.id,
    req.user,
    cancelReason
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, "Transfer order cancelled successfully", transferOrder)
    );
});

export const updateTransferOrder = asyncHandler(async (req, res) => {
  const transferOrder = await transferOrderService.updateTransferOrder(
    req.workspaceId,
    req.params.id,
    req.body,
    req.user
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, "Transfer order updated successfully", transferOrder)
    );
});

export const getTransferOrders = asyncHandler(async (req, res) => {
  const { page, limit, status, sourceBranchId, destinationBranchId } = req.query;

  const companyId =
    req.headers["x-company-id"] ||
    req.companyId ||
    req.query.companyId ||
    null;

  const rawBranchId =
    req.query.branchId !== undefined
      ? req.query.branchId
      : (req.headers["x-branch-id"] || req.branchId || null);

  const branchId =
    rawBranchId && rawBranchId !== "all" && rawBranchId !== "undefined" && rawBranchId !== "null"
      ? rawBranchId
      : null;

  const result = await transferOrderService.getTransferOrders(
    req.workspaceId,
    { status, sourceBranchId, destinationBranchId, companyId, branchId },
    { page: Number(page) || 1, limit: Number(limit) || 10 },
    companyId,
    branchId
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, "Transfer orders fetched successfully", result)
    );
});

export const getTransferOrderById = asyncHandler(async (req, res) => {
  const transferOrder = await transferOrderService.getTransferOrderById(
    req.workspaceId,
    req.params.id
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, "Transfer order fetched successfully", transferOrder)
    );
});
