import ApiError from "../../../../utils/ApiError.js";

import branchRepository from "../repositories/branch.repository.js";
import companyRepository from "../../companies/repositories/company.repository.js";
import workspaceRepository from "../../workspaces/repositories/workspace.repository.js";
import memberAccessRepository from "../../../core/access-control/repositories/memberAccess.repository.js";
import branchCashService from "../../../finance/treasury/cash-management/branch-cash/services/branchCash.service.js";

import { BRANCH_STATUS } from "../constants/branch.constant.js";

import { COMPANY_STATUS } from "../../companies/constants/company.constant.js";

import {
  WORKSPACE_STATUS,
  WORKSPACE_MEMBER_STATUS,
} from "../../workspaces/constants/workspace.constant.js";

const createSlug = (name) => {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const ensureWorkspaceAccess = async (workspaceId, userId) => {
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
  );

  if (!member || member.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
    throw new ApiError(403, "You do not have access to this workspace");
  }

  return {
    workspace,
    member,
  };
};

const ensureCompanyAccess = async (companyId, workspaceId) => {
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

  return company;
};

const createBranch = async (workspaceId, companyId, userId, payload) => {
  await ensureWorkspaceAccess(workspaceId, userId);

  await ensureCompanyAccess(companyId, workspaceId);

  const slug = createSlug(payload.name);

  const existingBranch = await branchRepository.findBranchBySlug(
    workspaceId,
    companyId,
    slug,
  );

  if (existingBranch) {
    throw new ApiError(400, "Branch with this name already exists");
  }

  if (payload.isPrimary) {
    const primaryBranch = await branchRepository.getPrimaryBranch(companyId);

    if (primaryBranch) {
      throw new ApiError(400, "Primary branch already exists");
    }
  }

  const branch = await branchRepository.createBranch({
    workspaceId,
    companyId,

    name: payload.name,
    slug,

    type: payload.type,
    isPrimary: payload.isPrimary || false,

    email: payload.email,
    phones: payload.phones,

    address: payload.address,

    license: payload.license,
    pharmacist: payload.pharmacist,
    emergencyContact: payload.emergencyContact,

    createdBy: userId,
  });



  return branch.toSafeObject();
};

