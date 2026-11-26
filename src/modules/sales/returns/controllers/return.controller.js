import asyncHandler from "../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../utils/ApiResponse.js";
import returnService from "../services/return.service.js";

export const recordCustomerReturn = asyncHandler(async (req, res) => {
  const branchId =
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.query.branchId ||
    req.body.branchId ||
    null;

  const result = await returnService.recordCustomerReturn(
    req.params.customerId || req.body.customerId,
    { ...req.body, branchId },
    req.companyId,
    req.workspaceId,
    req.user
  );

  return res
    .status(201)
    .json(new ApiResponse(201, "Sales return bill recorded successfully", result));
});

export const getNextReturnNumber = asyncHandler(async (req, res) => {
  const branchId =
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.query.branchId ||
    null;

  const date = req.query.date || null;

  const result = await returnService.getNextReturnNumber(
    req.companyId,
    req.workspaceId,
    { branchId, date }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Next return number fetched successfully", result));
});

export const getAllCustomerReturns = asyncHandler(async (req, res) => {
  const rawBranchId =
    req.query.branchId !== undefined
      ? req.query.branchId
      : (req.headers["x-branch-id"] || req.branchId || null);

  const branchId =
    rawBranchId && rawBranchId !== "all" && rawBranchId !== "undefined" && rawBranchId !== "null"
      ? rawBranchId
      : null;

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  const filters = {
    branchId,
    customerId: req.query.customerId,
    shiftId: req.query.shiftId,
    search: req.query.search,
    returnType: req.query.returnType,
    billingMode: req.query.billingMode,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
  };

  const result = await returnService.getAllCustomerReturns(
    req.companyId,
    req.workspaceId,
    filters,
    { page, limit }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "All customer returns fetched successfully", result));
});

export const getReturnById = asyncHandler(async (req, res) => {
  const result = await returnService.getReturnById(
    req.params.returnId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Return record fetched successfully", result));
});

export const ingestFreshStockToStore = asyncHandler(async (req, res) => {
  const branchId =
    req.body?.branchId ||
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.user?.branch_id;

  const result = await returnService.ingestFreshStockToStore(
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

export const quarantineScrapToStore = asyncHandler(async (req, res) => {
  const branchId =
    req.body?.branchId ||
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.user?.branch_id;

  const result = await returnService.quarantineScrapToStore(
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
        "Damaged and expired return stock quarantined into scrap bin successfully",
        result
      )
    );
});

export const approveSalesReturn = asyncHandler(async (req, res) => {
  const result = await returnService.approveSalesReturn(
    req.params.returnId,
    { note: req.body?.note || req.body?.approvalNote || "" },
    req.user,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Sales return approved successfully", result));
});

export default {
  recordCustomerReturn,
  getNextReturnNumber,
  getAllCustomerReturns,
  getReturnById,
  ingestFreshStockToStore,
  quarantineScrapToStore,
  approveSalesReturn,
};
