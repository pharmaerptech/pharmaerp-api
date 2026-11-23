import asyncHandler from "../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../utils/ApiResponse.js";

import branchService from "../services/branch.service.js";
import Workspace from "../../workspaces/models/workspace.model.js";

export const createBranch = asyncHandler(async (req, res) => {
  const branch = await branchService.createBranch(
    req.workspaceId,
    req.companyId,
    req.user._id,
    req.body,
  );

  // Flip setup flag on first branch only — no-op if already true
  await Workspace.findOneAndUpdate(
    { _id: req.workspaceId, "setupStatus.branch": false },
    { $set: { "setupStatus.branch": true } },
  );

  return res
    .status(201)
    .json(new ApiResponse(201, "Branch created successfully", branch));
});

export const getCompanyBranches = asyncHandler(async (req, res) => {
  const branches = await branchService.getCompanyBranches(
    req.companyId,
    req.workspaceId,
    req.user._id,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Branches fetched successfully", branches));
});

export const getWorkspaceBranches = asyncHandler(async (req, res) => {
  const branches = await branchService.getWorkspaceBranches(
    req.workspaceId,
    req.user._id,
    {
      companyId: req.query.companyId,
      includeAll: req.query.includeAll === "true" || req.query.forShipping === "true",
      forShipping: req.query.forShipping === "true",
    }
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, "Workspace branches fetched successfully", branches),
    );
});

export const getBranchById = asyncHandler(async (req, res) => {
  const branch = await branchService.getBranchById(
    req.params.branchId,
    req.companyId,
    req.workspaceId,
    req.user._id,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Branch fetched successfully", branch));
});

export const updateBranch = asyncHandler(async (req, res) => {
  const branch = await branchService.updateBranch(
    req.params.branchId,
    req.companyId,
    req.workspaceId,
    req.user._id,
    req.body,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Branch updated successfully", branch));
});

export const getBranchMembers = asyncHandler(async (req, res) => {
  const members = await branchService.getBranchMembers(
    req.params.branchId,
    req.workspaceId,
    req.user._id,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Branch members fetched successfully", members));
});

export const deleteBranch = asyncHandler(async (req, res) => {
  await branchService.deleteBranch(
    req.params.branchId,
    req.companyId,
    req.workspaceId,
    req.user._id,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Branch deleted successfully"));
});
