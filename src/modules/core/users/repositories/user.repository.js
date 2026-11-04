import mongoose from "mongoose";

import User from "../models/user.model.js";

const findUserById = async (userId, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return null;
  }

  return User.findOne({
    _id: userId,
    isDeleted: false,
  }).select(options.select || "");
};

const findUserByEmail = async (email, options = {}) => {
  return User.findOne({
    email: String(email).trim().toLowerCase(),
    isDeleted: false,
  }).select(options.select || "");
};

const findUserByPhone = async (phone, options = {}) => {
  return User.findOne({
    phone: String(phone).trim(),
    isDeleted: false,
  }).select(options.select || "");
};

const saveUser = async (user) => {
  return user.save();
};

const updateActiveContext = async (userId, activeContext) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return null;
  }

  return User.findOneAndUpdate(
    {
      _id: userId,
      isDeleted: false,
    },
    {
      activeContext: {
        workspaceId: activeContext.workspaceId || null,
        companyId: null,
        branchId: null,
        updatedAt: new Date(),
      },
    },
    {
      new: true,
      runValidators: true,
    },
  );
};

const clearActiveContext = async (userId) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return null;
  }

  return User.findOneAndUpdate(
    {
      _id: userId,
      isDeleted: false,
    },
    {
      activeContext: {
        workspaceId: null,
        companyId: null,
        branchId: null,
        updatedAt: new Date(),
      },
    },
    {
      new: true,
      runValidators: true,
    },
  );
};

const deleteUserById = async (userId) => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return null;
  }

  return User.findOneAndUpdate(
    {
      _id: userId,
      isDeleted: false,
    },
    {
      isDeleted: true,
      isActive: false,
    },
    {
      new: true,
      runValidators: true,
    },
  );
};

export default {
  findUserById,
  findUserByEmail,
  findUserByPhone,

  saveUser,

  updateActiveContext,
  clearActiveContext,

  deleteUserById,
};
