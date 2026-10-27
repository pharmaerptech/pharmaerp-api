import Joi from "joi";

import {
  BANK_TRANSACTION_PAYMENT_MODE,
  BANK_TRANSACTION_CATEGORY,
} from "../constants/bankTransaction.constant.js";

const objectId = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    "string.pattern.base": "Invalid ID format",
  });

const VALID_TRANSACTION_TYPES = [
  "DEPOSIT",
  "WITHDRAWAL",
  "NEFT",
  "RTGS",
  "IMPS",
  "UPI",
  "CHEQUE",
  "BANK_CHARGES",
  "INTEREST",
  "OTHER",
];

export const directDepositSchema = Joi.object({
  bankAccountId: objectId.required().messages({
    "any.required": "Bank Account is required",
  }),
  amount: Joi.number().positive().min(0.01).required().messages({
    "number.positive": "Deposit amount must be greater than zero",
    "number.min": "Deposit amount must be at least ₹0.01",
    "any.required": "Deposit amount is required",
  }),
  paymentMode: Joi.string()
    .valid(...Object.values(BANK_TRANSACTION_PAYMENT_MODE))
    .default(BANK_TRANSACTION_PAYMENT_MODE.CASH)
    .optional(),
  category: Joi.string()
    .valid(
      BANK_TRANSACTION_CATEGORY.CAPITAL_INFUSION,
      BANK_TRANSACTION_CATEGORY.DIRECT_INCOME,
      BANK_TRANSACTION_CATEGORY.OTHER,
    )
    .default(BANK_TRANSACTION_CATEGORY.CAPITAL_INFUSION)
    .optional(),
  counterpartyAccountId: Joi.alternatives().conditional("category", {
    is: BANK_TRANSACTION_CATEGORY.OTHER,
    then: objectId.required().messages({
      "any.required": "Counterparty account is required when category is Other",
    }),
    otherwise: objectId.allow(null, "").optional(),
  }),
  transactionDate: Joi.date().iso().allow(null, "").optional(),
  referenceNumber: Joi.string().trim().max(100).allow(null, "").optional(),
  narration: Joi.string().trim().max(500).allow(null, "").optional(),
});

export const directWithdrawSchema = Joi.object({
  bankAccountId: objectId.required().messages({
    "any.required": "Bank Account is required",
  }),
  amount: Joi.number().positive().min(0.01).required().messages({
    "number.positive": "Withdrawal amount must be greater than zero",
    "number.min": "Withdrawal amount must be at least ₹0.01",
    "any.required": "Withdrawal amount is required",
  }),
  paymentMode: Joi.string()
    .valid(...Object.values(BANK_TRANSACTION_PAYMENT_MODE))
    .default(BANK_TRANSACTION_PAYMENT_MODE.CASH)
    .optional(),
  category: Joi.string()
    .valid(
      BANK_TRANSACTION_CATEGORY.PERSONAL_USE,
      BANK_TRANSACTION_CATEGORY.DIRECT_EXPENSE,
      BANK_TRANSACTION_CATEGORY.OTHER,
    )
    .default(BANK_TRANSACTION_CATEGORY.PERSONAL_USE)
    .optional(),
  counterpartyAccountId: Joi.alternatives().conditional("category", {
    is: BANK_TRANSACTION_CATEGORY.OTHER,
    then: objectId.required().messages({
      "any.required": "Counterparty account is required when category is Other",
    }),
    otherwise: objectId.allow(null, "").optional(),
  }),
  transactionDate: Joi.date().iso().allow(null, "").optional(),
  referenceNumber: Joi.string().trim().max(100).allow(null, "").optional(),
  narration: Joi.string().trim().max(500).allow(null, "").optional(),
});



export const cancelBankTransactionSchema = Joi.object({
  reason: Joi.string().trim().max(500).allow(null, "").optional(),
});

export const bankTransactionIdParamSchema = Joi.object({
  bankTransactionId: objectId.required().messages({
    "any.required": "Bank Transaction ID parameter is required",
  }),
});

export const getBankTransactionsQuerySchema = Joi.object({
  search: Joi.string().trim().allow("").optional(),
  bankAccountId: Joi.alternatives().try(objectId, Joi.string().valid("all")).optional(),
  transactionType: Joi.string().valid(...VALID_TRANSACTION_TYPES, "all").optional(),
  category: Joi.string().valid(...Object.values(BANK_TRANSACTION_CATEGORY), "all").optional(),
  direction: Joi.string().valid("CREDIT", "DEBIT", "all").optional(),
  status: Joi.string().valid("DRAFT", "POSTED", "CANCELLED", "PENDING_SHIFT_CLOSE", "all").optional(),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(20).optional(),
  all: Joi.boolean().default(false).optional(),
  sortBy: Joi.string().trim().optional(),
  sortOrder: Joi.string().valid("asc", "desc").optional(),
});
