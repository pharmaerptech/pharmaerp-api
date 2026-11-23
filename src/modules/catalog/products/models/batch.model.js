import mongoose from "mongoose";

const batchSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    branch_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      index: true,
      default: null,
    },

    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkspaceProduct",
      required: true,
      index: true,
    },

    batchNo: {
      type: String,
      required: true,
      trim: true,
    },

    originalBatchNo: {
      type: String,
      trim: true,
      default: "",
    },

    scrapType: {
      type: String,
      enum: ["NONE", "EXPIRED", "BROKEN", "SCRAP", "FRESH_RETURN"],
      default: "NONE",
      index: true,
    },

    mrp: { type: Number, default: 0 },
    MRP: { type: Number, default: 0 },
    ptr: { type: Number, default: 0 },
    pts: { type: Number, default: 0 },
    rate: { type: Number, default: 0 },

    finalRateA: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },
    finalRateB: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },
    finalRateC: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },
    rateA: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },
    rateB: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },
    rateC: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },
    rateD: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },
    rateE: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },

    rateAPercentage: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },
    rateBPercentage: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },
    rateCPercentage: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },
    rateDPercentage: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },
    rateEPercentage: { type: Number, set: (v) => parseFloat(Number(v || 0).toFixed(2)) },

    schemeDiscountPercent: { type: Number, default: 0 },

    isRateA: { type: Boolean, default: false },
    isRateB: { type: Boolean, default: false },
    isRateC: { type: Boolean, default: false },
    isRateD: { type: Boolean, default: false },
    isRateE: { type: Boolean, default: false },

    expiryDate: { type: String, trim: true, default: "" },

    batchQty: { type: Number, default: 0 },
    totalReservedBatchQty: { type: Number, default: 0 },
    expiredQty: { type: Number, default: 0 },
    brokenQty: { type: Number, default: 0 },
    scrapQty: { type: Number, default: 0 },

    description: { type: String, trim: true, default: "" },
    freeScheme: { type: String, trim: true, default: "" },

    purchaseBillId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseBill",
      index: true,
      default: null,
    },

    // Inter-Branch Provenance & Consignment Tracking
    isIncoming: {
      type: Boolean,
      default: false,
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
    sourceTransferOrderNo: {
      type: String,
      trim: true,
      default: "",
    },
    sourceCompanyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },
    sourceConsignmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseReturn",
      default: null,
      index: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

/* Virtual */
batchSchema.virtual("batchId").get(function () {
  return this._id;
});

batchSchema.index(
  { branch_id: 1, product: 1, batchNo: 1, expiryDate: 1 },
  { unique: true }
);

batchSchema.index({ workspaceId: 1, branch_id: 1, product: 1 });

batchSchema.set("toJSON", { virtuals: true });
batchSchema.set("toObject", { virtuals: true });

const Batch = mongoose.models.Batch || mongoose.model("Batch", batchSchema);

export default Batch;
