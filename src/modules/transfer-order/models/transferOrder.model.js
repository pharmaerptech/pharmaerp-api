import mongoose from "mongoose";

const transferOrderItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkspaceProduct",
      required: true,
    },
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
    },
    batchNo: {
      type: String,
      required: true,
    },
    originalBatchNo: {
      type: String,
      default: "",
    },
    scrapType: {
      type: String,
      enum: ["NONE", "EXPIRED", "BROKEN", "SCRAP", "FRESH_RETURN"],
      default: "NONE",
    },
    sourceBin: {
      type: String,
      enum: ["SELLABLE", "SCRAP"],
      default: "SELLABLE",
    },
    transferQty: {
      type: Number,
      required: true,
      min: [1, "Transfer quantity must be at least 1"],
    },
  },
  { _id: true } // keep id for items in case they need to be updated
);

const transferOrderSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    transferType: {
      type: String,
      enum: ["STANDARD", "SCRAP"],
      default: "STANDARD",
      index: true,
    },
    transferNo: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    sourceBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    destinationBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "IN_TRANSIT", "COMPLETED", "CANCELLED"],
      default: "IN_TRANSIT",
      index: true,
    },
    items: [transferOrderItemSchema],
    remarks: {
      type: String,
      trim: true,
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    receivedAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelReason: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true, strictPopulate: false }
);

// Virtual alias for _id
transferOrderSchema.virtual("transferOrderId").get(function () {
  return this._id;
});

transferOrderSchema.set("toJSON", { virtuals: true });
transferOrderSchema.set("toObject", { virtuals: true });

const TransferOrder = mongoose.models.TransferOrder || mongoose.model("TransferOrder", transferOrderSchema);

export default TransferOrder;
