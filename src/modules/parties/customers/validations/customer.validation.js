import Joi from "joi";

import {
  CUSTOMER_STATUS,
  CUSTOMER_TYPE,
  CUSTOMER_OPENING_BALANCE_TYPE,
} from "../constants/customer.constant.js";

const objectId = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    "string.pattern.base": "Invalid id",
  });

const addressSchema = Joi.object({
  addressLine1: Joi.string().trim().max(200).allow(null, "").optional(),
  addressLine2: Joi.string().trim().max(200).allow(null, "").optional(),
  city: Joi.string().trim().max(100).allow(null, "").optional(),
  district: Joi.string().trim().max(100).allow(null, "").optional(),
  state: Joi.string().trim().max(100).allow(null, "").optional(),
  country: Joi.string().trim().max(100).allow(null, "").optional(),
  pincode: Joi.string().trim().max(20).allow(null, "").optional(),
});

export const createCustomerSchema = Joi.object({
  branchId: objectId.allow(null).optional(),
  customerCode: Joi.string().trim().uppercase().max(50).allow(null, "").optional(),
  customerType: Joi.string()
    .valid(...Object.values(CUSTOMER_TYPE))
    .optional(),
  name: Joi.string().trim().min(2).max(160).required(),
  mobile: Joi.string()
    .trim()
    .pattern(/^[6-9][0-9]{9}$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid mobile number",
    }),
  alternateMobile: Joi.string()
    .trim()
    .pattern(/^[6-9][0-9]{9}$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid alternate mobile number",
    }),
  email: Joi.string()
    .trim()
    .lowercase()
    .email()
    .max(200)
    .allow(null, "")
    .optional(),
  gstNumber: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid GST Number",
    }),
  panNumber: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid PAN Number",
    }),
  drugLicenseNumber: Joi.string().trim().max(100).allow(null, "").optional(),
  billingAddress: addressSchema.optional(),
  shippingAddress: addressSchema.optional(),
  creditLimit: Joi.number().min(0).optional(),
  creditDays: Joi.number().integer().min(0).optional(),
  openingBalance: Joi.number().min(0).optional(),
  openingBalanceType: Joi.string()
    .valid(...Object.values(CUSTOMER_OPENING_BALANCE_TYPE))
    .optional(),
  notes: Joi.string().trim().max(1000).allow(null, "").optional(),
});

export const updateCustomerSchema = Joi.object({
  branchId: objectId.allow(null).optional(),
  customerCode: Joi.string().trim().uppercase().max(50).allow(null, "").optional(),
  customerType: Joi.string()
    .valid(...Object.values(CUSTOMER_TYPE))
    .optional(),
  name: Joi.string().trim().min(2).max(160).optional(),
  mobile: Joi.string()
    .trim()
    .pattern(/^[6-9][0-9]{9}$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid mobile number",
    }),
  alternateMobile: Joi.string()
    .trim()
    .pattern(/^[6-9][0-9]{9}$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid alternate mobile number",
    }),
  email: Joi.string()
    .trim()
    .lowercase()
    .email()
    .max(200)
    .allow(null, "")
    .optional(),
  gstNumber: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid GST Number",
    }),
  panNumber: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid PAN Number",
    }),
  drugLicenseNumber: Joi.string().trim().max(100).allow(null, "").optional(),
  billingAddress: addressSchema.optional(),
  shippingAddress: addressSchema.optional(),
  creditLimit: Joi.number().min(0).optional(),
  creditDays: Joi.number().integer().min(0).optional(),
  openingBalance: Joi.number().min(0).optional(),
  openingBalanceType: Joi.string()
    .valid(...Object.values(CUSTOMER_OPENING_BALANCE_TYPE))
    .optional(),
  notes: Joi.string().trim().max(1000).allow(null, "").optional(),
  status: Joi.string()
    .valid(...Object.values(CUSTOMER_STATUS))
    .optional(),
}).min(1);

export const customerIdParamSchema = Joi.object({
  customerId: objectId.required(),
});

