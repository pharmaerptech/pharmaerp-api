import Joi from "joi";

import {
  COMPANY_STATUS,
  COMPANY_TYPE,
  COMPANY_LICENSE_STATUS,
} from "../constants/company.constant.js";

const imageSchema = Joi.object({
  publicId: Joi.string().trim().allow(null, "").optional(),

  url: Joi.string().trim().uri().allow(null, "").optional(),
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

const phoneSchema = Joi.object({
  mobile: Joi.string()
    .trim()
    .pattern(/^[6-9][0-9]{9}$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid mobile number",
    }),

  whatsapp: Joi.string()
    .trim()
    .pattern(/^[6-9][0-9]{9}$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid WhatsApp number",
    }),

  landline: Joi.string().trim().max(30).allow(null, "").optional(),
});

const personSchema = Joi.object({
  name: Joi.string().trim().max(120).allow(null, "").optional(),

  email: Joi.string()
    .trim()
    .lowercase()
    .email()
    .max(200)
    .allow(null, "")
    .optional(),

  mobile: Joi.string()
    .trim()
    .pattern(/^[6-9][0-9]{9}$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid mobile number",
    }),

  aadhaar: Joi.string()
    .trim()
    .pattern(/^[0-9]{12}$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid Aadhaar number",
    }),

  pan: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid PAN number",
    }),
});

const licenseSchema = Joi.object({
  licenseType: Joi.string().trim().max(100).allow(null, "").optional(),

  retailLicenseNumber: Joi.string()
    .trim()
    .uppercase()
    .max(100)
    .allow(null, "")
    .optional(),

  wholesaleLicenseNumber: Joi.string()
    .trim()
    .uppercase()
    .max(100)
    .allow(null, "")
    .optional(),

  fssaiNumber: Joi.string().trim().max(100).allow(null, "").optional(),

  issuedAt: Joi.date().allow(null).optional(),

  expiresAt: Joi.date().allow(null).optional(),

  status: Joi.string()
    .valid(...Object.values(COMPANY_LICENSE_STATUS))
    .optional(),

  document: imageSchema.allow(null).optional(),
});

export const createCompanySchema = Joi.object({
  name: Joi.string().trim().min(2).max(160).required(),

  type: Joi.string()
    .valid(...Object.values(COMPANY_TYPE))
    .optional(),

  industry: Joi.string().trim().max(100).allow(null, "").optional(),

  logo: imageSchema.allow(null).optional(),

  email: Joi.string()
    .trim()
    .lowercase()
    .email()
    .max(200)
    .allow(null, "")
    .optional(),

  phones: phoneSchema.optional(),

  website: Joi.string()
    .trim()
    .lowercase()
    .uri()
    .max(250)
    .allow(null, "")
    .optional(),

  address: addressSchema.optional(),

  gstin: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid GSTIN",
    }),

  pan: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid PAN number",
    }),

  owner: personSchema.optional(),

  license: licenseSchema.optional(),
});

export const updateCompanySchema = Joi.object({
  name: Joi.string().trim().min(2).max(160).optional(),

  type: Joi.string()
    .valid(...Object.values(COMPANY_TYPE))
    .optional(),

  industry: Joi.string().trim().max(100).allow(null, "").optional(),

  logo: imageSchema.allow(null).optional(),

  email: Joi.string()
    .trim()
    .lowercase()
    .email()
    .max(200)
    .allow(null, "")
    .optional(),

  phones: phoneSchema.allow(null).optional(),

  website: Joi.string()
    .trim()
    .lowercase()
    .uri()
    .max(250)
    .allow(null, "")
    .optional(),

  address: addressSchema.allow(null).optional(),

  gstin: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid GSTIN",
    }),

  pan: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/)
    .allow(null, "")
    .optional()
    .messages({
      "string.pattern.base": "Invalid PAN number",
    }),

  owner: personSchema.allow(null).optional(),

  license: licenseSchema.allow(null).optional(),

  status: Joi.string()
    .valid(...Object.values(COMPANY_STATUS))
    .optional(),
});
