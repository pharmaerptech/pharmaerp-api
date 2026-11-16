import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";

import companyRepository from "../modules/organization/companies/repositories/company.repository.js";
import memberAccessService from "../modules/core/access-control/services/memberAccess.service.js";

import { COMPANY_STATUS } from "../modules/organization/companies/constants/company.constant.js";

const getCompanyIdFromRequest = (req) => {
  return (
    req.headers["x-company-id"] ||
    req.params.companyId ||
    req.query.companyId ||
    req.body.companyId ||
    null
  );
};

const companyContextMiddleware = asyncHandler(async (req, res, next) => {
  const companyId = getCompanyIdFromRequest(req);

  if (!req.workspaceId) {
    throw new ApiError(400, "Workspace context is required");
  }

  // If request is from Workspace Level (or explicit "all" scope) and no specific company is selected
  const isWorkspaceLevel =
    req.headers["x-work-level"] === "workspace" ||
    req.query.scope === "workspace";

  if (!companyId || companyId === "all" || companyId === "undefined" || companyId === "null") {
    if (isWorkspaceLevel) {
      req.company = null;
      req.companyId = null;
      return next();
    }
    throw new ApiError(400, "Company id is required");
  }

  const company = await companyRepository.findCompanyByIdAndWorkspace(
    companyId,
    req.workspaceId,
  );

  if (!company) {
    throw new ApiError(404, "Company not found");
  }

  if (company.status !== COMPANY_STATUS.ACTIVE) {
    throw new ApiError(403, "Company is not active");
  }

  const hasCompanyAccess = await memberAccessService.hasCompanyAccess(
    req.workspaceId,
    req.user._id,
    company._id,
  );

  if (!hasCompanyAccess) {
    throw new ApiError(403, "You do not have access to this company");
  }

  req.company = company;
  req.companyId = company._id.toString();

  next();
});

export default companyContextMiddleware;