export const getCustomersQuerySchema = Joi.object({
  search: Joi.string().trim().allow("").optional(),
  name: Joi.string().trim().optional(),
  mobile: Joi.string().trim().optional(),
  gstNumber: Joi.string().trim().optional(),
  customerCode: Joi.string().trim().optional(),
  status: Joi.string()
    .valid(...Object.values(CUSTOMER_STATUS))
    .optional(),
  customerType: Joi.string().trim().optional(),
  isWalkIn: Joi.boolean().optional(),
  sort: Joi.string().trim().optional(),
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(20).optional(),
});

export const receiveAdvanceSchema = Joi.object({
  amount: Joi.number().positive().required(),
  paymentMethod: Joi.string().valid("Cash", "UPI").default("Cash"),
  paymentDetails: Joi.object().optional(),
  cashTendered: Joi.number().min(0).optional(),
  changeDue: Joi.number().min(0).optional(),
  paymentQrId: objectId.allow(null, "").optional(),
  denominations: Joi.array().items(Joi.object({ denomination: Joi.number().required(), quantity: Joi.number().required() })).optional(),
  returnedDenominations: Joi.array().items(Joi.object({ denomination: Joi.number().required(), quantity: Joi.number().required() })).optional(),
  branchId: objectId.allow(null).optional(),
  shiftId: objectId.allow(null).optional(),
  narration: Joi.string().trim().max(500).allow("", null).optional(),
  date: Joi.date().optional(),
});

export const settleCreditSchema = Joi.object({
  settlements: Joi.array()
    .items(
      Joi.object({
        creditTransactionId: objectId.optional(),
        id: objectId.optional(),
        invoiceId: objectId.optional(),
        amount: Joi.number().positive().required(),
      })
    )
    .min(1)
    .required(),
  paymentMethod: Joi.string().valid("Cash", "UPI", "Advance").required(),
  paymentDetails: Joi.object().optional(),
  cashTendered: Joi.number().min(0).optional(),
  changeDue: Joi.number().min(0).optional(),
  paymentQrId: objectId.allow(null, "").optional(),
  denominations: Joi.array().items(Joi.object({ denomination: Joi.number().required(), quantity: Joi.number().required() })).optional(),
  returnedDenominations: Joi.array().items(Joi.object({ denomination: Joi.number().required(), quantity: Joi.number().required() })).optional(),
  branchId: objectId.allow(null).optional(),
  shiftId: objectId.allow(null).optional(),
  narration: Joi.string().trim().max(500).allow("", null).optional(),
  date: Joi.date().optional(),
});

export const getTransactionsQuerySchema = Joi.object({
  status: Joi.string().optional(),
  fromDate: Joi.date().optional(),
  toDate: Joi.date().optional(),
  page: Joi.number().integer().min(1).default(1).optional(),
  limit: Joi.number().integer().min(1).max(100).default(50).optional(),
});

export const getStatementQuerySchema = Joi.object({
  fromDate: Joi.date().optional(),
  toDate: Joi.date().optional(),
});

export const updateCustomerRelationshipSchema = Joi.object({
  relationship: Joi.string()
    .valid(
      "Self",
      "Father",
      "Mother",
      "Brother",
      "Sister",
      "Son",
      "Daughter",
      "Spouse",
      "Other"
    )
    .required(),
  confirmationStatus: Joi.string()
    .valid("suggested", "confirmed")
    .optional(),
  notes: Joi.string().trim().max(500).allow(null, "").optional(),
});

export const addCustomerRelationshipSchema = Joi.object({
  targetCustomerId: objectId.optional(),
  name: Joi.string().trim().min(2).max(160).optional(),
  mobile: Joi.string()
    .trim()
    .pattern(/^[6-9][0-9]{9}$/)
    .allow(null, "")
    .optional(),
  gender: Joi.string().valid("male", "female", "other").allow(null, "").optional(),
  relationship: Joi.string()
    .valid(
      "Self",
      "Father",
      "Mother",
      "Brother",
      "Sister",
      "Son",
      "Daughter",
      "Spouse",
      "Other"
    )
    .required(),
  confirmationStatus: Joi.string()
    .valid("suggested", "confirmed")
    .default("confirmed")
    .optional(),
  notes: Joi.string().trim().max(500).allow(null, "").optional(),
}).or("targetCustomerId", "name");

export const customerRelationshipParamsSchema = Joi.object({
  customerId: objectId.required(),
  targetCustomerId: objectId.required(),
});

