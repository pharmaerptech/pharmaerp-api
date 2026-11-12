// src/features/workspace/services/workspace.service.js

import ApiError from "../../../../utils/ApiError.js";

import workspaceRepository from "../repositories/workspace.repository.js";
import workspaceInvitationService from "./workspaceInvitation.service.js";
import roleService from "../../../core/access-control/services/role.service.js";
import memberAccessService from "../../../core/access-control/services/memberAccess.service.js";
import memberAccessRepository from "../../../core/access-control/repositories/memberAccess.repository.js";
import companyRepository from "../../companies/repositories/company.repository.js";
import branchRepository from "../../branches/repositories/branch.repository.js";
import authRepository from "../../../core/auth/repositories/auth.repository.js";

import {
  WORKSPACE_STATUS,
  WORKSPACE_MEMBER_STATUS,
} from "../constants/workspace.constant.js";
import { PERMISSIONS } from "../../../core/access-control/constants/permission.constant.js";
import {
  assertActorCanAssignRoleIds,
  ensureWorkspaceMemberActor,
} from "../../../core/access-control/utils/accessControlActor.helper.js";
import { resolveEffectiveWorkAccess } from "../../../core/access-control/utils/workAccess.helper.js";

const createSlug = (name) => {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const createWorkspace = async (userId, payload) => {
  const { name, type, logo } = payload;

  const slug = createSlug(name);

  const existingWorkspace = await workspaceRepository.findWorkspaceBySlug(slug);

  if (existingWorkspace) {
    throw new ApiError(400, "Workspace with this name already exists");
  }

  const workspace = await workspaceRepository.createWorkspace({
    name,
    slug,
    type,
    ownerId: userId,
    logo,
  });

  await roleService.createDefaultRolesForWorkspace(workspace._id, userId);

  const ownerRole = await roleService.getOwnerRoleForWorkspace(workspace._id);

  if (!ownerRole) {
    throw new ApiError(500, "Owner role could not be created");
  }

  const ownerMember = await workspaceRepository.createWorkspaceMember({
    workspaceId: workspace._id,
    userId,
    roleId: ownerRole._id,
    createdBy: userId,
    status: WORKSPACE_MEMBER_STATUS.ACTIVE,
    isOwner: true,
    isPrimary: true,
  });

  await memberAccessService.createDefaultAccessForMember({
    workspaceId: workspace._id,
    workspaceMemberId: ownerMember._id,
    userId,
    createdBy: userId,
    accessAllCompanies: true,
    accessAllBranches: true,
    companyIds: [],
    branchIds: [],
  });

  return workspace.toSafeObject();
};

const getMyWorkspaces = async (userId) => {
  const members = await workspaceRepository.getUserWorkspaceMembers(userId);

  return members.map((member) => ({
    member: member.toSafeObject(),
    workspace: member.workspaceId?.toSafeObject
      ? member.workspaceId.toSafeObject()
      : member.workspaceId,
  }));
};

const getWorkspaceById = async (workspaceId, userId) => {
  const member = await workspaceRepository.findWorkspaceMember(
    workspaceId,
    userId,
  );

  if (!member || member.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
    throw new ApiError(403, "You do not have access to this workspace");
  }

  const workspace = await workspaceRepository.findWorkspaceById(workspaceId);

  if (!workspace || workspace.status === WORKSPACE_STATUS.DELETED) {
    throw new ApiError(404, "Workspace not found");
  }

  return workspace.toSafeObject();
};

const updateWorkspace = async (workspaceId, userId, payload) => {
  const { workspace } = await ensureWorkspaceMemberActor(workspaceId, userId, {
    requiredPermissions: [PERMISSIONS.WORKSPACE_UPDATE],
    forbiddenMessage: "Only workspace owner or authorized admin can update workspace",
  });

  const allowedFields = ["name", "type", "logo"];

  if (payload.name && payload.name !== workspace.name) {
    const slug = createSlug(payload.name);

    const existingWorkspace =
      await workspaceRepository.findWorkspaceBySlug(slug);

    if (
      existingWorkspace &&
      existingWorkspace._id.toString() !== workspace._id.toString()
    ) {
      throw new ApiError(400, "Workspace with this name already exists");
    }

    workspace.slug = slug;
  }

  allowedFields.forEach((field) => {
    if (payload[field] !== undefined) {
      workspace[field] = payload[field];
    }
  });

  await workspaceRepository.saveWorkspace(workspace);

  return workspace.toSafeObject();
};

const deleteWorkspace = async (workspaceId, userId) => {
  const member = await workspaceRepository.findWorkspaceMember(
    workspaceId,
    userId,
  );

  if (!member || member.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
    throw new ApiError(403, "You do not have access to this workspace");
  }

  if (!member.isOwner) {
    throw new ApiError(403, "Only workspace owner can delete workspace");
  }

  const workspace = await workspaceRepository.deleteWorkspaceById(
    workspaceId,
    userId,
  );

  if (!workspace) {
    throw new ApiError(404, "Workspace not found");
  }

  return {
    success: true,
  };
};

const getWorkspaceMembers = async (workspaceId, userId) => {
  const member = await workspaceRepository.findWorkspaceMember(
    workspaceId,
    userId,
  );

  if (!member || member.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
    throw new ApiError(403, "You do not have access to this workspace");
  }

  const [members, accessList, totalCompanies, totalBranches] = await Promise.all([
    workspaceRepository.getWorkspaceMembers(workspaceId, {
      populate: "roleId userId",
    }),
    memberAccessRepository.getWorkspaceMemberAccessList(workspaceId),
    companyRepository.countWorkspaceCompanies(workspaceId),
    branchRepository.countWorkspaceBranches(workspaceId),
  ]);

  const accessMap = new Map();
  (accessList || []).forEach((acc) => {
    if (acc.workspaceMemberId) {
      accessMap.set(acc.workspaceMemberId.toString(), acc);
    }
    if (acc.userId) {
      accessMap.set(acc.userId.toString(), acc);
    }
  });

  return members.map((workspaceMember) => {
    const safeObj = workspaceMember.toSafeObject();
    const isOwner = Boolean(workspaceMember.isOwner);
    const memberIdStr = workspaceMember._id?.toString();
    const userIdStr = (workspaceMember.userId?._id || workspaceMember.userId)?.toString();
    const access = (memberIdStr && accessMap.get(memberIdStr)) || (userIdStr && accessMap.get(userIdStr)) || null;

    const accessAllCompanies = isOwner ? true : (access ? Boolean(access.accessAllCompanies) : true);
    const accessAllBranches = isOwner ? true : (access ? Boolean(access.accessAllBranches) : true);
    const companyIds = isOwner ? [] : (access?.companyIds || []);
    const branchIds = isOwner ? [] : (access?.branchIds || []);

    const companyCount = (isOwner || accessAllCompanies) ? totalCompanies : (companyIds?.length || 0);
    const branchCount = (isOwner || accessAllBranches) ? totalBranches : (branchIds?.length || 0);

    const roleObj = safeObj.roleId || null;
    const workAccess = resolveEffectiveWorkAccess({
      role: roleObj,
      permissions: roleObj?.permissions || [],
      isOwner,
    });

    return {
      ...safeObj,
      access: access ? (access.toSafeObject ? access.toSafeObject() : access) : null,
      accessAllCompanies,
      accessAllBranches,
      companyIds,
      branchIds,
      companyCount,
      branchCount,
      totalWorkspaceCompanies: totalCompanies,
      totalWorkspaceBranches: totalBranches,
      workAccess,
    };
  });
};

const addWorkspaceMember = async (workspaceId, userId, payload) => {
  return workspaceInvitationService.inviteMember(workspaceId, userId, payload);
};

const updateWorkspaceMemberStatus = async (
  workspaceId,
  userId,
  memberUserId,
  status,
) => {
  await ensureWorkspaceMemberActor(workspaceId, userId, {
    requiredPermissions: [PERMISSIONS.WORKSPACE_MEMBER_UPDATE],
    forbiddenMessage: "Only workspace owner or authorized admin can update members",
  });

  if (userId.toString() === memberUserId.toString()) {
    throw new ApiError(400, "You cannot update your own member status");
  }

  const member = await workspaceRepository.findWorkspaceMember(
    workspaceId,
    memberUserId,
  );

  if (!member) {
    throw new ApiError(404, "Workspace member not found");
  }

  if (member.isOwner) {
    throw new ApiError(400, "Workspace owner status cannot be changed");
  }

  member.status = status;

  await workspaceRepository.saveWorkspaceMember(member);

  return member.toSafeObject();
};

const removeWorkspaceMember = async (workspaceId, userId, memberUserId) => {
  await ensureWorkspaceMemberActor(workspaceId, userId, {
    requiredPermissions: [PERMISSIONS.WORKSPACE_MEMBER_DELETE],
    forbiddenMessage: "Only workspace owner or authorized admin can remove members",
  });

  if (userId.toString() === memberUserId.toString()) {
    throw new ApiError(400, "Workspace member cannot remove themselves");
  }

  const member = await workspaceRepository.findWorkspaceMember(
    workspaceId,
    memberUserId,
  );

  if (!member) {
    throw new ApiError(404, "Workspace member not found");
  }

  if (member.isOwner) {
    throw new ApiError(400, "Workspace owner cannot be removed");
  }

  const removedMember = await workspaceRepository.removeWorkspaceMember(
    workspaceId,
    memberUserId,
    userId,
  );

  return removedMember.toSafeObject();
};

const directCreateMember = async (workspaceId, adminUserId, payload) => {
  const actor = await ensureWorkspaceMemberActor(workspaceId, adminUserId, {
    requiredPermissions: [PERMISSIONS.WORKSPACE_MEMBER_CREATE],
    forbiddenMessage: "Only workspace owner or authorized admin can add team members",
  });

  const workspace = actor.workspace;

  // Enforce prerequisite: At least 1 company and 1 branch must exist
  const totalCompanies = await companyRepository.countWorkspaceCompanies(workspaceId);
  if (totalCompanies === 0) {
    throw new ApiError(400, "Please create at least one operating company before adding team members");
  }

  const totalBranches = await branchRepository.countWorkspaceBranches(workspaceId);
  if (totalBranches === 0) {
    throw new ApiError(400, "Please create at least one dispensary branch before adding team members");
  }

  const {
    fullName,
    email,
    phone,
    password,
    roleId,
    companyIds = [],
    branchAccess = [],
    accessAllCompanies = false,
    accessAllBranches = false,
  } = payload;

  const branchRoleIds = Array.isArray(branchAccess)
    ? branchAccess.map((b) => b?.roleId).filter(Boolean)
    : [];
  await assertActorCanAssignRoleIds({
    workspaceId,
    actor,
    roleIds: [roleId, ...branchRoleIds].filter(Boolean),
  });

  const cleanPhone = phone ? String(phone).trim() : null;
  const cleanEmail = email ? String(email).trim().toLowerCase() : null;

  if (!cleanEmail && !cleanPhone) {
    throw new ApiError(400, "Either email or mobile number is required");
  }

  // 1. Check for duplicate phone number
  if (cleanPhone) {
    const existingUserByPhone = await authRepository.findUserByPhone(cleanPhone);
    if (existingUserByPhone) {
      if (existingUserByPhone._id.toString() === adminUserId.toString()) {
        throw new ApiError(
          400,
          "You cannot add yourself as a new staff member. Please enter the staff member's mobile number.",
        );
      }

      const existingMember = await workspaceRepository.findWorkspaceMember(
        workspaceId,
        existingUserByPhone._id,
      );

      if (existingMember && existingMember.status === WORKSPACE_MEMBER_STATUS.ACTIVE) {
        throw new ApiError(
          400,
          `A user with mobile number +91 ${cleanPhone} (${existingUserByPhone.fullName}) is already an active member of this workspace`,
        );
      }

      throw new ApiError(
        400,
        `Mobile number +91 ${cleanPhone} is already registered in the system to ${existingUserByPhone.fullName}. Please enter a unique mobile number or use email invitation.`,
      );
    }
  }

  // 2. Check for duplicate email if provided
  if (cleanEmail) {
    const existingUserByEmail = await authRepository.findUserByEmail(cleanEmail);
    if (existingUserByEmail) {
      if (existingUserByEmail._id.toString() === adminUserId.toString()) {
        throw new ApiError(
          400,
          "You cannot add yourself as a new staff member. Please enter the staff member's email.",
        );
      }

      const existingMember = await workspaceRepository.findWorkspaceMember(
        workspaceId,
        existingUserByEmail._id,
      );

      if (existingMember && existingMember.status === WORKSPACE_MEMBER_STATUS.ACTIVE) {
        throw new ApiError(
          400,
          `A user with email ${cleanEmail} (${existingUserByEmail.fullName}) is already an active member of this workspace`,
        );
      }

      throw new ApiError(
        400,
        `Email ${cleanEmail} is already registered to ${existingUserByEmail.fullName}. Please use a different email or send an invitation link.`,
      );
    }
  }

  // 3. Guarantee a unique email for mobile-only staff accounts
  const staffEmail =
    cleanEmail ||
    `staff.${cleanPhone}.${workspace._id.toString().slice(-6)}@pharmacy.local`;

  // 4. Create new User document
  const user = await authRepository.createUser({
    fullName,
    email: staffEmail,
    phone: cleanPhone || undefined,
    password,
    emailVerified: true,
    phoneVerified: Boolean(cleanPhone),
    isActive: true,
  });

  // 5. Resolve workspace role
  let resolvedRole = null;
  if (roleId) {
    resolvedRole = await roleService.findRoleById(roleId, workspaceId);
  }
  if (!resolvedRole) {
    resolvedRole = await roleService.getStaffRoleForWorkspace(workspaceId);
  }

  // 6. Create WorkspaceMember
  const member = await workspaceRepository.createWorkspaceMember({
    workspaceId,
    userId: user._id,
    roleId: resolvedRole?._id,
    createdBy: adminUserId,
    status: WORKSPACE_MEMBER_STATUS.ACTIVE,
    isOwner: false,
    isPrimary: false,
  });

  // 7. Create PBAC permissions
  const derivedBranchIds = Array.isArray(branchAccess)
    ? branchAccess.map((b) => b.branchId)
    : [];

  await memberAccessService.createDefaultAccessForMember({
    workspaceId,
    workspaceMemberId: member._id,
    userId: user._id,
    createdBy: adminUserId,
    accessAllCompanies: Boolean(accessAllCompanies),
    accessAllBranches: Boolean(accessAllBranches),
    companyIds,
    branchIds: derivedBranchIds,
    branchAccess: branchAccess || [],
  });

  const resolvedWorkAccess = resolveEffectiveWorkAccess({
    role: resolvedRole,
    permissions: resolvedRole?.permissions || [],
    isOwner: false,
  });

  const populatedMember = {
    ...member.toSafeObject(),
    userId: user.toSafeObject(),
    roleId: resolvedRole?.toSafeObject ? resolvedRole.toSafeObject() : resolvedRole,
    workAccess: resolvedWorkAccess,
  };

  return {
    member: populatedMember,
    user: user.toSafeObject(),
    credentials: {
      fullName,
      email: cleanEmail || staffEmail,
      phone: cleanPhone,
      password,
      roleName: resolvedRole?.name || "Staff",
    },
  };
};

const resetMemberPassword = async (
  workspaceId,
  adminUserId,
  memberUserId,
  newPassword,
) => {
  await ensureWorkspaceMemberActor(workspaceId, adminUserId, {
    requiredPermissions: [PERMISSIONS.WORKSPACE_MEMBER_UPDATE],
    forbiddenMessage: "Only workspace owner or authorized admin can reset staff passwords",
  });

  const targetUser = await authRepository.findUserById(memberUserId);
  if (!targetUser) {
    throw new ApiError(404, "User not found");
  }

  targetUser.password = newPassword;
  await authRepository.saveUser(targetUser);

  return {
    success: true,
    message: "Password updated successfully",
  };
};

export { createWorkspace, directCreateMember, resetMemberPassword };

export default {
  createWorkspace,
  getMyWorkspaces,
  getWorkspaceById,
  updateWorkspace,
  deleteWorkspace,
  getWorkspaceMembers,
  addWorkspaceMember,
  updateWorkspaceMemberStatus,
  removeWorkspaceMember,
  directCreateMember,
  resetMemberPassword,
};
