import asyncHandler from "../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../utils/ApiResponse.js";
import invoiceService from "../services/invoice.service.js";

export const recordCustomerSale = asyncHandler(async (req, res) => {
  const branchId =
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.query.branchId ||
    req.body.branchId ||
    null;

  const result = await invoiceService.recordCustomerSale(
    req.params.customerId,
    { ...req.body, branchId },
    req.companyId,
    req.workspaceId,
    req.user
  );

  return res
    .status(201)
    .json(new ApiResponse(201, "Customer sale recorded successfully", result));
});

export const getCustomerSales = asyncHandler(async (req, res) => {
  const branchId =
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.query.branchId ||
    null;

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;

  const result = await invoiceService.getCustomerSales(
    req.params.customerId,
    req.companyId,
    req.workspaceId,
    branchId,
    { page, limit }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer sales fetched successfully", result));
});

export const getAllCustomerSales = asyncHandler(async (req, res) => {
  const branchId =
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.query.branchId ||
    null;

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  
  const filters = {
    branchId,
    searchQuery: req.query.search,
    status: req.query.status,
    paymentMethod: req.query.paymentMethod,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
  };

  const result = await invoiceService.getAllCustomerSales(
    req.companyId,
    req.workspaceId,
    filters,
    { page, limit }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "All customer sales fetched successfully", result));
});

export const updateCustomerSale = asyncHandler(async (req, res) => {
  const branchId =
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.query.branchId ||
    req.body.branchId ||
    null;

  const result = await invoiceService.updateCustomerSale(
    req.params.invoiceId,
    req.params.customerId,
    { ...req.body, branchId },
    req.companyId,
    req.workspaceId,
    req.user
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer sale updated successfully", result));
});


export const cancelCustomerSale = asyncHandler(async (req, res) => {
  const result = await invoiceService.cancelCustomerSale(
    req.params.invoiceId,
    req.companyId,
    req.workspaceId,
    req.user
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer sale cancelled successfully", result));
});
