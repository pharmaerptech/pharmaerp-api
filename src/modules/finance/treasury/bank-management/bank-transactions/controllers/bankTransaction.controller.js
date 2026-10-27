import asyncHandler from "../../../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../../../utils/ApiResponse.js";
import bankTransactionService from "../services/bankTransaction.service.js";


export const getBankTransactions = asyncHandler(async (req, res) => {
  const result = await bankTransactionService.getBankTransactions(
    req.workspaceId,
    req.companyId,
    req.query,
  );
  return res
    .status(200)
    .json(new ApiResponse(200, "Bank Transactions fetched successfully", result));
});

export const getBankTransactionById = asyncHandler(async (req, res) => {
  const bankTransaction = await bankTransactionService.getBankTransactionById(
    req.params.bankTransactionId,
    req.companyId,
    req.workspaceId,
  );
  return res
    .status(200)
    .json(new ApiResponse(200, "Bank Transaction fetched successfully", bankTransaction));
});

export const cancelBankTransaction = asyncHandler(async (req, res) => {
  const bankTransaction = await bankTransactionService.cancelBankTransaction(
    req.params.bankTransactionId,
    req.companyId,
    req.workspaceId,
    req.user._id,
    req.body,
  );
  return res
    .status(200)
    .json(new ApiResponse(200, "Bank Transaction cancelled successfully", bankTransaction));
});

export const depositBankTransaction = asyncHandler(async (req, res) => {
  const result = await bankTransactionService.directDeposit(
    req.workspaceId,
    req.companyId,
    req.user._id,
    req.body,
  );
  return res
    .status(201)
    .json(new ApiResponse(201, "Direct bank deposit posted successfully", result));
});

export const withdrawBankTransaction = asyncHandler(async (req, res) => {
  const result = await bankTransactionService.directWithdraw(
    req.workspaceId,
    req.companyId,
    req.user._id,
    req.body,
  );
  return res
    .status(201)
    .json(new ApiResponse(201, "Direct bank withdrawal posted successfully", result));
});
