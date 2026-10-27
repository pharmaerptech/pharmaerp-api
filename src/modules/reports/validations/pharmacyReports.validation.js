import Joi from "joi";

const objectId = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    "string.pattern.base": "Invalid id format",
  });

export const reportQuerySchema = Joi.object({
  branchId: objectId.optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  date: Joi.date().iso().optional(),
  daysThreshold: Joi.number().integer().min(1).max(365).default(90).optional(),
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(200).default(25).optional(),
  search: Joi.string().trim().allow("").optional(),
});
