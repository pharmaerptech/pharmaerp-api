// src/modules/core/access-control/services/memberAccess.service.js

import ApiError from "../../../../utils/ApiError.js";

import memberAccessRepository from "../repositories/memberAccess.repository.js";
import workspaceRepository from "../../../organization/workspaces/repositories/workspace.repository.js";
import companyRepository from "../../../organization/companies/repositories/company.repository.js";
import branchRepository from "../../../organization/branches/repositories/branch.repository.js";
import userRepository from "../../users/repositories/user.repository.js";

import { WORKSPACE_MEMBER_STATUS } from "../../../organization/workspaces/constants/workspace.constant.js";
import { COMPANY_STATUS } from "../../../organization/companies/constants/company.constant.js";
import { BRANCH_STATUS } from "../../../organization/branches/constants/branch.constant.js";
import { ALL_PERMISSIONS, PERMISSIONS } from "../constants/permission.constant.js";
import {
  assertActorCanAssignRoleIds,
  ensureWorkspaceMemberActor,
} from "../utils/accessControlActor.helper.js";
import { resolveEffectiveWorkAccess } from "../utils/workAccess.helper.js";

const normalizeIds = (ids = []) => {
  if (!ids) return [];

  if (!Array.isArray(ids)) {
    return [ids];
  }

  return ids;
};

const validateCompanies = async (workspaceId, companyIds = []) => {
  for (const companyId of companyIds) {
    const company = await companyRepository.findCompanyByIdAndWorkspace(
      companyId,
      workspaceId,
    );

    if (!company || company.status === COMPANY_STATUS.DELETED) {
      throw new ApiError(404, "Company not found");
    }

    if (company.status !== COMPANY_STATUS.ACTIVE) {
      throw new ApiError(400, "Company is not active");
    }
  }
};

const validateBranches = async (workspaceId, branchIds = []) => {
  for (const branchId of branchIds) {
    const branch = await branchRepository.findBranchById(branchId);

    if (!branch || branch.status === BRANCH_STATUS.DELETED) {
      throw new ApiError(404, "Branch not found");
    }

    if (branch.workspaceId.toString() !== workspaceId.toString()) {
      throw new ApiError(403, "Branch does not belong to this workspace");
    }

    if (branch.status !== BRANCH_STATUS.ACTIVE) {
      throw new ApiError(400, "Branch is not active");
    }
  }
};

const createDefaultAccessForMember = async ({
  workspaceId,
  workspaceMemberId,
  userId,
  createdBy,
  accessAllCompanies = true,
  accessAllBranches = true,
  companyIds = [],
  branchIds = [],
  branchAccess = [],
}) => {
  const normalizedBranchIds = normalizeIds(branchIds);
  const normalizedBranchAccess = Array.isArray(branchAccess) ? branchAccess : [];

  const allBranchIds =
    normalizedBranchIds.length > 0
      ? normalizedBranchIds
      : normalizedBranchAccess.map((ba) => ba.branchId).filter(Boolean);

  return memberAccessRepository.upsertMemberAccess({
    workspaceId,
    workspaceMemberId,
    userId,

    accessAllCompanies,
    accessAllBranches,

    companyIds: normalizeIds(companyIds),
    branchIds: allBranchIds,
    branchAccess: normalizedBranchAccess,

    createdBy,
    updatedBy: createdBy,
  });
};

const toSafeRole = (roleDoc) => {
  if (!roleDoc) return null;
  return roleDoc.toSafeObject ? roleDoc.toSafeObject() : roleDoc;
};

