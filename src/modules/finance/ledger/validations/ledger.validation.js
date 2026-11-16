import Joi from "joi";

const objectId = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    "string.pattern.base": "Invalid id",
  });

export const getLedgerQuerySchema = Joi.object({
  accountId: objectId.optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(20).optional(),
  all: Joi.boolean().default(false).optional(),
  sort: Joi.string().trim().optional(),
  branchId: objectId.optional(),
  companyId: objectId.optional(),
}).unknown(true);

export const recalculateLedgerSchema = Joi.object({
  accountId: objectId.required(),
});
