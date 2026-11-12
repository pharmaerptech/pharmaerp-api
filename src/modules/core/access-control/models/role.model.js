// src/modules/core/access-control/models/role.model.js

import mongoose from "mongoose";

import { ROLE_STATUS } from "../constants/role.constant.js";
import {
  normalizeRoleWorkAccess,
  VALID_WORK_MODES,
  WORK_LEVELS,
  WORK_MODES,
} from "../utils/workAccess.helper.js";
import { ALL_PERMISSIONS } from "../constants/permission.constant.js";

const roleSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: [true, "Workspace is required"],
      index: true,
    },

    name: {
      type: String,
      required: [true, "Role name is required"],
      trim: true,
      minlength: [2, "Role name must be at least 2 characters"],
      maxlength: [80, "Role name cannot exceed 80 characters"],
    },

    code: {
      type: String,
      required: [true, "Role code is required"],
      trim: true,
      lowercase: true,
      maxlength: [100, "Role code cannot exceed 100 characters"],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [500, "Description cannot exceed 500 characters"],
      default: null,
    },

    permissions: {
      type: [String],
      default: [],
      validate: {
        validator(value) {
          return value.every((permission) =>
            ALL_PERMISSIONS.includes(permission),
          );
        },
        message: "Invalid permission found",
      },
    },

    workModes: {
      type: [String],
      enum: VALID_WORK_MODES,
      default: undefined,
      validate: {
        validator(value) {
          return Array.isArray(value) && value.length > 0;
        },
        message: "At least one work mode is required",
      },
    },

    workLevel: {
      type: String,
      enum: Object.values(WORK_LEVELS),
      default: undefined,
      index: true,
    },

    isSystem: {
      type: Boolean,
      default: false,
      index: true,
    },

    isEditable: {
      type: Boolean,
      default: true,
    },

    status: {
      type: String,
      enum: Object.values(ROLE_STATUS),
      default: ROLE_STATUS.ACTIVE,
      index: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    deletedAt: {
      type: Date,
      default: null,
    },

    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

roleSchema.pre("validate", function syncWorkModeAndLevel() {
  const shouldPreferPermissionModes =
    this.isModified("permissions") && !this.isModified("workModes");
  const shouldPreferPermissionLevel =
    this.isModified("permissions") && !this.isModified("workLevel");

  const normalized = normalizeRoleWorkAccess({
    permissions: this.permissions || [],
    workModes: shouldPreferPermissionModes ? undefined : this.workModes,
    workLevel: shouldPreferPermissionLevel ? undefined : this.workLevel,
    roleCode: this.code,
  });

  this.workModes = normalized.workModes;
  this.workLevel = normalized.workLevel;
  this.permissions = normalized.syncedPermissions;
});

roleSchema.methods.toSafeObject = function () {
  const role = this.toObject();

  delete role.__v;

  return role;
};

roleSchema.index(
  {
    workspaceId: 1,
    code: 1,
  },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  },
);

roleSchema.index({ workspaceId: 1, isDeleted: 1 });
roleSchema.index({ workspaceId: 1, status: 1, isDeleted: 1 });
roleSchema.index({ workspaceId: 1, isSystem: 1, isDeleted: 1 });
roleSchema.index({ createdBy: 1, isDeleted: 1 });

const Role = mongoose.models.Role || mongoose.model("Role", roleSchema);

export default Role;
