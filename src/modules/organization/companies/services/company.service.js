import mongoose from "mongoose";
import ApiError from "../../../../utils/ApiError.js";

import companyRepository from "../repositories/company.repository.js";
import workspaceRepository from "../../workspaces/repositories/workspace.repository.js";
import memberAccessRepository from "../../../core/access-control/repositories/memberAccess.repository.js";
import coaSeederService from "../../../finance/chart-of-accounts/services/coaSeeder.service.js";
import customerService from "../../../parties/customers/services/customer.service.js";
import financialPeriodService from "../../../finance/financial-periods/services/financialPeriod.service.js";
import { PERIOD_TYPE, PERIOD_STATUS } from "../../../finance/financial-periods/constants/financialPeriod.constant.js";
import { COMPANY_STATUS } from "../constants/company.constant.js";

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

const createCompany = async (workspaceId, userId, payload) => {
  await ensureWorkspaceAccess(workspaceId, userId);

  const {
    name,
    type,
    logo,
    email,
    phones,
    website,
    address,
    gstin,
    pan,
    owner,
    license,
  } = payload;

  const slug = createSlug(name);

  const existingCompany = await companyRepository.findCompanyBySlug(
    workspaceId,
    slug,
  );

  if (existingCompany) {
    throw new ApiError(400, "Company with this name already exists");
  }

  if (gstin) {
    const existingGstinCompany = await companyRepository.findCompanyByGstin(
      workspaceId,
      gstin,
    );

    if (existingGstinCompany) {
      throw new ApiError(400, "Company with this GSTIN already exists");
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const company = await companyRepository.createCompany({
      workspaceId,
      name,
      slug,
      type,
      logo,
      email,
      phones,
      website,
      address,
      gstin,
      pan,
      owner,
      license,
      createdBy: userId,
    }, { session });

    // Seed default Chart of Accounts groups and accounts for the new company
    await coaSeederService.seedCompanyChartOfAccounts(workspaceId, company._id, userId, { session });

    // Automatically create default Walk-in Customer for the new company
    await customerService.findOrCreateWalkInCustomer(workspaceId, company._id, userId, { session });

    await session.commitTransaction();
    session.endSession();

    // Automatically create 1 active financial year for the new company
    try {
      const now = new Date();
      let startYear = now.getFullYear();
      if (now.getMonth() < 3) {
        startYear -= 1; // If Jan-Mar, financial year started previous year
      }
      
      const startDate = new Date(startYear, 3, 1); // April 1
      const endDate = new Date(startYear + 1, 2, 31, 23, 59, 59); // March 31
      const endYearShort = String(startYear + 1).slice(-2);
      const periodCode = `FY-${startYear}-${endYearShort}`;

      await financialPeriodService.createFinancialPeriod(workspaceId, company._id, userId, {
        startDate,
        endDate,
        periodType: PERIOD_TYPE.YEAR,
        periodCode,
        isCurrent: true,
        status: PERIOD_STATUS.OPEN,
      });
    } catch (fyError) {
      console.warn("Could not automatically create financial year:", fyError);
    }

    return company.toSafeObject();
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

const getWorkspaceCompanies = async (workspaceId, userId) => {
  const { member } = await ensureWorkspaceAccess(workspaceId, userId);

  const [companies, members, accessList] = await Promise.all([
    companyRepository.getWorkspaceCompanies(workspaceId),
    workspaceRepository.getWorkspaceMembers(workspaceId, {
      status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      populate: "roleId userId",
    }).catch(() => []),
    memberAccessRepository.getWorkspaceMemberAccessList(workspaceId).catch(() => []),
  ]);

  // Build lookup map for member access
  const accessMap = new Map();
  (accessList || []).forEach((acc) => {
    if (acc.workspaceMemberId) {
      accessMap.set(acc.workspaceMemberId.toString(), acc);
    }
    if (acc.userId) {
      accessMap.set(acc.userId.toString(), acc);
    }
  });

  // Calculate member count per company
  const companyMemberCountMap = new Map();
  companies.forEach((company) => {
    const compIdStr = company._id.toString();
    let count = 0;

    (members || []).forEach((m) => {
      const isMemberOwner = Boolean(m.isOwner);
      const memberIdStr = m._id?.toString();
      const userIdStr = (m.userId?._id || m.userId)?.toString();
      const acc =
        (memberIdStr && accessMap.get(memberIdStr)) ||
        (userIdStr && accessMap.get(userIdStr)) ||
        null;

      const accessAll = isMemberOwner ? true : (acc ? Boolean(acc.accessAllCompanies) : true);
      const allowedCompIds = isMemberOwner
        ? null
        : (acc?.companyIds || []).map((id) => (id?._id || id).toString());

      if (accessAll || (allowedCompIds && allowedCompIds.includes(compIdStr))) {
        count += 1;
      }
    });

    companyMemberCountMap.set(compIdStr, count);
  });

  // If member is not owner, filter permitted companies
  let visibleCompanies = companies;
  if (!member.isOwner) {
    const access =
      (await memberAccessRepository.findMemberAccessByMemberId(member._id)) ||
      (await memberAccessRepository.findMemberAccessByUserAndWorkspace(workspaceId, userId));

    if (access && !access.accessAllCompanies) {
      const allowedCompanyIds = new Set(
        (access.companyIds || []).map((id) => (id?._id || id).toString())
      );
      visibleCompanies = companies.filter((company) =>
        allowedCompanyIds.has(company._id.toString())
      );
    }
  }

  return visibleCompanies.map((company) => {
    const safeObj = company.toSafeObject();
    const count = companyMemberCountMap.get(company._id.toString()) || 0;
    safeObj.memberCount = count;
    safeObj.membersCount = count;
    safeObj.highlights = {
      ...(safeObj.highlights || {}),
      totalMembers: count,
      activeMembers: count,
    };
    return safeObj;
  });
};

const getCompanyById = async (companyId, workspaceId, userId) => {
  await ensureWorkspaceAccess(workspaceId, userId);

  const [company, members, accessList] = await Promise.all([
    companyRepository.findCompanyByIdAndWorkspace(companyId, workspaceId),
    workspaceRepository.getWorkspaceMembers(workspaceId, {
      status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      populate: "roleId userId",
    }).catch(() => []),
    memberAccessRepository.getWorkspaceMemberAccessList(workspaceId).catch(() => []),
  ]);

  if (!company || company.status === COMPANY_STATUS.DELETED) {
    throw new ApiError(404, "Company not found");
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

  const compIdStr = company._id.toString();
  let count = 0;
  (members || []).forEach((m) => {
    const isMemberOwner = Boolean(m.isOwner);
    const memberIdStr = m._id?.toString();
    const userIdStr = (m.userId?._id || m.userId)?.toString();
    const acc =
      (memberIdStr && accessMap.get(memberIdStr)) ||
      (userIdStr && accessMap.get(userIdStr)) ||
      null;

    const accessAll = isMemberOwner ? true : (acc ? Boolean(acc.accessAllCompanies) : true);
    const allowedCompIds = isMemberOwner
      ? null
      : (acc?.companyIds || []).map((id) => (id?._id || id).toString());

    if (accessAll || (allowedCompIds && allowedCompIds.includes(compIdStr))) {
      count += 1;
    }
  });

  const safeObj = company.toSafeObject();
  safeObj.memberCount = count;
  safeObj.membersCount = count;
  safeObj.highlights = {
    ...(safeObj.highlights || {}),
    totalMembers: count,
    activeMembers: count,
  };
  return safeObj;
};

const getCompanyMembers = async (companyId, workspaceId, userId) => {
  await ensureWorkspaceAccess(workspaceId, userId);

  const [company, members, accessList] = await Promise.all([
    companyRepository.findCompanyByIdAndWorkspace(companyId, workspaceId),
    workspaceRepository.getWorkspaceMembers(workspaceId, {
      status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      populate: "roleId userId",
    }).catch(() => []),
    memberAccessRepository.getWorkspaceMemberAccessList(workspaceId).catch(() => []),
  ]);

  if (!company || company.status === COMPANY_STATUS.DELETED) {
    throw new ApiError(404, "Company not found");
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

  const compIdStr = company._id.toString();
  const assignedEmployees = [];

  (members || []).forEach((m) => {
    const isMemberOwner = Boolean(m.isOwner);
    const memberIdStr = m._id?.toString();
    const userIdStr = (m.userId?._id || m.userId)?.toString();
    const acc =
      (memberIdStr && accessMap.get(memberIdStr)) ||
      (userIdStr && accessMap.get(userIdStr)) ||
      null;

    const accessAll = isMemberOwner ? true : (acc ? Boolean(acc.accessAllCompanies) : true);
    const allowedCompIds = isMemberOwner
      ? null
      : (acc?.companyIds || []).map((id) => (id?._id || id).toString());

    if (accessAll || (allowedCompIds && allowedCompIds.includes(compIdStr))) {
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
        accessAllCompanies: accessAll,
        createdAt: m.createdAt,
      });
    }
  });

  return assignedEmployees;
};

const updateCompany = async (companyId, workspaceId, userId, payload) => {
  await ensureWorkspaceAccess(workspaceId, userId);

  const company = await companyRepository.findCompanyByIdAndWorkspace(
    companyId,
    workspaceId,
  );

  if (!company || company.status === COMPANY_STATUS.DELETED) {
    throw new ApiError(404, "Company not found");
  }

  const allowedFields = [
    "name",
    "type",
    "logo",
    "email",
    "phones",
    "website",
    "address",
    "gstin",
    "pan",
    "owner",
    "license",
    "status",
  ];

  if (payload.name && payload.name !== company.name) {
    const slug = createSlug(payload.name);

    const existingCompany = await companyRepository.findCompanyBySlug(
      workspaceId,
      slug,
    );

    if (
      existingCompany &&
      existingCompany._id.toString() !== company._id.toString()
    ) {
      throw new ApiError(400, "Company with this name already exists");
    }

    company.slug = slug;
  }

  if (payload.gstin && payload.gstin !== company.gstin) {
    const existingGstinCompany = await companyRepository.findCompanyByGstin(
      workspaceId,
      payload.gstin,
    );

    if (
      existingGstinCompany &&
      existingGstinCompany._id.toString() !== company._id.toString()
    ) {
      throw new ApiError(400, "Company with this GSTIN already exists");
    }
  }

  allowedFields.forEach((field) => {
    if (payload[field] !== undefined) {
      company[field] = payload[field];
    }
  });

  await companyRepository.saveCompany(company);

  return company.toSafeObject();
};

const deleteCompany = async (companyId, workspaceId, userId) => {
  const { member } = await ensureWorkspaceAccess(workspaceId, userId);

  if (!member.isOwner) {
    throw new ApiError(403, "Only workspace owner can delete company");
  }

  const company = await companyRepository.deleteCompanyById(
    companyId,
    workspaceId,
    userId,
  );

  if (!company) {
    throw new ApiError(404, "Company not found");
  }

  return {
    success: true,
  };
};

export default {
  createCompany,
  getWorkspaceCompanies,
  getCompanyById,
  getCompanyMembers,
  updateCompany,
  deleteCompany,
};