const getMemberAccess = async (
  workspaceId,
  userId,
  memberUserId,
  options = {},
) => {
  const actor = await ensureWorkspaceMemberActor(workspaceId, userId);

  // Only owners/admins with member view rights can inspect other members' access
  if (
    String(userId) !== String(memberUserId) &&
    !actor.isOwner &&
    !actor.actorPermissions.includes("*") &&
    !actor.actorPermissions.includes(PERMISSIONS.MEMBER_ACCESS_VIEW) &&
    !actor.actorPermissions.includes(PERMISSIONS.WORKSPACE_MEMBER_VIEW)
  ) {
    throw new ApiError(403, "You do not have permission to view member access");
  }

  const member = await workspaceRepository.findWorkspaceMember(
    workspaceId,
    memberUserId,
    { populate: "roleId" },
  );

  if (!member) {
    throw new ApiError(404, "Workspace member not found");
  }

  let access = await memberAccessRepository.findMemberAccessByMemberId(
    member._id,
    {
      populate: "companyIds branchIds branchAccess.branchId branchAccess.roleId",
    },
  );

  if (!access) {
    access = await memberAccessRepository.findMemberAccessByUserAndWorkspace(
      workspaceId,
      member.userId?._id || member.userId,
      {
        populate: "companyIds branchIds branchAccess.branchId branchAccess.roleId",
      },
    );
  }

  const isOwner = Boolean(member.isOwner);
  const primaryRole = toSafeRole(member.roleId);
  const primaryPermissions = isOwner
    ? ALL_PERMISSIONS
    : primaryRole?.permissions || [];

  const workAccess = resolveEffectiveWorkAccess({
    role: primaryRole,
    permissions: primaryPermissions,
    isOwner,
  });

  // Optional branch override inspection (never escalates level ceiling beyond primary role)
  let activeRole = primaryRole;
  let permissions = primaryPermissions;
  const activeBranchId = options?.branchId ? String(options.branchId).trim() : null;

  if (!isOwner && activeBranchId && Array.isArray(access?.branchAccess)) {
    const branchMatch = access.branchAccess.find(
      (ba) =>
        String(ba.branchId?._id || ba.branchId || "") === activeBranchId &&
        ba.roleId,
    );
    if (branchMatch?.roleId) {
      const overrideRole = toSafeRole(branchMatch.roleId);
      if (overrideRole) {
        activeRole = overrideRole;
        permissions = overrideRole.permissions || [];
      }
    }
  }

  const roleWithWorkAccess = activeRole
    ? {
        ...activeRole,
        workModes: workAccess.allowedWorkModes,
        workLevel: workAccess.highestWorkLevel,
        allowedWorkLevels: workAccess.allowedWorkLevels,
        workAccess,
      }
    : null;

  if (!access) {
    return {
      workspaceId,
      workspaceMemberId: member._id,
      userId: member.userId?._id || member.userId,
      accessAllCompanies: true,
      accessAllBranches: true,
      companyIds: [],
      branchIds: [],
      branchAccess: [],
      companies: [],
      branches: [],
      role: roleWithWorkAccess,
      permissions,
      isOwner,
      workAccess,
    };
  }

  const safeAccess = access.toSafeObject ? access.toSafeObject() : access;

  return {
    ...safeAccess,
    companies: safeAccess.companyIds || [],
    branches: safeAccess.branchIds || [],
    role: roleWithWorkAccess,
    permissions,
    isOwner,
    workAccess,
  };
};

const getWorkspaceMemberAccessList = async (workspaceId, userId) => {
  await ensureWorkspaceMemberActor(workspaceId, userId, {
    requiredPermissions: [
      PERMISSIONS.MEMBER_ACCESS_VIEW,
      PERMISSIONS.WORKSPACE_MEMBER_VIEW,
    ],
    forbiddenMessage:
      "Only workspace owner or authorized admin can view member access list",
  });

  const accessList = await memberAccessRepository.getWorkspaceMemberAccessList(
    workspaceId,
    {
      populate: [
        { path: "workspaceMemberId", populate: { path: "roleId" } },
        "userId",
        "companyIds",
        "branchIds",
        "branchAccess.branchId",
        "branchAccess.roleId",
      ],
    },
  );

  return accessList.map((access) => {
    const safeObj = access.toSafeObject();
    const memberRole = toSafeRole(safeObj.workspaceMemberId?.roleId);
    const memberIsOwner = Boolean(safeObj.workspaceMemberId?.isOwner);
    return {
      ...safeObj,
      workAccess: resolveEffectiveWorkAccess({
        role: memberRole,
        permissions: memberRole?.permissions || [],
        isOwner: memberIsOwner,
      }),
    };
  });
};

