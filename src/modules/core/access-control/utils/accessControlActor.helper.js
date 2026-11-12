// src/modules/core/access-control/utils/accessControlActor.helper.js

import ApiError from "../../../../utils/ApiError.js";
import hasPermission from "../../../../utils/hasPermission.js";

import workspaceRepository from "../../../organization/workspaces/repositories/workspace.repository.js";
import roleRepository from "../repositories/role.repository.js";
import { ALL_PERMISSIONS } from "../constants/permission.constant.js";
import {
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_STATUS,
} from "../../../organization/workspaces/constants/workspace.constant.js";
import {
  canActorManageRoleSpec,
  resolveEffectiveWorkAccess,
} from "./workAccess.helper.js";

export const ensureWorkspaceMemberActor = async (
  workspaceId,
  userId,
  {
    requiredPermissions = [],
    requireAll = false,
    forbiddenMessage = "You do not have permission to perform this action",
  } = {},
) => {
  const workspace = await workspaceRepository.findWorkspaceById(workspaceId);

  if (!workspace || workspace.status === WORKSPACE_STATUS.DELETED) {
    throw new ApiError(404, "Workspace not found");
  }

  if (workspace.status !== WORKSPACE_STATUS.ACTIVE) {
    throw new ApiError(403, "Workspace is not active");
  }

  const member = await workspaceRepository.findWorkspaceMember(
    workspaceId,
    userId,
    { populate: "roleId" },
  );

  if (!member || member.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
    throw new ApiError(403, "You do not have access to this workspace");
  }

  const isOwner = Boolean(member.isOwner);
  const actorRole = member.roleId || null;
  const actorPermissions = isOwner
    ? ALL_PERMISSIONS
    : actorRole?.permissions || [];

  const actorWorkAccess = resolveEffectiveWorkAccess({
    role: actorRole,
    permissions: actorPermissions,
    isOwner,
  });

  if (!isOwner && requiredPermissions.length > 0) {
    const allowed = hasPermission(actorPermissions, requiredPermissions, {
      requireAll,
    });
    if (!allowed) {
      throw new ApiError(403, forbiddenMessage);
    }
  }

  return {
    workspace,
    member,
    isOwner,
    actorRole,
    actorPermissions,
    actorWorkAccess,
  };
};

export const assertActorCanAssignRoleIds = async ({
  workspaceId,
  actor,
  roleIds = [],
}) => {
  const uniqueIds = Array.from(
    new Set(
      (roleIds || [])
        .map((id) => String(id?._id || id || "").trim())
        .filter(Boolean),
    ),
  );

  for (const roleId of uniqueIds) {
    const role = await roleRepository.findRoleByIdAndWorkspace(roleId, workspaceId);
    if (!role) {
      throw new ApiError(404, "Selected role not found");
    }

    if (actor?.isOwner) continue;

    const targetWorkAccess = resolveEffectiveWorkAccess({ role });
    const check = canActorManageRoleSpec({
      actorIsOwner: Boolean(actor?.isOwner),
      actorWorkAccess: actor?.actorWorkAccess,
      actorPermissions: actor?.actorPermissions || [],
      targetWorkModes: targetWorkAccess.allowedWorkModes,
      targetWorkLevel: targetWorkAccess.highestWorkLevel,
      targetPermissions: role.permissions || [],
      targetRoleCode: role.code,
    });

    if (!check.allowed) {
      throw new ApiError(403, check.message);
    }
  }
};

export default ensureWorkspaceMemberActor;
