import asyncHandler from "../../../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../../../utils/ApiResponse.js";
import cashTransactionService from "../services/cashTransaction.service.js";

export const getCashTransactions = asyncHandler(async (req, res) => {
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

  const result = await cashTransactionService.getCashTransactions(
    req.workspaceId,
    req.companyId,
    query,
  );
  return res
    .status(200)
    .json(new ApiResponse(200, "Cash Transactions fetched successfully", result));
});

export const getCashTransactionById = asyncHandler(async (req, res) => {
  const cashTransaction = await cashTransactionService.getCashTransactionById(
    req.params.cashTransactionId,
    req.companyId,
    req.workspaceId,
  );
  return res
    .status(200)
    .json(new ApiResponse(200, "Cash Transaction fetched successfully", cashTransaction));
});

export const cancelCashTransaction = asyncHandler(async (req, res) => {
  const cashTransaction = await cashTransactionService.cancelCashTransaction(
    req.params.cashTransactionId,
    req.companyId,
    req.workspaceId,
    req.user._id,
    req.body,
  );
  return res
    .status(200)
    .json(new ApiResponse(200, "Cash Transaction cancelled successfully", cashTransaction));
});
