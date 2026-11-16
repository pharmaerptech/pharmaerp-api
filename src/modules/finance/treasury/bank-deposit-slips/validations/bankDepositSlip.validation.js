import Joi from "joi";
import { BANK_DEPOSIT_SLIP_STATUS } from "../constants/bankDepositSlip.constant.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const objectId = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    "string.pattern.base": "Invalid ID format",
  });

/** Valid Indian currency denominations (same as FundTransfer) */
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

// ── Create Bank Deposit Slip ──────────────────────────────────────────────────

export const createBankDepositSlipSchema = Joi.object({
  slipDate: Joi.date().required().messages({
    "any.required": "Slip date is required",
    "date.base": "Slip date must be a valid date",
  }),

  branchId: objectId.required().messages({
    "any.required": "Branch ID is required",
  }),

  toBankAccountId: objectId.required().messages({
    "any.required": "Destination bank account ID is required",
  }),

  amount: Joi.number().min(0.01).required().messages({
    "any.required": "Deposit amount is required",
    "number.min": "Deposit amount must be greater than zero",
    "number.base": "Deposit amount must be a number",
  }),

  /**
   * Denomination breakdown is MANDATORY for bank deposit slips.
   * These denominations represent the physical notes being bagged and deposited.
   */
  denominations: Joi.array()
    .items(denominationLineSchema)
    .min(1)
    .required()
    .messages({
      "any.required": "Denomination breakdown is required for bank deposit slips",
      "array.min": "At least one denomination line is required",
      "array.base": "denominations must be an array",
    }),

  depositBagReference: Joi.string().trim().max(100).allow(null, "").optional(),

  bankBranchName: Joi.string().trim().max(200).allow(null, "").optional(),

  narration: Joi.string().trim().max(500).allow(null, "").optional(),

  dayClosingId: objectId.allow(null, "").optional(),
  businessDayId: objectId.allow(null, "").optional(),
});

// ── Confirm Deposit ───────────────────────────────────────────────────────────

export const confirmDepositSchema = Joi.object({
  bankReferenceNumber: Joi.string().trim().max(100).allow(null, "").optional(),

  depositConfirmedDate: Joi.date().optional().messages({
    "date.base": "Deposit confirmed date must be a valid date",
  }),
});

// ── Cancel Slip ───────────────────────────────────────────────────────────────

export const cancelBankDepositSlipSchema = Joi.object({
  reason: Joi.string().trim().max(500).allow(null, "").optional(),
});

// ── Param Schemas ─────────────────────────────────────────────────────────────

export const slipIdParamSchema = Joi.object({
  slipId: objectId.required().messages({
    "any.required": "Slip ID parameter is required",
  }),
});

// ── List / Query Schema ───────────────────────────────────────────────────────

export const getBankDepositSlipsQuerySchema = Joi.object({
  search: Joi.string().trim().allow("").optional(),

  status: Joi.string()
    .valid(...Object.values(BANK_DEPOSIT_SLIP_STATUS))
    .optional(),

  fromCashAccountId: objectId.optional(),
  toBankAccountId: objectId.optional(),
  branchId: Joi.string().trim().allow("all", "", null).optional(),
  dayClosingId: objectId.allow(null, "").optional(),
  businessDayId: objectId.allow(null, "").optional(),

  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),

  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(20).optional(),
  all: Joi.boolean().default(false).optional(),
});

// ── Withdraw from Slip ────────────────────────────────────────────────────────

export const withdrawFromSlipSchema = Joi.object({
  amount: Joi.number().min(0.01).required().messages({
    "any.required": "Withdrawal amount is required",
    "number.min": "Withdrawal amount must be greater than zero",
  }),
  denominations: Joi.array()
    .items(denominationLineSchema)
    .min(1)
    .required()
    .messages({
      "any.required": "Denomination breakdown is required",
      "array.min": "At least one denomination line is required",
    }),
  narration: Joi.string().trim().max(500).allow(null, "").optional(),
});

// ── Cash In Transit Query ──────────────────────────────────────────────────────

export const getCashInTransitQuerySchema = Joi.object({
  branchId: Joi.string().trim().allow("all", "", null).optional(),
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(200).default(50).optional(),
});

