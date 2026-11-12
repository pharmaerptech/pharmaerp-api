// src/modules/core/access-control/services/role.service.js

import ApiError from "../../../../utils/ApiError.js";

import roleRepository from "../repositories/role.repository.js";
import workspaceRepository from "../../../organization/workspaces/repositories/workspace.repository.js";

import {
  SYSTEM_ROLES,
  SYSTEM_ROLE_LABELS,
  SYSTEM_ROLE_DESCRIPTIONS,
  ROLE_STATUS,
} from "../constants/role.constant.js";

import {
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_ROLE_WORK_ACCESS,
  ALL_PERMISSIONS,
  PERMISSIONS,
} from "../constants/permission.constant.js";

import { WORKSPACE_MEMBER_STATUS } from "../../../organization/workspaces/constants/workspace.constant.js";

import { ensureWorkspaceMemberActor } from "../utils/accessControlActor.helper.js";
import {
  canActorManageRoleSpec,
  normalizeRoleWorkAccess,
  resolveEffectiveWorkAccess,
} from "../utils/workAccess.helper.js";

const createCode = (name) => {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
};

const toEnrichedRoleObject = (roleDoc) => {
  const roleSafe = roleDoc?.toSafeObject ? roleDoc.toSafeObject() : { ...roleDoc };
  const workAccess = resolveEffectiveWorkAccess({
    role: roleSafe,
    permissions: roleSafe?.permissions,
    isOwner: roleSafe?.code === SYSTEM_ROLES.OWNER,
  });

  return {
    ...roleSafe,
    workModes: workAccess.allowedWorkModes,
    workLevel: workAccess.highestWorkLevel,
    allowedWorkLevels: workAccess.allowedWorkLevels,
    workAccess,
  };
};

const createDefaultRolesForWorkspace = async (workspaceId, userId) => {
  const createdRoles = [];

  for (const roleCode of Object.values(SYSTEM_ROLES)) {
    const existingRole = await roleRepository.findRoleByCode(
      workspaceId,
      roleCode,
    );

    if (existingRole) {
      createdRoles.push(existingRole);
      continue;
    }

    const defaultWorkAccess = DEFAULT_ROLE_WORK_ACCESS[roleCode] || {};
    const normalized = normalizeRoleWorkAccess({
      permissions: DEFAULT_ROLE_PERMISSIONS[roleCode] || [],
      workModes: defaultWorkAccess.workModes,
      workLevel: defaultWorkAccess.workLevel,
      roleCode,
    });

    const role = await roleRepository.createRole({
      workspaceId,
      name: SYSTEM_ROLE_LABELS[roleCode],
      code: roleCode,
      description: SYSTEM_ROLE_DESCRIPTIONS[roleCode],
      workModes: normalized.workModes,
      workLevel: normalized.workLevel,
      permissions: normalized.syncedPermissions,
      isSystem: true,
      isEditable: roleCode !== SYSTEM_ROLES.OWNER,
      status: ROLE_STATUS.ACTIVE,
      createdBy: userId,
    });

    createdRoles.push(role);
  }

  return createdRoles.map((role) => toEnrichedRoleObject(role));
};

const getOwnerRoleForWorkspace = async (workspaceId) => {
  return roleRepository.findRoleByCode(workspaceId, SYSTEM_ROLES.OWNER);
};

const getRoleByCodeForWorkspace = async (workspaceId, code) => {
  return roleRepository.findRoleByCode(workspaceId, code);
};

const findRoleById = async (roleId, workspaceId) => {
  if (!roleId || !workspaceId) return null;
  return roleRepository.findRoleByIdAndWorkspace(roleId, workspaceId);
};

const getStaffRoleForWorkspace = async (workspaceId) => {
  let role = await roleRepository.findRoleByCode(
    workspaceId,
    SYSTEM_ROLES.STAFF,
  );
  if (!role) {
    role = await roleRepository.findRoleByCode(
      workspaceId,
      SYSTEM_ROLES.PHARMACIST,
    );
  }
  if (!role) {
    const roles = await roleRepository.getWorkspaceRoles(workspaceId);
    role =
      roles.find((r) => r.code !== SYSTEM_ROLES.OWNER) || roles[0] || null;
  }
  return role;
};

