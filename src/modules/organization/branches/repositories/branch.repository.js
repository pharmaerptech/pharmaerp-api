import mongoose from "mongoose";

import Branch from "../models/branch.model.js";

import { BRANCH_STATUS } from "../constants/branch.constant.js";

const findBranchById = async (branchId, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(branchId)) {
    return null;
  }

  return Branch.findOne({
    _id: branchId,
    isDeleted: false,
  }).select(options.select || "");
};

const findBranchByIdAndCompany = async (branchId, companyId, options = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(branchId) ||
    !mongoose.Types.ObjectId.isValid(companyId)
  ) {
    return null;
  }

  return Branch.findOne({
    _id: branchId,
    companyId,
    isDeleted: false,
  }).select(options.select || "");
};

const findBranchBySlug = async (workspaceId, companyId, slug, options = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    !mongoose.Types.ObjectId.isValid(companyId)
  ) {
    return null;
  }

  return Branch.findOne({
    workspaceId,
    companyId,
    slug: String(slug).trim().toLowerCase(),
    isDeleted: false,
  }).select(options.select || "");
};

const findBranchByCode = async (branchCode, options = {}) => {
  return Branch.findOne({
    branchCode: String(branchCode).trim().toUpperCase(),
    isDeleted: false,
  }).select(options.select || "");
};

const createBranch = async (payload) => {
  return Branch.create(payload);
};

const saveBranch = async (branch) => {
  return branch.save();
};

const getCompanyBranches = async (companyId, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    return [];
  }

  return Branch.find({
    companyId,
    isDeleted: false,
  })
    .populate("companyId", "name legalName code")
    .sort(options.sort || { createdAt: -1 })
    .select(options.select || "");
};

const getWorkspaceBranches = async (workspaceId, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
    return [];
  }

  return Branch.find({
    workspaceId,
    isDeleted: false,
  })
    .populate("companyId", "name legalName code")
    .sort(options.sort || { createdAt: -1 })
    .select(options.select || "");
};

const getPrimaryBranch = async (companyId, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    return null;
  }

  return Branch.findOne({
    companyId,
    isPrimary: true,
    isDeleted: false,
  }).select(options.select || "");
};

const deleteBranchById = async (
  branchId,
  companyId,
  workspaceId,
  deletedBy,
) => {
  if (
    !mongoose.Types.ObjectId.isValid(branchId) ||
    !mongoose.Types.ObjectId.isValid(companyId) ||
    !mongoose.Types.ObjectId.isValid(workspaceId)
  ) {
    return null;
  }

  return Branch.findOneAndUpdate(
    {
      _id: branchId,
      companyId,
      workspaceId,
      isDeleted: false,
    },
    {
      isDeleted: true,
      status: BRANCH_STATUS.DELETED,
      deletedAt: new Date(),
      deletedBy,
    },
    {
      new: true,
      runValidators: true,
    },
  );
};

const countCompanyBranches = async (companyId) => {
  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    return 0;
  }

  return Branch.countDocuments({
    companyId,
    isDeleted: false,
  });
};

const countWorkspaceBranches = async (workspaceId) => {
  if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
    return 0;
  }

  return Branch.countDocuments({
    workspaceId,
    isDeleted: false,
  });
};

const promoteNextPrimaryBranch = async (companyId, excludeBranchId) => {
  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    return null;
  }

  return Branch.findOneAndUpdate(
    {
      companyId,
      _id: { $ne: excludeBranchId },
      isDeleted: false,
    },
    { $set: { isPrimary: true } },
    { new: true },
  );
};

export default {
  findBranchById,
  findBranchByIdAndCompany,
  findBranchBySlug,
  findBranchByCode,

  createBranch,
  saveBranch,

  getCompanyBranches,
  getWorkspaceBranches,
  getPrimaryBranch,

  deleteBranchById,

  countCompanyBranches,
  countWorkspaceBranches,
  promoteNextPrimaryBranch,
};
