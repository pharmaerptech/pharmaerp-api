import Joi from "joi";

const objectId = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    "string.pattern.base": "Invalid ID format",
  });

const VALID_PROVIDERS = [
  "GPAY",
  "PHONEPE",
  "PAYTM",
  "BHIM",
  "RAZORPAY",
  "CASHFREE",
  "OTHER",
];

// UPI ID format: username@bankhandle (e.g. store@oksbi, pay@upi)
const upiIdPattern = /^[a-zA-Z0-9._-]+@[a-zA-Z]{2,}$/;

export const createPaymentQrSchema = Joi.object({
  branchId: objectId.optional(),
  bankAccountId: objectId.required().messages({
    "any.required": "Bank Account ID is required",
  }),
  upiId: Joi.string()
    .trim()
    .lowercase()
    .pattern(upiIdPattern)
    .required()
    .messages({
      "any.required": "UPI ID is required",
      "string.empty": "UPI ID cannot be empty",
      "string.pattern.base": "Invalid UPI ID format (e.g. store@oksbi)",
    }),
  label: Joi.string().trim().max(100).allow(null, "").optional(),
  provider: Joi.string()
    .valid(...VALID_PROVIDERS)
    .default("OTHER")
    .optional(),
  qrImageUrl: Joi.string().trim().uri().allow(null, "").optional().messages({
    "string.uri": "QR image URL must be a valid URL",
  }),
  isPrimary: Joi.boolean().default(false).optional(),
});

export const updatePaymentQrSchema = Joi.object({
  label: Joi.string().trim().max(100).allow(null, "").optional(),
  provider: Joi.string().valid(...VALID_PROVIDERS).optional(),
  qrImageUrl: Joi.string().trim().uri().allow(null, "").optional().messages({
    "string.uri": "QR image URL must be a valid URL",
  }),
  status: Joi.string().valid("ACTIVE", "INACTIVE").optional(),
  isPrimary: Joi.boolean().optional(),
}).min(1);

export const paymentQrIdParamSchema = Joi.object({
  paymentQrId: objectId.required().messages({
    "any.required": "Payment QR ID parameter is required",
  }),
});

export const getPaymentQrsQuerySchema = Joi.object({
  branchId: Joi.string().trim().allow("all", "", null).optional(),
  bankAccountId: objectId.optional(),
  provider: Joi.string().valid(...VALID_PROVIDERS).optional(),
  status: Joi.string().valid("ACTIVE", "INACTIVE").optional(),
  isPrimary: Joi.boolean().optional(),
  search: Joi.string().trim().allow("").optional(),
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(20).optional(),
  all: Joi.boolean().default(false).optional(),
});

export const getUpiTransactionsQuerySchema = Joi.object({
  paymentQrId: objectId.allow("", null).optional(),
  branchId: Joi.alternatives().try(objectId, Joi.string().valid("all")).allow("", null).optional(),
  sourceType: Joi.string()
    .valid("all", "invoice", "credit_settlement", "advance")
    .default("all")
    .optional(),
  startDate: Joi.string().isoDate().allow("", null).optional(),
  endDate: Joi.string().isoDate().allow("", null).optional(),
  search: Joi.string().trim().allow("").optional(),
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(20).optional(),
  sortBy: Joi.string().valid("date", "amount", "referenceno").default("date").optional(),
  sortOrder: Joi.string().valid("asc", "desc").default("desc").optional(),
});

