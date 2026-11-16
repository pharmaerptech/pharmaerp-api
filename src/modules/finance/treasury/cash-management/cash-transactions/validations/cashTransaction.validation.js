import Joi from "joi";

const objectId = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    "string.pattern.base": "Invalid ID format",
  });

const VALID_TRANSACTION_TYPES = [
  "CASH_IN",
  "CASH_OUT",
  "EXPENSE",
  "PETTY_CASH",
  "OTHER",
];

const VALID_DIRECTIONS = ["CREDIT", "DEBIT"];

export const cancelCashTransactionSchema = Joi.object({
  reason: Joi.string().trim().max(500).allow(null, "").optional(),
});

export const cashTransactionIdParamSchema = Joi.object({
  cashTransactionId: objectId.required().messages({
    "any.required": "Cash Transaction ID parameter is required",
  }),
});

export const getCashTransactionsQuerySchema = Joi.object({
  branchId: Joi.string().trim().allow("all", "", null).optional(),
  partition: Joi.string().valid("running", "frozen").optional(),
  transactionType: Joi.string().valid(...VALID_TRANSACTION_TYPES).optional(),
  direction: Joi.string().valid(...VALID_DIRECTIONS).optional(),
  status: Joi.string().valid("DRAFT", "POSTED", "CANCELLED").optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  search: Joi.string().trim().allow("").optional(),
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(20).optional(),
  all: Joi.boolean().default(false).optional(),
});
