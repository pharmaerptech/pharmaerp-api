import dashboardRepository from "../repositories/dashboard.repository.js";

const getDashboardOverview = async ({ workspaceId, companyId, branchId = null }) => {
  return dashboardRepository.getDashboardOverview({
    workspaceId,
    companyId,
    branchId,
  });
};

const getBranchDashboardData = async ({ workspaceId, companyId, branchId = null, date = null }) => {
  return dashboardRepository.getBranchDashboardData({
    workspaceId,
    companyId,
    branchId,
    date,
  });
};

const getCompanyDashboardData = async ({ workspaceId, companyId, timeframe = "THIS_MONTH" }) => {
  return dashboardRepository.getCompanyDashboardData({
    workspaceId,
    companyId,
    timeframe,
  });
};

const getWorkspaceDashboardData = async ({ workspaceId, timeframe = "THIS_MONTH" }) => {
  return dashboardRepository.getWorkspaceDashboardData({
    workspaceId,
    timeframe,
  });
};

export default {
  getDashboardOverview,
  getBranchDashboardData,
  getCompanyDashboardData,
  getWorkspaceDashboardData,
};