const createRole = async (workspaceId, userId, payload) => {
  const actor = await ensureWorkspaceMemberActor(workspaceId, userId, {
    requiredPermissions: [PERMISSIONS.ROLE_CREATE],
    forbiddenMessage: "Only workspace owner or authorized admin can create roles",
  });

  const code = payload.code || createCode(payload.name);

  if (code === SYSTEM_ROLES.OWNER) {
    throw new ApiError(400, "Owner role code is reserved");
  }

  const existingRole = await roleRepository.findRoleByCode(workspaceId, code);

  if (existingRole) {
    throw new ApiError(400, "Role with this code already exists");
  }

  const normalized = normalizeRoleWorkAccess({
    permissions: payload.permissions || [],
    workModes: payload.workModes,
    workLevel: payload.workLevel,
    roleCode: code,
  });

  const manageCheck = canActorManageRoleSpec({
    actorIsOwner: actor.isOwner,
    actorWorkAccess: actor.actorWorkAccess,
    actorPermissions: actor.actorPermissions,
    targetWorkModes: normalized.workModes,
    targetWorkLevel: normalized.workLevel,
    targetPermissions: normalized.syncedPermissions,
    targetRoleCode: code,
  });

  if (!manageCheck.allowed) {
    throw new ApiError(403, manageCheck.message);
  }

  const role = await roleRepository.createRole({
    workspaceId,
    name: payload.name,
    code,
    description: payload.description,
    workModes: normalized.workModes,
    workLevel: normalized.workLevel,
    permissions: normalized.syncedPermissions,
    isSystem: false,
    isEditable: true,
    status: ROLE_STATUS.ACTIVE,
    createdBy: userId,
  });

  return toEnrichedRoleObject(role);
};

const getWorkspaceRoles = async (workspaceId, userId) => {
  await ensureWorkspaceMemberActor(workspaceId, userId);

  const [roles, members] = await Promise.all([
    roleRepository.getWorkspaceRoles(workspaceId),
    workspaceRepository.getWorkspaceMembers(workspaceId).catch(() => []),
  ]);

  return roles.map((role) => {
    const roleSafe = toEnrichedRoleObject(role);
    const strRoleId = String(role._id);
    const isOwnerRole = role.code === SYSTEM_ROLES.OWNER;
    const assignedMembers = (members || []).filter((m) => {
      if (isOwnerRole && m.isOwner) return true;
      const mRoleId = String(m.roleId?._id || m.roleId || "");
      return mRoleId === strRoleId;
    });

    roleSafe.membersCount = assignedMembers.length;
    return roleSafe;
  });
};

const getRoleById = async (roleId, workspaceId, userId) => {
  await ensureWorkspaceMemberActor(workspaceId, userId);

  const [role, members] = await Promise.all([
    roleRepository.findRoleByIdAndWorkspace(roleId, workspaceId),
    workspaceRepository.getWorkspaceMembers(workspaceId).catch(() => []),
  ]);

  if (!role) {
    throw new ApiError(404, "Role not found");
  }

  const roleSafe = toEnrichedRoleObject(role);
  const strRoleId = String(role._id);
  const isOwnerRole = role.code === SYSTEM_ROLES.OWNER;
  const assignedMembers = (members || []).filter((m) => {
    if (isOwnerRole && m.isOwner) return true;
    const mRoleId = String(m.roleId?._id || m.roleId || "");
    return mRoleId === strRoleId;
  });

  roleSafe.membersCount = assignedMembers.length;
  roleSafe.assignedMembers = assignedMembers;
  return roleSafe;
};

const updateRole = async (roleId, workspaceId, userId, payload) => {
  const actor = await ensureWorkspaceMemberActor(workspaceId, userId, {
    requiredPermissions: [PERMISSIONS.ROLE_UPDATE],
    forbiddenMessage: "Only workspace owner or authorized admin can update roles",
  });

  const role = await roleRepository.findRoleByIdAndWorkspace(
    roleId,
    workspaceId,
  );

  if (!role) {
    throw new ApiError(404, "Role not found");
  }

  if (role.code === SYSTEM_ROLES.OWNER) {
    throw new ApiError(400, "Owner role cannot be updated");
  }

  if (!role.isEditable) {
    throw new ApiError(400, "This role cannot be updated");
  }

  const actorRoleId = String(actor.member?.roleId?._id || actor.member?.roleId || "");
  if (!actor.isOwner && actorRoleId && actorRoleId === String(role._id)) {
    throw new ApiError(403, "You cannot modify your own assigned role");
  }

  if (payload.name !== undefined) role.name = payload.name;
  if (payload.description !== undefined) role.description = payload.description;
  if (payload.status !== undefined) role.status = payload.status;

  const hasAccessChanges =
    payload.permissions !== undefined ||
    payload.workModes !== undefined ||
    payload.workLevel !== undefined;

  if (hasAccessChanges) {
    const normalized = normalizeRoleWorkAccess({
      permissions:
        payload.permissions !== undefined ? payload.permissions : role.permissions,
      workModes:
        payload.workModes !== undefined
          ? payload.workModes
          : payload.permissions !== undefined
            ? undefined
            : role.workModes,
      workLevel:
        payload.workLevel !== undefined
          ? payload.workLevel
          : payload.permissions !== undefined
            ? undefined
            : role.workLevel,
      roleCode: role.code,
    });

    const manageCheck = canActorManageRoleSpec({
      actorIsOwner: actor.isOwner,
      actorWorkAccess: actor.actorWorkAccess,
      actorPermissions: actor.actorPermissions,
      targetWorkModes: normalized.workModes,
      targetWorkLevel: normalized.workLevel,
      targetPermissions: normalized.syncedPermissions,
      targetRoleCode: role.code,
    });

    if (!manageCheck.allowed) {
      throw new ApiError(403, manageCheck.message);
    }

    role.workModes = normalized.workModes;
    role.workLevel = normalized.workLevel;
    role.permissions = normalized.syncedPermissions;
  }

  await roleRepository.saveRole(role);

  return toEnrichedRoleObject(role);
};

