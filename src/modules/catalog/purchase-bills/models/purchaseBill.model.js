import mongoose from "mongoose";
import { PURCHASE_BILL_STATUS } from "../constants/purchaseBill.constant.js";

const purchaseBillItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkspaceProduct",
      default: null,
    },
    name: { type: String, trim: true, default: "" },
    pack: { type: String, trim: true, default: "" },
    batch: { type: String, trim: true, default: "" },
    expiry: { type: String, trim: true, default: "" },
    qty: { type: Number, default: 0 },
    freeQty: { type: Number, default: 0 },
    schPct: { type: Number, default: 0 },
    disc: { type: Number, default: 0 },
    cRatePct: { type: Number, default: 0 },
    mrp: { type: Number, default: 0 },
    hsn: { type: String, trim: true, default: "" },
    gst: { type: Number, default: 0 },
    rate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    rateA: { type: Number, default: 0 },
    rateB: { type: Number, default: 0 },
    rateC: { type: Number, default: 0 },
    finalRateA: { type: Number, default: 0 },
    finalRateB: { type: Number, default: 0 },
    finalRateC: { type: Number, default: 0 },
    saleScheme: { type: Number, default: 0 },
  },
  { _id: true }
);

const gstSlabSchema = new mongoose.Schema(
  {
    gstPct: { type: Number, default: 0 },
    taxable: { type: Number, default: 0 },
    cgstAmt: { type: Number, default: 0 },
    sgstAmt: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
  },
  { _id: false }
);

const purchaseBillSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
    },

    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
      index: true,
    },

    purchaseBillNo: { type: String, trim: true, default: "" },
    supplierInvoiceNo: { type: String, trim: true, default: "" },
    legacyReference: { type: String, trim: true, default: null },
    invoiceDate: { type: String, trim: true, default: "" },
    financialPeriodId: { type: mongoose.Schema.Types.ObjectId, ref: "FinancialPeriod", default: null },
    rateBasis: { type: String, trim: true, default: "PTS" },

    items: [purchaseBillItemSchema],

    extraDiscountPct: { type: Number, default: 0 },
    extraDiscountAmt: { type: Number, default: 0 },

    grossTotal: { type: Number, default: 0 },
    schemeDiscount: { type: Number, default: 0 },
    tradeDiscount: { type: Number, default: 0 },
    taxableSubtotal: { type: Number, default: 0 },
    taxableAfterExtraDisc: { type: Number, default: 0 },
    totalGst: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    amountDue: { type: Number, default: 0 },

    gstSlabs: [gstSlabSchema],

    status: {
      type: String,
      enum: Object.values(PURCHASE_BILL_STATUS),
      default: PURCHASE_BILL_STATUS.CONFIRMED,
      index: true,
    },

    isInterCompany: {
      type: Boolean,
      default: false,
      index: true,
    },

    originSaleInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesInvoice",
      default: null,
      index: true,
    },

    originCompanyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },

    inventoryMaterialized: {
      type: Boolean,
      default: false,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

purchaseBillSchema.index({ workspaceId: 1, companyId: 1, createdAt: -1 });
purchaseBillSchema.index({ workspaceId: 1, supplierId: 1 });
purchaseBillSchema.index({ workspaceId: 1, purchaseBillNo: 1 });

purchaseBillSchema.set("toJSON", { virtuals: true });
purchaseBillSchema.set("toObject", { virtuals: true });

const PurchaseBill =
  mongoose.models.PurchaseBill ||
  mongoose.model("PurchaseBill", purchaseBillSchema);

export default PurchaseBill;
