import Joi from "joi";

const objectId = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}$/)
  .messages({
    "string.pattern.base": "Invalid id",
  });

const itemSchema = Joi.object({
  productId: objectId.allow(null, "").optional(),
  name: Joi.string().trim().max(300).allow("").optional(),
  pack: Joi.string().trim().max(100).allow("").optional(),
  batch: Joi.string().trim().max(100).required(),
  expiry: Joi.string().trim().max(20).allow("").optional(),
  qty: Joi.number().min(1).required(),
  freeQty: Joi.number().min(0).default(0),
  schPct: Joi.number().min(0).max(100).default(0),
  disc: Joi.number().min(0).max(100).default(0),
  cRatePct: Joi.number().min(0).max(100).default(0),
  mrp: Joi.number().min(0.01).required(),
  hsn: Joi.string().trim().max(20).allow("").optional(),
  gst: Joi.number().min(0).max(100).default(0),
  rate: Joi.number().min(0.01).required(),
  amount: Joi.number().min(0).default(0),
  rateA: Joi.number().min(0).default(0),
  rateB: Joi.number().min(0).default(0),
  rateC: Joi.number().min(0).default(0),
  finalRateA: Joi.number().min(0).default(0),
  finalRateB: Joi.number().min(0).default(0),
  finalRateC: Joi.number().min(0).default(0),
  saleScheme: Joi.number().min(0).default(0),
});

const gstSlabSchema = Joi.object({
  gstPct: Joi.number().min(0).default(0),
  taxable: Joi.number().min(0).default(0),
  cgstAmt: Joi.number().min(0).default(0),
  sgstAmt: Joi.number().min(0).default(0),
  totalTax: Joi.number().min(0).default(0),
});

export const createPurchaseBillSchema = Joi.object({
  branchId: objectId.allow(null).optional(),
  supplierId: objectId.required(),
  purchaseBillNo: Joi.string().trim().max(100).allow("").optional(),
  supplierInvoiceNo: Joi.string().trim().max(100).required(),
  invoiceDate: Joi.string().trim().max(20).allow("").optional(),
  rateBasis: Joi.string().trim().valid("PTS", "PTR").default("PTS"),

  items: Joi.array().items(itemSchema).min(1).required(),

  extraDiscountPct: Joi.number().min(-100).max(100).default(0),
  extraDiscountAmt: Joi.number().default(0),

  grossTotal: Joi.number().min(0).required(),
  schemeDiscount: Joi.number().min(0).default(0),
  tradeDiscount: Joi.number().min(0).default(0),
  taxableSubtotal: Joi.number().min(0).required(),
  taxableAfterExtraDisc: Joi.number().min(0).required(),
  totalGst: Joi.number().min(0).required(),
  grandTotal: Joi.number().min(0).required(),
  amountPaid: Joi.number().min(0).default(0),
  amountDue: Joi.number().min(0).default(0),

  gstSlabs: Joi.array().items(gstSlabSchema).default([]),
});

export const updatePurchaseBillSchema = createPurchaseBillSchema;

export const purchaseBillIdParamSchema = Joi.object({
  billId: objectId.required(),
});

export const getPurchaseBillsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
  sort: Joi.string().trim().max(50).optional(),
  search: Joi.string().trim().max(100).allow("").optional(),
  supplierId: objectId.optional(),
  branchId: Joi.string().trim().allow("all", "", null).optional(),
  status: Joi.string().trim().optional(),
});