const updateMemberAccess = async (
  workspaceId,
  userId,
  memberUserId,
  payload,
) => {
  const actor = await ensureWorkspaceMemberActor(workspaceId, userId, {
    requiredPermissions: [
      PERMISSIONS.MEMBER_ACCESS_UPDATE,
      PERMISSIONS.WORKSPACE_MEMBER_UPDATE,
    ],
    forbiddenMessage:
      "Only workspace owner or authorized admin can manage member access",
  });

  const member = await workspaceRepository.findWorkspaceMember(
    workspaceId,
    memberUserId,
    { populate: "roleId" },
  );

  if (!member) {
    throw new ApiError(404, "Workspace member not found");
  }

  if (member.isOwner) {
    throw new ApiError(400, "Workspace owner already has full access");
  }

  if (member.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
    throw new ApiError(400, "Workspace member is not active");
  }

  const accessAllCompanies = Boolean(payload.accessAllCompanies);
  const rawCompanyIds = accessAllCompanies ? [] : normalizeIds(payload.companyIds);

  const hasCompanyAccessScope = accessAllCompanies || rawCompanyIds.length > 0;
  const accessAllBranches = hasCompanyAccessScope
    ? Boolean(payload.accessAllBranches)
    : false;

  const companyIds = rawCompanyIds;
  const branchAccess =
    hasCompanyAccessScope && Array.isArray(payload.branchAccess)
      ? payload.branchAccess
      : [];

  let branchIds =
    hasCompanyAccessScope && !accessAllBranches
      ? normalizeIds(payload.branchIds)
      : [];
  if (
    hasCompanyAccessScope &&
    !accessAllBranches &&
    branchIds.length === 0 &&
    branchAccess.length > 0
  ) {
    branchIds = branchAccess.map((item) => item.branchId).filter(Boolean);
  }

  if (!actor.isOwner && branchAccess.length > 0) {
    await assertActorCanAssignRoleIds({
      workspaceId,
      actor,
      roleIds: branchAccess.map((item) => item?.roleId).filter(Boolean),
    });
  }

  await validateCompanies(workspaceId, companyIds);
  await validateBranches(workspaceId, branchIds);

  const access = await memberAccessRepository.upsertMemberAccess({
    workspaceId,
    workspaceMemberId: member._id,
    userId: member.userId,

    accessAllCompanies,
    accessAllBranches,

    companyIds,
    branchIds,
    branchAccess,

    updatedBy: userId,
    createdBy: userId,
  });

  // Auto-clear member's active company and branch context if access was removed
  try {
    const targetUserId = member.userId?._id || member.userId;
    if (targetUserId) {
      const user = await userRepository.findUserById(targetUserId);
      if (
        user?.activeContext?.workspaceId &&
        user.activeContext.workspaceId.toString() === workspaceId.toString()
      ) {
        let contextNeedsUpdate = false;
        let activeCompanyId = user.activeContext.companyId;
        let activeBranchId = user.activeContext.branchId;

        if (activeCompanyId) {
          const stillHasCompany = await memberAccessRepository.hasCompanyAccess(
            workspaceId,
            targetUserId,
            activeCompanyId,
          );
          if (!stillHasCompany) {
            activeCompanyId = null;
            activeBranchId = null;
            contextNeedsUpdate = true;
          }
        }

        if (activeBranchId) {
          const stillHasBranch = await memberAccessRepository.hasBranchAccess(
            workspaceId,
            targetUserId,
            activeBranchId,
          );
          if (!stillHasBranch) {
            activeBranchId = null;
            contextNeedsUpdate = true;
          }
        }

        if (contextNeedsUpdate) {
          await userRepository.updateActiveContext(targetUserId, {
            workspaceId: user.activeContext.workspaceId,
            companyId: activeCompanyId,
            branchId: activeBranchId,
          });
        }
      }
    }
  } catch (err) {
    console.error("Failed to auto-clean revoked active context for member:", err);
  }

  return access.toSafeObject();
};

const hasCompanyAccess = async (workspaceId, userId, companyId) => {
  const member = await workspaceRepository.findWorkspaceMember(
    workspaceId,
    userId,
  );

  if (!member || member.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
    return false;
  }

  if (member.isOwner) {
    return true;
  }

  return memberAccessRepository.hasCompanyAccess(
    workspaceId,
    userId,
    companyId,
  );
};

const hasBranchAccess = async (workspaceId, userId, branchId) => {
  const member = await workspaceRepository.findWorkspaceMember(
    workspaceId,
    userId,
  );

  if (!member || member.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
    return false;
  }

  if (member.isOwner) {
    return true;
  }

  return memberAccessRepository.hasBranchAccess(workspaceId, userId, branchId);
};

export default {
  createDefaultAccessForMember,

  getMemberAccess,
  getWorkspaceMemberAccessList,
  updateMemberAccess,

  hasCompanyAccess,
  hasBranchAccess,
};
