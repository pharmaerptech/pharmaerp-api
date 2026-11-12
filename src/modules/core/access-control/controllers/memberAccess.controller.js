// src/modules/core/access-control/controllers/memberAccess.controller.js

import asyncHandler from "../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../utils/ApiResponse.js";

import memberAccessService from "../services/memberAccess.service.js";

export const getMemberAccess = asyncHandler(async (req, res) => {
  const memberUserId =
    req.params.memberUserId === "me" || !req.params.memberUserId
      ? req.user._id
      : req.params.memberUserId;

  const access = await memberAccessService.getMemberAccess(
    req.workspaceId,
    req.user._id,
    memberUserId,
    { branchId: req.headers["x-branch-id"] || req.query?.branchId || null },
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Member access fetched successfully", access));
});

export const getWorkspaceMemberAccessList = asyncHandler(async (req, res) => {
  const accessList = await memberAccessService.getWorkspaceMemberAccessList(
    req.workspaceId,
    req.user._id,
  );

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        "Workspace member access list fetched successfully",
        accessList,
      ),
    );
});

export const updateMemberAccess = asyncHandler(async (req, res) => {
  const access = await memberAccessService.updateMemberAccess(
    req.workspaceId,
    req.user._id,
    req.params.memberUserId,
    req.body,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Member access updated successfully", access));
});

export const checkCompanyAccess = asyncHandler(async (req, res) => {
  const hasAccess = await memberAccessService.hasCompanyAccess(
    req.workspaceId,
    req.user._id,
    req.params.companyId,
  );

  return res.status(200).json(
    new ApiResponse(200, "Company access checked successfully", {
      hasAccess,
    }),
  );
});

export const checkBranchAccess = asyncHandler(async (req, res) => {
  const hasAccess = await memberAccessService.hasBranchAccess(
    req.workspaceId,
    req.user._id,
    req.params.branchId,
  );

  return res.status(200).json(
    new ApiResponse(200, "Branch access checked successfully", {
      hasAccess,
    }),
  );
});
