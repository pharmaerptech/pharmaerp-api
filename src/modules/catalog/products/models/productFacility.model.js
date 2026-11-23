import mongoose from "mongoose";

const productFacilitySchema = new mongoose.Schema(
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

    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkspaceProduct",
      required: true,
      index: true,
    },

    itemCode: {
      type: String,
      trim: true,
      index: true,
    },

    total_qty_available: {
      type: Number,
      required: true,
      default: 0,
    },

    consumption: {
      type: Number,
      default: 0,
    },

    qoh: {
      type: Number,
      default: 0,
    },

    atp: {
      type: Number,
      default: 0,
    },

    scrapQty: {
      type: Number,
      default: 0,
    },

    expiredQty: {
      type: Number,
      default: 0,
    },

    brokenQty: {
      type: Number,
      default: 0,
    },

    poStatus: {
      type: String,
      enum: ["NONE", "PO_PLACED"],
      default: "NONE",
      index: true,
    },

    poOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SupplierOrder",
      default: null,
    },

    poPlacedAt: {
      type: Date,
      default: null,
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

// Virtual alias for _id
productFacilitySchema.virtual("productFacilityId").get(function () {
  return this._id;
});

productFacilitySchema.index(
  { workspaceId: 1, facility_id: 1, product_id: 1 },
  { unique: true }
);

productFacilitySchema.set("toJSON", { virtuals: true });
productFacilitySchema.set("toObject", { virtuals: true });

const ProductFacility =
  mongoose.models.ProductFacility ||
  mongoose.model("ProductFacility", productFacilitySchema);

export default ProductFacility;
