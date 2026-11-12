// src/modules/core/access-control/validations/role.validation.js

import Joi from "joi";

import { ROLE_STATUS } from "../constants/role.constant.js";
import {
  VALID_WORK_MODES,
  WORK_LEVELS,
} from "../utils/workAccess.helper.js";
import { ALL_PERMISSIONS } from "../constants/permission.constant.js";

const objectId = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    "string.pattern.base": "Invalid id",
  });

export const createRoleSchema = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),

  code: Joi.string()
    .trim()
    .lowercase()
    .max(100)
    .pattern(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
    .optional()
    .messages({
      "string.pattern.base":
        "Role code can only contain lowercase letters, numbers and underscores",
    }),

  description: Joi.string().trim().max(500).allow(null, "").optional(),

  workModes: Joi.array()
    .items(Joi.string().valid(...VALID_WORK_MODES))
    .min(1)
    .unique()
    .optional(),

  workLevel: Joi.string()
    .valid(...Object.values(WORK_LEVELS))
    .optional(),

  permissions: Joi.array()
    .items(Joi.string().valid(...ALL_PERMISSIONS))
    .default([])
    .optional(),
});

export const updateRoleSchema = Joi.object({
  name: Joi.string().trim().min(2).max(80).optional(),

  description: Joi.string().trim().max(500).allow(null, "").optional(),

  workModes: Joi.array()
    .items(Joi.string().valid(...VALID_WORK_MODES))
    .min(1)
    .unique()
    .optional(),

  workLevel: Joi.string()
    .valid(...Object.values(WORK_LEVELS))
    .optional(),

  permissions: Joi.array()
    .items(Joi.string().valid(...ALL_PERMISSIONS))
    .optional(),

  status: Joi.string()
    .valid(...Object.values(ROLE_STATUS))
    .optional(),
});

export const assignRoleToMemberParamsSchema = Joi.object({
  memberUserId: objectId.required(),
});

export const assignRoleToMemberBodySchema = Joi.object({
  roleId: objectId.required(),
});
