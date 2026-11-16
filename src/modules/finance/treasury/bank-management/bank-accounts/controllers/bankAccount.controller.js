import asyncHandler from "../../../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../../../utils/ApiResponse.js";
import bankAccountService from "../services/bankAccount.service.js";

export const createBankAccount = asyncHandler(async (req, res) => {
  const bankAccount = await bankAccountService.createBankAccount(
    req.workspaceId,
    req.companyId,
    req.user._id,
    req.body
  );
  return res
    .status(201)
    .json(new ApiResponse(201, "Bank Account created successfully", bankAccount));
});

export const getBankAccounts = asyncHandler(async (req, res) => {
  const companyId =
    req.query.companyId && req.query.companyId !== "all"
      ? req.query.companyId
      : req.companyId;

  const result = await bankAccountService.getBankAccounts(
    req.workspaceId,
    companyId || null,
    req.query
  );
  return res
    .status(200)
    .json(new ApiResponse(200, "Bank Accounts fetched successfully", result));
});

export const getBankAccountById = asyncHandler(async (req, res) => {
  const bankAccount = await bankAccountService.getBankAccountById(
    req.params.bankAccountId,
    req.companyId,
    req.workspaceId
  );
  return res
    .status(200)
    .json(new ApiResponse(200, "Bank Account fetched successfully", bankAccount));
});

export const updateBankAccount = asyncHandler(async (req, res) => {
  const bankAccount = await bankAccountService.updateBankAccount(
    req.params.bankAccountId,
    req.companyId,
    req.workspaceId,
    req.user._id,
    req.body
  );
  return res
    .status(200)
    .json(new ApiResponse(200, "Bank Account updated successfully", bankAccount));
});

export const deleteBankAccount = asyncHandler(async (req, res) => {
  const result = await bankAccountService.deleteBankAccount(
    req.params.bankAccountId,
    req.companyId,
    req.workspaceId,
    req.user._id
  );
  return res
    .status(200)
    .json(new ApiResponse(200, "Bank Account deleted successfully", result));
});

export const setPrimary = asyncHandler(async (req, res) => {
  const bankAccount = await bankAccountService.updateBankAccount(
    req.params.bankAccountId,
    req.companyId,
    req.workspaceId,
    req.user._id,
    { isPrimary: true }
  );
  return res
    .status(200)
    .json(new ApiResponse(200, "Bank Account set as primary successfully", bankAccount));
});