const deleteRole = async (roleId, workspaceId, userId) => {
  const actor = await ensureWorkspaceMemberActor(workspaceId, userId, {
    requiredPermissions: [PERMISSIONS.ROLE_DELETE],
    forbiddenMessage: "Only workspace owner or authorized admin can delete roles",
  });

  const role = await roleRepository.findRoleByIdAndWorkspace(
    roleId,
    workspaceId,
  );

  if (!role) {
    throw new ApiError(404, "Role not found");
  }

  if (role.isSystem) {
    throw new ApiError(400, "System role cannot be deleted");
  }

  const targetWorkAccess = resolveEffectiveWorkAccess({ role });
  const manageCheck = canActorManageRoleSpec({
    actorIsOwner: actor.isOwner,
    actorWorkAccess: actor.actorWorkAccess,
    actorPermissions: actor.actorPermissions,
    targetWorkModes: targetWorkAccess.allowedWorkModes,
    targetWorkLevel: targetWorkAccess.highestWorkLevel,
    targetPermissions: role.permissions || [],
    targetRoleCode: role.code,
  });

  if (!manageCheck.allowed) {
    throw new ApiError(403, "You cannot delete a role with higher privileges than yours");
  }

  const deletedRole = await roleRepository.deleteRoleById(
    roleId,
    workspaceId,
    userId,
  );

  if (!deletedRole) {
    throw new ApiError(404, "Role not found");
  }

  return {
    success: true,
  };
};

const assignRoleToMember = async (
  workspaceId,
  userId,
  memberUserId,
  roleId,
) => {
  const actor = await ensureWorkspaceMemberActor(workspaceId, userId, {
    requiredPermissions: [
      PERMISSIONS.ROLE_UPDATE,
      PERMISSIONS.MEMBER_ACCESS_UPDATE,
      PERMISSIONS.WORKSPACE_MEMBER_UPDATE,
    ],
    forbiddenMessage: "Only workspace owner or authorized admin can assign roles",
  });

  if (!actor.isOwner && String(userId) === String(memberUserId)) {
    throw new ApiError(403, "You cannot change your own role");
  }

  const member = await workspaceRepository.findWorkspaceMember(
    workspaceId,
    memberUserId,
  );

  if (!member) {
    throw new ApiError(404, "Workspace member not found");
  }

  if (member.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
    throw new ApiError(400, "Workspace member is not active");
  }

  if (member.isOwner) {
    throw new ApiError(400, "Workspace owner role cannot be changed");
  }

  const role = await roleRepository.findRoleByIdAndWorkspace(
    roleId,
    workspaceId,
  );

  if (!role) {
    throw new ApiError(404, "Role not found");
  }

  if (role.status !== ROLE_STATUS.ACTIVE) {
    throw new ApiError(400, "Role is not active");
  }

  const targetWorkAccess = resolveEffectiveWorkAccess({ role });
  const manageCheck = canActorManageRoleSpec({
    actorIsOwner: actor.isOwner,
    actorWorkAccess: actor.actorWorkAccess,
    actorPermissions: actor.actorPermissions,
    targetWorkModes: targetWorkAccess.allowedWorkModes,
    targetWorkLevel: targetWorkAccess.highestWorkLevel,
    targetPermissions: role.permissions || [],
    targetRoleCode: role.code,
  });

  if (!manageCheck.allowed) {
    throw new ApiError(403, manageCheck.message);
  }

  member.roleId = role._id;

  await workspaceRepository.saveWorkspaceMember(member);

  return member.toSafeObject();
};

const getAvailablePermissions = () => {
  return ALL_PERMISSIONS;
};

export default {
  createDefaultRolesForWorkspace,
  getOwnerRoleForWorkspace,
  getRoleByCodeForWorkspace,
  findRoleById,
  getStaffRoleForWorkspace,

  createRole,
  getWorkspaceRoles,
  getRoleById,
  updateRole,
  deleteRole,

  assignRoleToMember,

  getAvailablePermissions,
};
