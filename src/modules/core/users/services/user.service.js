import ApiError from "../../../../utils/ApiError.js";

import userRepository from "../repositories/user.repository.js";

import workspaceRepository from "../../../organization/workspaces/repositories/workspace.repository.js";
import companyRepository from "../../../organization/companies/repositories/company.repository.js";
import branchRepository from "../../../organization/branches/repositories/branch.repository.js";
import memberAccessService from "../../access-control/services/memberAccess.service.js";

import {
  WORKSPACE_STATUS,
  WORKSPACE_MEMBER_STATUS,
} from "../../../organization/workspaces/constants/workspace.constant.js";

import { COMPANY_STATUS } from "../../../organization/companies/constants/company.constant.js";
import { BRANCH_STATUS } from "../../../organization/branches/constants/branch.constant.js";

const getMyProfile = async (userId) => {
  const user = await userRepository.findUserById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  return user.toSafeObject();
};

const updateMyProfile = async (userId, payload) => {
  const user = await userRepository.findUserById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const allowedFields = ["fullName"];

  allowedFields.forEach((field) => {
    if (payload[field] !== undefined) {
      user[field] = payload[field];
    }
  });

  await userRepository.saveUser(user);

  return user.toSafeObject();
};

const updateMyAvatar = async (userId, avatar) => {
  const user = await userRepository.findUserById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  user.avatar = avatar;

  await userRepository.saveUser(user);

  return user.toSafeObject();
};

const removeMyAvatar = async (userId) => {
  const user = await userRepository.findUserById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  user.avatar = null;

  await userRepository.saveUser(user);

  return user.toSafeObject();
};

const updateMyEmail = async (userId, email) => {
  const user = await userRepository.findUserById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  if (user.email === normalizedEmail) {
    throw new ApiError(400, "New email must be different from current email");
  }

  const existingUser = await userRepository.findUserByEmail(normalizedEmail);

  if (existingUser) {
    throw new ApiError(400, "Email already exists");
  }

  user.email = normalizedEmail;
  user.emailVerified = false;

  await userRepository.saveUser(user);

  return user.toSafeObject();
};

const updateMyPhone = async (userId, phone) => {
  const user = await userRepository.findUserById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const normalizedPhone = phone ? String(phone).trim() : null;

  if (user.phone === normalizedPhone) {
    throw new ApiError(400, "New phone must be different from current phone");
  }

  if (normalizedPhone) {
    const existingUser = await userRepository.findUserByPhone(normalizedPhone);

    if (existingUser) {
      throw new ApiError(400, "Phone already exists");
    }
  }

  user.phone = normalizedPhone;
  user.phoneVerified = false;

  await userRepository.saveUser(user);

  return user.toSafeObject();
};

const getMyActiveContext = async (userId) => {
  const user = await userRepository.findUserById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  return {
    workspaceId: user.activeContext?.workspaceId || null,
    companyId: null,
    branchId: null,
    updatedAt: user.activeContext?.updatedAt || null,
  };
};


const validateWorkspaceContext = async (userId, workspaceId) => {
  const workspace = await workspaceRepository.findWorkspaceById(workspaceId);

  if (!workspace || workspace.status === WORKSPACE_STATUS.DELETED) {
    throw new ApiError(404, "Workspace not found");
  }

  if (workspace.status !== WORKSPACE_STATUS.ACTIVE) {
    throw new ApiError(403, "Workspace is not active");
  }

  const member = await workspaceRepository.findWorkspaceMember(
    workspace._id,
    userId,
  );

  if (!member) {
    throw new ApiError(403, "You are not a member of this workspace");
  }

  if (member.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
    throw new ApiError(403, "Workspace member is not active");
  }

  return {
    workspace,
    member,
  };
};

const validateCompanyContext = async (userId, workspaceId, companyId) => {
  const company = await companyRepository.findCompanyByIdAndWorkspace(
    companyId,
    workspaceId,
  );

  if (!company || company.status === COMPANY_STATUS.DELETED) {
    throw new ApiError(404, "Company not found");
  }

  if (company.status !== COMPANY_STATUS.ACTIVE) {
    throw new ApiError(403, "Company is not active");
  }

  const hasCompanyAccess = await memberAccessService.hasCompanyAccess(
    workspaceId,
    userId,
    company._id,
  );

  if (!hasCompanyAccess) {
    throw new ApiError(403, "You do not have access to this company");
  }

  return company;
};

const validateBranchContext = async (
  userId,
  workspaceId,
  companyId,
  branchId,
) => {
  const branch = await branchRepository.findBranchByIdAndCompany(
    branchId,
    companyId,
  );

  if (!branch || branch.status === BRANCH_STATUS.DELETED) {
    throw new ApiError(404, "Branch not found");
  }

  if (branch.workspaceId.toString() !== workspaceId.toString()) {
    throw new ApiError(403, "Branch does not belong to this workspace");
  }

  if (branch.status !== BRANCH_STATUS.ACTIVE) {
    throw new ApiError(403, "Branch is not active");
  }

  const hasBranchAccess = await memberAccessService.hasBranchAccess(
    workspaceId,
    userId,
    branch._id,
  );

  if (!hasBranchAccess) {
    throw new ApiError(403, "You do not have access to this branch");
  }

  return branch;
};

const updateMyActiveContext = async (userId, payload) => {
  const { workspaceId } = payload;

  if (!workspaceId) {
    const user = await userRepository.clearActiveContext(userId);

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    return user.toSafeObject();
  }

  await validateWorkspaceContext(userId, workspaceId);

  const activeContext = {
    workspaceId,
    companyId: null,
    branchId: null,
  };

  const user = await userRepository.updateActiveContext(userId, activeContext);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  return user.toSafeObject();
};

const deleteMyAccount = async (userId) => {
  const user = await userRepository.deleteUserById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  return {
    success: true,
  };
};

export default {
  getMyProfile,
  updateMyProfile,
  updateMyAvatar,
  removeMyAvatar,
  updateMyEmail,
  updateMyPhone,

  getMyActiveContext,
  updateMyActiveContext,

  deleteMyAccount,
};
