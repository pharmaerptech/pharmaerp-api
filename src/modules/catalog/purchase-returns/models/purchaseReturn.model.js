import mongoose from "mongoose";
import {
  PURCHASE_RETURN_STATUS,
  RETURN_MOTIVE,
  SETTLEMENT_TYPE,
  SETTLEMENT_STATUS,
} from "../constants/purchaseReturn.constant.js";

const purchaseReturnItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkspaceProduct",
      required: true,
    },
    productName: { type: String, trim: true, default: "" },
    pack: { type: String, trim: true, default: "" },
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
    },
    batchNo: { type: String, trim: true, required: true },
    expiry: { type: String, trim: true, default: "" },

    purchaseBillId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseBill",
      default: null,
      index: true,
    },
    purchaseBillNo: { type: String, trim: true, default: "" },
    purchaseBillDate: { type: String, trim: true, default: "" },

    sourceBin: {
      type: String,
      enum: ["SELLABLE", "SCRAP_EXPIRED", "SCRAP_BROKEN", "SCRAP_FRESH"],
      default: "SELLABLE",
    },

    isIncoming: { type: Boolean, default: false },
    sourceBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },
    sourceTransferOrderNo: { type: String, trim: true, default: "" },
    sourceTransferOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TransferOrder",
      default: null,
    },

    subSupplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },
    subSupplierName: { type: String, trim: true, default: "" },
    subSupplierGst: { type: String, trim: true, default: "" },

    returnQty: { type: Number, required: true, min: 1 },
    rate: { type: Number, required: true, default: 0 },
    discountPct: { type: Number, default: 0 },
    taxableAmount: { type: Number, required: true, default: 0 },
    gstPct: { type: Number, default: 0 },
    cgstAmt: { type: Number, default: 0 },
    sgstAmt: { type: Number, default: 0 },
    igstAmt: { type: Number, default: 0 },
    totalGst: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true, default: 0 },
  },
  { _id: true }
);

const gstSlabSchema = new mongoose.Schema(
  {
    gstPct: { type: Number, default: 0 },
    taxable: { type: Number, default: 0 },
    cgstAmt: { type: Number, default: 0 },
    sgstAmt: { type: Number, default: 0 },
    igstAmt: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
  },
  { _id: false }
);

const purchaseReturnSchema = new mongoose.Schema(
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
      required: true,
      index: true,
    },

    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
      index: true,
    },

    sourceBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
    },

    sourceTransferOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TransferOrder",
      default: null,
      index: true,
    },

    isInterBranch: {
      type: Boolean,
      default: false,
      index: true,
    },

    returnNo: { type: String, required: true, trim: true },
    debitNoteNo: { type: String, trim: true, default: "" },
    creditNoteNo: { type: String, trim: true, default: "" },
    creditNoteDate: { type: Date, default: null, index: true },
    returnDate: { type: Date, default: Date.now, index: true },

    returnMotive: {
      type: String,
      enum: Object.values(RETURN_MOTIVE),
      default: RETURN_MOTIVE.SELLABLE,
      index: true,
    },

    settlementType: {
      type: String,
      enum: Object.values(SETTLEMENT_TYPE),
      default: SETTLEMENT_TYPE.DEBIT_NOTE,
    },

    settlementStatus: {
      type: String,
      enum: Object.values(SETTLEMENT_STATUS),
      default: SETTLEMENT_STATUS.PENDING,
      index: true,
    },

    settledAmount: { type: Number, default: 0 },
    adjustedPurchaseBillId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseBill",
      default: null,
    },

    items: [purchaseReturnItemSchema],
    gstSlabs: [gstSlabSchema],

    taxableSubtotal: { type: Number, default: 0 },
    totalGst: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    status: {
      type: String,
      enum: Object.values(PURCHASE_RETURN_STATUS),
      default: PURCHASE_RETURN_STATUS.CONFIRMED,
      index: true,
    },

    financialPeriodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FinancialPeriod",
      default: null,
    },

    journalVoucherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JournalVoucher",
      default: null,
    },

    reason: { type: String, trim: true, default: "" },
    remarks: { type: String, trim: true, default: "" },

    shippingDetails: {
      destinationType: {
        type: String,
        enum: ["COMPANY_BRANCH", "SUPPLIER"],
        default: "COMPANY_BRANCH",
        index: true,
      },
      destinationCompanyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Company",
        default: null,
        index: true,
      },
      destinationBranchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Branch",
        default: null,
        index: true,
      },
      destinationSupplierId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Supplier",
        default: null,
        index: true,
      },
      courierName: { type: String, trim: true, default: "" },
      trackingNo: { type: String, trim: true, default: "" },
      boxCount: { type: Number, default: 1 },
      packageNotes: { type: String, trim: true, default: "" },
      transitStatus: {
        type: String,
        enum: ["NOT_DISPATCHED", "IN_TRANSIT", "RECEIVED"],
        default: "NOT_DISPATCHED",
        index: true,
      },
      dispatchedAt: { type: Date, default: null },
      dispatchedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      receivedAt: { type: Date, default: null },
      receivedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      inventoryMaterialized: {
        type: Boolean,
        default: false,
        index: true,
      },
    },

    ingestionDetails: {
      ingestedToStore: { type: Boolean, default: false, index: true },
      ingestedAt: { type: Date, default: null },
      ingestedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      ingestedBranchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Branch",
        default: null,
      },
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

purchaseReturnSchema.index({ workspaceId: 1, companyId: 1, returnDate: -1 });
purchaseReturnSchema.index({ workspaceId: 1, branchId: 1, returnDate: -1 });
purchaseReturnSchema.index({ workspaceId: 1, supplierId: 1 });
purchaseReturnSchema.index({ workspaceId: 1, returnNo: 1 }, { unique: true });
purchaseReturnSchema.index({ workspaceId: 1, debitNoteNo: 1 });
purchaseReturnSchema.index({ workspaceId: 1, "shippingDetails.destinationBranchId": 1 });
purchaseReturnSchema.index({ workspaceId: 1, "shippingDetails.destinationCompanyId": 1 });
purchaseReturnSchema.index({ workspaceId: 1, "shippingDetails.transitStatus": 1 });

purchaseReturnSchema.set("toJSON", { virtuals: true });
purchaseReturnSchema.set("toObject", { virtuals: true });

const PurchaseReturn =
  mongoose.models.PurchaseReturn ||
  mongoose.model("PurchaseReturn", purchaseReturnSchema);

export default PurchaseReturn;

