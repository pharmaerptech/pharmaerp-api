import asyncHandler from "../../../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../../../utils/ApiResponse.js";
import cashExchangeService from "../services/cashExchange.service.js";

export const createCashExchange = asyncHandler(async (req, res) => {

  const branchId =
    req.headers["x-branch-id"] || req.branchId || req.body.branchId || null;
  const payload = { ...req.body, branchId };

  const cashExchange = await cashExchangeService.createCashExchange(
    req.workspaceId,
    req.companyId,
    req.user._id,
    payload,
  );
  return res
    .status(201)
    .json(
      new ApiResponse(201, "Cash Exchange completed successfully", cashExchange),
    );
});

export const getCashExchanges = asyncHandler(async (req, res) => {
  const rawBranchId = req.query.branchId !== undefined
    ? req.query.branchId
    : (req.headers["x-branch-id"] || req.branchId || null);
  const branchId = rawBranchId && rawBranchId !== "all" && rawBranchId !== "undefined" && rawBranchId !== "null"
    ? rawBranchId
    : null;

  const query = {
    ...req.query,
    branchId: branchId || undefined,
  };

  const result = await cashExchangeService.getCashExchanges(
    req.workspaceId,
    req.companyId,
    query,
  );
  return res
    .status(200)
    .json(new ApiResponse(200, "Cash Exchanges fetched successfully", result));
});

export const getCashExchangeById = asyncHandler(async (req, res) => {
  const cashExchange = await cashExchangeService.getCashExchangeById(
    req.params.cashExchangeId,
    req.companyId,
    req.workspaceId,
  );
  return res
    .status(200)
    .json(
      new ApiResponse(200, "Cash Exchange fetched successfully", cashExchange),
    );
});

