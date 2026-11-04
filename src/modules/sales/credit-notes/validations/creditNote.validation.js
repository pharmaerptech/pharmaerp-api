import Joi from "joi";
import { CREDIT_NOTE_STATUS, CREDIT_NOTE_SOURCE } from "../constants/creditNote.constant.js";

const objectId = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    "string.pattern.base": "Invalid ObjectId format",
  });

export const creditNoteIdParamSchema = Joi.object({
  id: Joi.string().trim().required(),
});

export const customerIdParamSchema = Joi.object({
  customerId: objectId.required(),
});

export const queryCreditNotesSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().trim().allow("").optional(),
  status: Joi.string()
    .valid(...Object.values(CREDIT_NOTE_STATUS), "ALL")
    .optional(),
  customerId: objectId.optional(),
  branchId: objectId.optional(),
  source: Joi.string()
    .valid(...Object.values(CREDIT_NOTE_SOURCE))
    .optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  billingMode: Joi.string().valid("B2C", "B2B").optional(),
  sortBy: Joi.string().trim().optional(),
  sortOrder: Joi.string().valid("asc", "desc").optional(),
});

export const createManualCreditNoteSchema = Joi.object({
  customerId: objectId.required(),
  branchId: objectId.allow(null).optional(),
  totalAmount: Joi.number().positive().required(),
  subtotal: Joi.number().min(0).optional(),
  tax: Joi.number().min(0).optional(),
  cgst: Joi.number().min(0).optional(),
  sgst: Joi.number().min(0).optional(),
  igst: Joi.number().min(0).optional(),
  roundOff: Joi.number().optional(),
  billingMode: Joi.string().valid("B2C", "B2B").default("B2C"),
  notes: Joi.string().trim().max(1000).allow(null, "").optional(),
  expiryDays: Joi.number().integer().min(1).max(3650).optional(),
});

export const cancelCreditNoteSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
});