const getCompanyBranches = async (companyId, workspaceId, userId) => {
  const { member } = await ensureWorkspaceAccess(workspaceId, userId);

  await ensureCompanyAccess(companyId, workspaceId);

  const [branches, members, accessList] = await Promise.all([
    branchRepository.getCompanyBranches(companyId),
    workspaceRepository.getWorkspaceMembers(workspaceId, {
      status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      populate: "roleId userId",
    }).catch(() => []),
    memberAccessRepository.getWorkspaceMemberAccessList(workspaceId).catch(() => []),
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

  const branchMemberCountMap = new Map();
  branches.forEach((branch) => {
    const branchIdStr = branch._id.toString();
    const compIdStr = (branch.companyId?._id || branch.companyId || branch.company)?.toString();
    let count = 0;

    (members || []).forEach((m) => {
      const isMemberOwner = Boolean(m.isOwner);
      const memberIdStr = m._id?.toString();
      const userIdStr = (m.userId?._id || m.userId)?.toString();
      const acc =
        (memberIdStr && accessMap.get(memberIdStr)) ||
        (userIdStr && accessMap.get(userIdStr)) ||
        null;

      if (isMemberOwner) {
        count += 1;
        return;
      }

      if (!acc) {
        count += 1;
        return;
      }

      // Check company access first
      if (!acc.accessAllCompanies) {
        const allowedCompanyIds = (acc.companyIds || []).map((id) => (id?._id || id).toString());
        if (compIdStr && !allowedCompanyIds.includes(compIdStr)) {
          return;
        }
      }

      // Check branch access
      if (acc.accessAllBranches) {
        count += 1;
        return;
      }

      const allowedBranchIds = [
        ...(acc.branchIds || []).map((id) => (id?._id || id).toString()),
        ...(acc.branchAccess || []).map((ba) => (ba.branchId?._id || ba.branchId).toString()),
      ];

      if (allowedBranchIds.includes(branchIdStr)) {
        count += 1;
      }
    });

    branchMemberCountMap.set(branchIdStr, count);
  });

  // Filter branches visible to current user
  let filtered = branches;
  if (!member.isOwner) {
    const userAccess =
      (await memberAccessRepository.findMemberAccessByMemberId(member._id)) ||
      (await memberAccessRepository.findMemberAccessByUserAndWorkspace(workspaceId, userId));

    if (userAccess) {
      if (!userAccess.accessAllCompanies) {
        const allowedCompanyIds = new Set(
          (userAccess.companyIds || []).map((id) => (id?._id || id).toString())
        );
        if (!allowedCompanyIds.has(companyId.toString())) {
          return [];
        }
      }

      if (!userAccess.accessAllBranches) {
        const allowedBranchIds = new Set([
          ...(userAccess.branchIds || []).map((id) => (id?._id || id).toString()),
          ...(userAccess.branchAccess || []).map((ba) => (ba.branchId?._id || ba.branchId).toString()),
        ]);
        filtered = branches.filter((b) => allowedBranchIds.has(b._id.toString()));
      }
    }
  }

  return filtered.map((branch) => {
    const safeObj = branch.toSafeObject();
    const count = branchMemberCountMap.get(branch._id.toString()) || 0;
    safeObj.memberCount = count;
    safeObj.membersCount = count;
    safeObj.staffCount = count;
    return safeObj;
  });
};

const getWorkspaceBranches = async (workspaceId, userId) => {
  const { member } = await ensureWorkspaceAccess(workspaceId, userId);

  const [branches, members, accessList] = await Promise.all([
    branchRepository.getWorkspaceBranches(workspaceId),
    workspaceRepository.getWorkspaceMembers(workspaceId, {
      status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      populate: "roleId userId",
    }).catch(() => []),
    memberAccessRepository.getWorkspaceMemberAccessList(workspaceId).catch(() => []),
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

  const branchMemberCountMap = new Map();
  branches.forEach((branch) => {
    const branchIdStr = branch._id.toString();
    const compIdStr = (branch.companyId?._id || branch.companyId || branch.company)?.toString();
    let count = 0;

    (members || []).forEach((m) => {
      const isMemberOwner = Boolean(m.isOwner);
      const memberIdStr = m._id?.toString();
      const userIdStr = (m.userId?._id || m.userId)?.toString();
      const acc =
        (memberIdStr && accessMap.get(memberIdStr)) ||
        (userIdStr && accessMap.get(userIdStr)) ||
        null;

      if (isMemberOwner) {
        count += 1;
        return;
      }

      if (!acc) {
        count += 1;
        return;
      }

      // Check company access first
      if (!acc.accessAllCompanies) {
        const allowedCompanyIds = (acc.companyIds || []).map((id) => (id?._id || id).toString());
        if (compIdStr && !allowedCompanyIds.includes(compIdStr)) {
          return;
        }
      }

      // Check branch access
      if (acc.accessAllBranches) {
        count += 1;
        return;
      }

      const allowedBranchIds = [
        ...(acc.branchIds || []).map((id) => (id?._id || id).toString()),
        ...(acc.branchAccess || []).map((ba) => (ba.branchId?._id || ba.branchId).toString()),
      ];

      if (allowedBranchIds.includes(branchIdStr)) {
        count += 1;
      }
    });

    branchMemberCountMap.set(branchIdStr, count);
  });

  let filtered = branches;
  if (!member.isOwner) {
    const userAccess =
      (await memberAccessRepository.findMemberAccessByMemberId(member._id)) ||
      (await memberAccessRepository.findMemberAccessByUserAndWorkspace(workspaceId, userId));

    if (userAccess) {
      if (!userAccess.accessAllCompanies) {
        const allowedCompanyIds = new Set(
          (userAccess.companyIds || []).map((id) => (id?._id || id).toString())
        );
        filtered = filtered.filter((b) => {
          const compId = (b.companyId?._id || b.companyId || b.company)?.toString();
          return compId && allowedCompanyIds.has(compId);
        });
      }

      if (!userAccess.accessAllBranches) {
        const allowedBranchIds = new Set([
          ...(userAccess.branchIds || []).map((id) => (id?._id || id).toString()),
          ...(userAccess.branchAccess || []).map((ba) => (ba.branchId?._id || ba.branchId).toString()),
        ]);
        filtered = filtered.filter((b) => allowedBranchIds.has(b._id.toString()));
      }
    }
  }

  return filtered.map((branch) => {
    const safeObj = branch.toSafeObject();
    const count = branchMemberCountMap.get(branch._id.toString()) || 0;
    safeObj.memberCount = count;
    safeObj.membersCount = count;
    safeObj.staffCount = count;
    return safeObj;
  });
};

const getBranchById = async (branchId, companyId, workspaceId, userId) => {
  await ensureWorkspaceAccess(workspaceId, userId);

  if (companyId) {
    await ensureCompanyAccess(companyId, workspaceId);
  }

  const [branch, members, accessList] = await Promise.all([
    branchRepository.findBranchById(branchId),
    workspaceRepository.getWorkspaceMembers(workspaceId, {
      status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      populate: "roleId userId",
    }).catch(() => []),
    memberAccessRepository.getWorkspaceMemberAccessList(workspaceId).catch(() => []),
  ]);

  if (!branch || branch.workspaceId.toString() !== workspaceId.toString() || branch.status === BRANCH_STATUS.DELETED) {
    throw new ApiError(404, "Branch not found");
  }

  const accessMap = new Map();
  (accessList || []).forEach((acc) => {
    if (acc.workspaceMemberId) {
      accessMap.set(acc.workspaceMemberId.toString(), acc);
    }
    if (acc.userId) {
      accessMap.set(acc.userId.toString(), acc);
    }
  });

  const branchIdStr = branch._id.toString();
  const compIdStr = (branch.companyId?._id || branch.companyId || branch.company)?.toString();
  let count = 0;

  (members || []).forEach((m) => {
    const isMemberOwner = Boolean(m.isOwner);
    const memberIdStr = m._id?.toString();
    const userIdStr = (m.userId?._id || m.userId)?.toString();
    const acc =
      (memberIdStr && accessMap.get(memberIdStr)) ||
      (userIdStr && accessMap.get(userIdStr)) ||
      null;

    if (isMemberOwner || !acc) {
      count += 1;
      return;
    }

    if (!acc.accessAllCompanies) {
      const allowedCompanyIds = (acc.companyIds || []).map((id) => (id?._id || id).toString());
      if (compIdStr && !allowedCompanyIds.includes(compIdStr)) {
        return;
      }
    }

    if (acc.accessAllBranches) {
      count += 1;
      return;
    }

    const allowedBranchIds = [
      ...(acc.branchIds || []).map((id) => (id?._id || id).toString()),
      ...(acc.branchAccess || []).map((ba) => (ba.branchId?._id || ba.branchId).toString()),
    ];

    if (allowedBranchIds.includes(branchIdStr)) {
      count += 1;
    }
  });

  const safeObj = branch.toSafeObject();
  safeObj.memberCount = count;
  safeObj.membersCount = count;
  safeObj.staffCount = count;
  return safeObj;
};

const getBranchMembers = async (branchId, workspaceId, userId) => {
  await ensureWorkspaceAccess(workspaceId, userId);

  const [branch, members, accessList] = await Promise.all([
    branchRepository.findBranchById(branchId),
    workspaceRepository.getWorkspaceMembers(workspaceId, {
      status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      populate: "roleId userId",
    }).catch(() => []),
    memberAccessRepository.getWorkspaceMemberAccessList(workspaceId).catch(() => []),
  ]);

  if (!branch || branch.workspaceId.toString() !== workspaceId.toString() || branch.status === BRANCH_STATUS.DELETED) {
    throw new ApiError(404, "Branch not found");
  }

  const accessMap = new Map();
  (accessList || []).forEach((acc) => {
    if (acc.workspaceMemberId) {
      accessMap.set(acc.workspaceMemberId.toString(), acc);
    }
    if (acc.userId) {
      accessMap.set(acc.userId.toString(), acc);
    }
  });

  const branchIdStr = branch._id.toString();
  const compIdStr = (branch.companyId?._id || branch.companyId || branch.company)?.toString();
  const assignedEmployees = [];

  (members || []).forEach((m) => {
    const isMemberOwner = Boolean(m.isOwner);
    const memberIdStr = m._id?.toString();
    const userIdStr = (m.userId?._id || m.userId)?.toString();
    const acc =
      (memberIdStr && accessMap.get(memberIdStr)) ||
      (userIdStr && accessMap.get(userIdStr)) ||
      null;

    let hasAccess = false;
    if (isMemberOwner || !acc) {
      hasAccess = true;
    } else {
      let companyAllowed = true;
      if (!acc.accessAllCompanies) {
        const allowedCompanyIds = (acc.companyIds || []).map((id) => (id?._id || id).toString());
        companyAllowed = compIdStr ? allowedCompanyIds.includes(compIdStr) : true;
      }

      if (companyAllowed) {
        if (acc.accessAllBranches) {
          hasAccess = true;
        } else {
          const allowedBranchIds = [
            ...(acc.branchIds || []).map((id) => (id?._id || id).toString()),
            ...(acc.branchAccess || []).map((ba) => (ba.branchId?._id || ba.branchId).toString()),
          ];
          hasAccess = allowedBranchIds.includes(branchIdStr);
        }
      }
    }

    if (hasAccess) {
      const userObj = m.userId && typeof m.userId === "object" ? m.userId : null;
      const roleObj = m.roleId && typeof m.roleId === "object" ? m.roleId : null;

      assignedEmployees.push({
        _id: m._id,
        id: m._id,
        workspaceMemberId: m._id,
        user: userObj
          ? {
              _id: userObj._id,
              name: userObj.name || userObj.fullName,
              email: userObj.email,
              phone: userObj.phone || userObj.mobile,
              avatar: userObj.avatar,
            }
          : null,
        displayName: userObj?.name || userObj?.fullName || "Workspace Member",
        displayEmail: userObj?.email || "-",
        displayPhone: userObj?.phone || userObj?.mobile || "-",
        role: roleObj
          ? {
              _id: roleObj._id,
              name: roleObj.name,
              code: roleObj.code,
            }
          : null,
        roleName: isMemberOwner ? "Owner" : (roleObj?.name || "Staff Member"),
        status: m.status || "active",
        isOwner: isMemberOwner,
        accessAllBranches: Boolean(isMemberOwner || acc?.accessAllBranches),
        createdAt: m.createdAt,
      });
    }
  });

  return assignedEmployees;
};

const updateBranch = async (
  branchId,
  companyId,
  workspaceId,
  userId,
  payload,
) => {
  await ensureWorkspaceAccess(workspaceId, userId);

  await ensureCompanyAccess(companyId, workspaceId);

  const branch = await branchRepository.findBranchByIdAndCompany(
    branchId,
    companyId,
  );

  if (!branch || branch.workspaceId.toString() !== workspaceId.toString()) {
    throw new ApiError(404, "Branch not found");
  }

  if (payload.name && payload.name !== branch.name) {
    const slug = createSlug(payload.name);

    const existingBranch = await branchRepository.findBranchBySlug(
      workspaceId,
      companyId,
      slug,
    );

    if (
      existingBranch &&
      existingBranch._id.toString() !== branch._id.toString()
    ) {
      throw new ApiError(400, "Branch with this name already exists");
    }

    branch.slug = slug;
  }

  if (payload.isPrimary === true && branch.isPrimary === false) {
    const existingPrimary = await branchRepository.getPrimaryBranch(companyId);

    if (
      existingPrimary &&
      existingPrimary._id.toString() !== branch._id.toString()
    ) {
      throw new ApiError(400, "Another primary branch already exists");
    }
  }

  const allowedFields = [
    "name",
    "type",
    "isPrimary",
    "email",
    "phones",
    "address",
    "license",
    "pharmacist",
    "emergencyContact",
    "status",
  ];

  allowedFields.forEach((field) => {
    if (payload[field] !== undefined) {
      branch[field] = payload[field];
    }
  });

  await branchRepository.saveBranch(branch);

  return branch.toSafeObject();
};

const deleteBranch = async (branchId, companyId, workspaceId, userId) => {
  const { member } = await ensureWorkspaceAccess(workspaceId, userId);

  await ensureCompanyAccess(companyId, workspaceId);

  if (!member.isOwner) {
    throw new ApiError(403, "Only workspace owner can delete branch");
  }

  const branch = await branchRepository.findBranchByIdAndCompany(
    branchId,
    companyId,
  );

  if (!branch || branch.workspaceId.toString() !== workspaceId.toString()) {
    throw new ApiError(404, "Branch not found");
  }

  if (branch.status === BRANCH_STATUS.DELETED || branch.isDeleted) {
    throw new ApiError(404, "Branch not found");
  }

  // Minimum Invariant: At least 1 branch must always remain in the workspace
  const totalBranches = await branchRepository.countWorkspaceBranches(workspaceId);
  if (totalBranches <= 1) {
    throw new ApiError(
      400,
      "Cannot delete the only branch in the workspace. At least one branch must remain.",
    );
  }

  // If this branch is primary, auto-promote another active branch in the same company
  if (branch.isPrimary) {
    await branchRepository.promoteNextPrimaryBranch(companyId, branch._id);
  }

  const deletedBranch = await branchRepository.deleteBranchById(
    branch._id,
    companyId,
    workspaceId,
    userId,
  );

  if (!deletedBranch) {
    throw new ApiError(404, "Branch not found");
  }

  return {
    success: true,
  };
};

export default {
  createBranch,
  getCompanyBranches,
  getWorkspaceBranches,
  getBranchById,
  getBranchMembers,
  updateBranch,
  deleteBranch,
};
