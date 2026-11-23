import mongoose from "mongoose";

const stockAdjustmentSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    facility_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    branch_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      index: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkspaceProduct",
      required: true,
      index: true,
    },
    sourceBatch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
      index: true,
    },
    targetScrapBatch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      default: null,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    reason: {
      type: String,
      enum: ["EXPIRED", "BROKEN", "FRESH_RETURN", "GENERAL_RETURN"],
      required: true,
      index: true,
    },
    destination: {
      type: String,
      enum: ["SHELF", "SCRAP"],
      default: "SCRAP",
      index: true,
    },
    action: {
      type: String,
      enum: ["QUARANTINE", "INGEST_INVENTORY", "DEDUCT_SHELF"],
      default: "QUARANTINE",
      index: true,
    },
    remarks: {
      type: String,
      trim: true,
      default: "",
    },
    unitCost: {
      type: Number,
      default: 0,
    },
    mrp: {
      type: Number,
      default: 0,
    },
    totalLossValue: {
      type: Number,
      default: 0,
    },
    adjustmentDate: {
      type: Date,
      default: Date.now,
      index: true,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
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

stockAdjustmentSchema.pre("save", function () {
  if (!this.branch_id && this.facility_id) {
    this.branch_id = this.facility_id;
  } else if (!this.facility_id && this.branch_id) {
    this.facility_id = this.branch_id;
  }
});

export const StockAdjustment = mongoose.model("StockAdjustment", stockAdjustmentSchema);
export default StockAdjustment;

