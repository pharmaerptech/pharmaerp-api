import asyncHandler from "../../../utils/asyncHandler.js";
import ApiResponse from "../../../utils/ApiResponse.js";
import pharmacyReportsService from "../services/pharmacyReports.service.js";

export const getDailySalesReport = asyncHandler(async (req, res) => {
  const result = await pharmacyReportsService.getDailySalesReport({
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    branchId: req.query.branchId || req.branchId,
    ...req.query,
  });
  return res.status(200).json(new ApiResponse(200, "Daily sales report fetched successfully", result));
});

export const getNearExpiryReport = asyncHandler(async (req, res) => {
  const result = await pharmacyReportsService.getNearExpiryReport({
    workspaceId: req.workspaceId,
    branchId: req.query.branchId || req.branchId,
    ...req.query,
  });
  return res.status(200).json(new ApiResponse(200, "Near expiry report fetched successfully", result));
});

export const getLowStockReorderReport = asyncHandler(async (req, res) => {
  const result = await pharmacyReportsService.getLowStockReorderReport({
    workspaceId: req.workspaceId,
    branchId: req.query.branchId || req.branchId,
    ...req.query,
  });
  return res.status(200).json(new ApiResponse(200, "Low stock report fetched successfully", result));
});

export const getStockValuationReport = asyncHandler(async (req, res) => {
  const result = await pharmacyReportsService.getStockValuationReport({
    workspaceId: req.workspaceId,
    branchId: req.query.branchId || req.branchId,
    ...req.query,
  });
  return res.status(200).json(new ApiResponse(200, "Stock valuation report fetched successfully", result));
});

export const getCustomerOutstandingReport = asyncHandler(async (req, res) => {
  const result = await pharmacyReportsService.getCustomerOutstandingReport({
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    ...req.query,
  });
  return res.status(200).json(new ApiResponse(200, "Customer outstanding report fetched successfully", result));
});

export const getSupplierPayablesReport = asyncHandler(async (req, res) => {
  const result = await pharmacyReportsService.getSupplierPayablesReport({
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    ...req.query,
  });
  return res.status(200).json(new ApiResponse(200, "Supplier payables report fetched successfully", result));
});

export const getPurchaseRegisterReport = asyncHandler(async (req, res) => {
  const result = await pharmacyReportsService.getPurchaseRegisterReport({
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    branchId: req.query.branchId || req.branchId,
    ...req.query,
  });
  return res.status(200).json(new ApiResponse(200, "Purchase register report fetched successfully", result));
});

export const getDoctorReferralReport = asyncHandler(async (req, res) => {
  const result = await pharmacyReportsService.getDoctorReferralReport({
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    branchId: req.query.branchId || req.branchId,
    ...req.query,
  });
  return res.status(200).json(new ApiResponse(200, "Doctor prescription analytics fetched successfully", result));
});

export const getScheduleHRegisterReport = asyncHandler(async (req, res) => {
  const result = await pharmacyReportsService.getScheduleHRegisterReport({
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    branchId: req.query.branchId || req.branchId,
    ...req.query,
  });
  return res.status(200).json(new ApiResponse(200, "Schedule H register fetched successfully", result));
});

export const getUpiSettlementReport = asyncHandler(async (req, res) => {
  const result = await pharmacyReportsService.getUpiSettlementReport({
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    branchId: req.query.branchId || req.branchId,
    ...req.query,
  });
  return res.status(200).json(new ApiResponse(200, "UPI settlement report fetched successfully", result));
});

export const getCashRegisterTallyReport = asyncHandler(async (req, res) => {
  const result = await pharmacyReportsService.getCashRegisterTallyReport({
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    branchId: req.query.branchId || req.branchId,
    date: req.query.date,
  });
  return res.status(200).json(new ApiResponse(200, "Cash register tally fetched successfully", result));
});
