import asyncHandler from "../../../utils/asyncHandler.js";
import ApiResponse from "../../../utils/ApiResponse.js";
import dashboardService from "../services/dashboard.service.js";

export const getDashboardOverview = asyncHandler(async (req, res) => {
  const branchId =
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.query.branchId ||
    null;

  const data = await dashboardService.getDashboardOverview({
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    branchId,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Dashboard overview fetched successfully", data));
});

export const getBranchDashboard = asyncHandler(async (req, res) => {
  const branchId =
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.query.branchId ||
    null;

  const date = req.query.date || null;

  const data = await dashboardService.getBranchDashboardData({
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    branchId,
    date,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Branch dashboard fetched successfully", data));
});

export const getCompanyDashboard = asyncHandler(async (req, res) => {
  const companyId =
    req.headers["x-company-id"] ||
    req.companyId ||
    req.query.companyId ||
    null;

  const timeframe = req.query.timeframe || "THIS_MONTH";

  const data = await dashboardService.getCompanyDashboardData({
    workspaceId: req.workspaceId,
    companyId,
    timeframe,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Company dashboard fetched successfully", data));
});

export const getWorkspaceDashboard = asyncHandler(async (req, res) => {
  const timeframe = req.query.timeframe || "THIS_MONTH";

  const data = await dashboardService.getWorkspaceDashboardData({
    workspaceId: req.workspaceId,
    timeframe,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Workspace dashboard fetched successfully", data));
});

export default {
  getDashboardOverview,
  getBranchDashboard,
  getCompanyDashboard,
  getWorkspaceDashboard,
};
