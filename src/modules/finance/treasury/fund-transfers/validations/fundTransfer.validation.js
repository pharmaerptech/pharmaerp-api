import Joi from "joi";

const objectId = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    "string.pattern.base": "Invalid ID format",
  });

// Valid Indian currency denominations
const VALID_DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1];

const denominationLineSchema = Joi.object({
  denomination: Joi.number()
    .valid(...VALID_DENOMINATIONS)
    .required()
    .messages({
      "any.required": "Denomination value is required",
      "any.only": `Denomination must be one of: ${VALID_DENOMINATIONS.join(", ")}`,
    }),
  quantity: Joi.number().integer().min(0).required().messages({
    "any.required": "Quantity is required",
    "number.min": "Quantity cannot be negative",
  }),
});

export const createFundTransferSchema = Joi.object({
  transferDate: Joi.date().required().messages({
    "any.required": "Transfer date is required",
    "date.base": "Transfer date must be a valid date",
  }),

  fromAccountType: Joi.string().valid("BANK", "CASH").required().messages({
    "any.required": "Source account type is required",
    "any.only": "Source account type must be BANK or CASH",
  }),

  fromAccountId: objectId.required().messages({
    "any.required": "Source account ID is required",
  }),

  toAccountType: Joi.string().valid("BANK", "CASH").required().messages({
    "any.required": "Destination account type is required",
    "any.only": "Destination account type must be BANK or CASH",
  }),

  toAccountId: objectId.required().messages({
    "any.required": "Destination account ID is required",
  }),

  amount: Joi.number().min(0.01).required().messages({
    "any.required": "Amount is required",
    "number.min": "Amount must be greater than zero",
    "number.base": "Amount must be a number",
  }),

  referenceNumber: Joi.string().trim().max(100).allow(null, "").optional(),

  narration: Joi.string().trim().max(500).allow(null, "").optional(),

  shiftId: objectId.allow(null, "").optional(),
  dayClosingId: objectId.allow(null, "").optional(),
  businessDayId: objectId.allow(null, "").optional(),

  // REQUIRED when fromAccountType = "CASH".
  // Denomination breakdown is mandatory for any cash movement.
  fromDenominations: Joi.when("fromAccountType", {
    is: "CASH",
    then: Joi.array()
      .items(denominationLineSchema)
      .min(1)
      .required()
      .messages({
        "any.required": "Denomination breakdown (fromDenominations) is required when source account is a cash account",
        "array.min": "At least one denomination line is required in fromDenominations",
        "array.base": "fromDenominations must be an array",
      }),
    otherwise: Joi.array().items(denominationLineSchema).optional(),
  }),

  // REQUIRED when toAccountType = "CASH".
  toDenominations: Joi.when("toAccountType", {
    is: "CASH",
    then: Joi.array()
      .items(denominationLineSchema)
      .min(1)
      .required()
      .messages({
        "any.required": "Denomination breakdown (toDenominations) is required when destination account is a cash account",
        "array.min": "At least one denomination line is required in toDenominations",
        "array.base": "toDenominations must be an array",
      }),
    otherwise: Joi.array().items(denominationLineSchema).optional(),
  }),
});


export const cancelFundTransferSchema = Joi.object({
  reason: Joi.string().trim().max(500).allow(null, "").optional(),
});

export const fundTransferIdParamSchema = Joi.object({
  fundTransferId: objectId.required().messages({
    "any.required": "Fund Transfer ID parameter is required",
  }),
});

export const getFundTransfersQuerySchema = Joi.object({
  companyId: objectId.optional(),
  search: Joi.string().trim().allow("").optional(),
  transferType: Joi.string()
    .valid("BANK_TO_BANK", "CASH_TO_BANK", "BANK_TO_CASH", "CASH_TO_CASH")
    .optional(),
  status: Joi.string().valid("DRAFT", "POSTED", "CANCELLED").optional(),
  fromAccountType: Joi.string().valid("BANK", "CASH").optional(),
  toAccountType: Joi.string().valid("BANK", "CASH").optional(),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(20).optional(),
  all: Joi.boolean().default(false).optional(),
}).unknown(true);
