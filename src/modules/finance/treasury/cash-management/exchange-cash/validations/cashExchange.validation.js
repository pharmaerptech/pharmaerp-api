import Joi from "joi";

const objectId = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    "string.pattern.base": "Invalid ID format",
  });

// Valid Indian currency denominations (notes + coins)
const VALID_DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1];

const denominationLineSchema = Joi.object({
  denomination: Joi.number()
    .valid(...VALID_DENOMINATIONS)
    .required()
    .messages({
      "any.required": "Denomination value is required",
      "any.only": `Denomination must be one of: ${VALID_DENOMINATIONS.join(", ")}`,
    }),
  quantity: Joi.number().integer().min(1).required().messages({
    "any.required": "Quantity is required",
    "number.min": "Quantity must be at least 1",
    "number.integer": "Quantity must be a whole number",
  }),
});

/**
 * Compute the monetary total of a denominations array.
 * Expects items with { denomination, quantity }.
 */
const computeTotal = (denominations) =>
  denominations.reduce((sum, d) => sum + d.denomination * d.quantity, 0);

export const createCashExchangeSchema = Joi.object({
  exchangeDate: Joi.date().required().messages({
    "any.required": "Exchange date is required",
    "date.base": "Exchange date must be a valid date",
  }),

  cashPartition: Joi.string()
    .valid("running")
    .default("running")
    .optional()
    .messages({
      "any.only": "Cash exchange is only permitted from an active running cash drawer",
    }),


  // Denominations received FROM the customer (what they handed you)
  denominationsReceived: Joi.array()
    .items(denominationLineSchema)
    .min(1)
    .required()
    .messages({
      "any.required": "Denominations received is required",
      "array.min": "At least one denomination must be listed under denominationsReceived",
      "array.base": "denominationsReceived must be an array",
    }),

  // Denominations given OUT to the customer (the change you give back)
  denominationsGiven: Joi.array()
    .items(denominationLineSchema)
    .min(1)
    .required()
    .messages({
      "any.required": "Denominations given is required",
      "array.min": "At least one denomination must be listed under denominationsGiven",
      "array.base": "denominationsGiven must be an array",
    }),

  narration: Joi.string().trim().max(500).allow(null, "").optional(),

  notes: Joi.string().trim().max(500).allow(null, "").optional(),
}).custom((value, helpers) => {
  // Cross-field constraint: totalReceived MUST equal totalGiven
  // This is the fundamental accounting invariant of an exchange transaction.
  const totalReceived = computeTotal(value.denominationsReceived);
  const totalGiven = computeTotal(value.denominationsGiven);

  if (Math.round(totalReceived * 100) !== Math.round(totalGiven * 100)) {
    return helpers.error("any.invalid", {
      message: `Exchange imbalance: total received (₹${totalReceived}) does not equal total given (₹${totalGiven}). Both sides must be equal.`,
    });
  }

  if (totalReceived <= 0) {
    return helpers.error("any.invalid", {
      message: "Exchange amount must be greater than zero",
    });
  }

  return value;
}, "exchange balance validation");

export const cashExchangeIdParamSchema = Joi.object({
  cashExchangeId: objectId.required().messages({
    "any.required": "Cash Exchange ID parameter is required",
  }),
});

export const getCashExchangesQuerySchema = Joi.object({
  search: Joi.string().trim().allow("").optional(),
  branchId: Joi.string().trim().allow("all", "", null).optional(),
  shiftId: objectId.optional(),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(20).optional(),
  all: Joi.boolean().default(false).optional(),
});
