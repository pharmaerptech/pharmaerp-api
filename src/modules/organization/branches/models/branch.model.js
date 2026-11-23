import mongoose from "mongoose";

import {
  BRANCH_STATUS,
  BRANCH_TYPE,
  BRANCH_CODE_PREFIX,
} from "../constants/branch.constant.js";

const ADDRESS_SCHEMA = new mongoose.Schema(
  {
    addressLine1: {
      type: String,
      trim: true,
      default: null,
    },
    addressLine2: {
      type: String,
      trim: true,
      default: null,
    },
    city: {
      type: String,
      trim: true,
      default: null,
    },
    district: {
      type: String,
      trim: true,
      default: null,
    },
    state: {
      type: String,
      trim: true,
      default: null,
    },
    country: {
      type: String,
      trim: true,
      default: "India",
    },
    pincode: {
      type: String,
      trim: true,
      default: null,
    },
    googleMapLocation: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: false },
);

const PHONE_SCHEMA = new mongoose.Schema(
  {
    mobile: {
      type: String,
      trim: true,
      match: [/^[6-9][0-9]{9}$/, "Invalid mobile number"],
      default: null,
    },
    whatsapp: {
      type: String,
      trim: true,
      match: [/^[6-9][0-9]{9}$/, "Invalid WhatsApp number"],
      default: null,
    },
    landline: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: false },
);

const PHARMACIST_SCHEMA = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      default: null,
    },
    registrationNumber: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },
    mobile: {
      type: String,
      trim: true,
      match: [/^[6-9][0-9]{9}$/, "Invalid pharmacist mobile number"],
      default: null,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: [200, "Email cannot exceed 200 characters"],
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email address"],
      default: null,
    },
  },
  { _id: false },
);

const EMERGENCY_CONTACT_SCHEMA = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      default: null,
    },
    mobile: {
      type: String,
      trim: true,
      match: [/^[6-9][0-9]{9}$/, "Invalid emergency contact mobile number"],
      default: null,
    },
    relationship: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: false },
);

const LICENSE_SCHEMA = new mongoose.Schema(
  {
    drugLicenseNumber: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },
    drugLicenseType: {
      type: String,
      trim: true,
      default: null,
    },
    fssaiNumber: {
      type: String,
      trim: true,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const branchSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: [true, "Workspace is required"],
      index: true,
    },

    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: [true, "Company is required"],
      index: true,
    },

    branchCode: {
      type: String,
      trim: true,
      uppercase: true,
    },

    name: {
      type: String,
      required: [true, "Branch name is required"],
      trim: true,
      minlength: [2, "Branch name must be at least 2 characters"],
      maxlength: [160, "Branch name cannot exceed 160 characters"],
    },

    slug: {
      type: String,
      required: [true, "Branch slug is required"],
      trim: true,
      lowercase: true,
      maxlength: [180, "Branch slug cannot exceed 180 characters"],
      match: [
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Branch slug can only contain lowercase letters, numbers and hyphens",
      ],
    },

    type: {
      type: String,
      enum: Object.values(BRANCH_TYPE),
      default: BRANCH_TYPE.RETAIL,
      index: true,
    },

    isPrimary: {
      type: Boolean,
      default: false,
      index: true,
    },

    isScrapStore: {
      type: Boolean,
      default: false,
      index: true,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: [200, "Email cannot exceed 200 characters"],
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email address"],
      default: null,
    },

    phones: {
      type: PHONE_SCHEMA,
      default: () => ({}),
    },

    address: {
      type: ADDRESS_SCHEMA,
      default: () => ({}),
    },

    license: {
      type: LICENSE_SCHEMA,
      default: () => ({}),
    },

    pharmacist: {
      type: PHARMACIST_SCHEMA,
      default: () => ({}),
    },

    emergencyContact: {
      type: EMERGENCY_CONTACT_SCHEMA,
      default: () => ({}),
    },

    status: {
      type: String,
      enum: Object.values(BRANCH_STATUS),
      default: BRANCH_STATUS.ACTIVE,
      index: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    deletedAt: {
      type: Date,
      default: null,
    },

    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

const generateBranchCode = async () => {
  const Branch = mongoose.models.Branch;

  while (true) {
    const code = `${BRANCH_CODE_PREFIX}${Math.floor(
      100000 + Math.random() * 900000,
    )}`;

    const exists = await Branch.exists({
      branchCode: code,
      isDeleted: false,
    });

    if (!exists) return code;
  }
};

branchSchema.pre("validate", async function () {
  if (!this.branchCode) {
    this.branchCode = await generateBranchCode();
  }

  if (!this.slug && this.name) {
    this.slug = String(this.name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
});

branchSchema.methods.toSafeObject = function () {
  const branch = this.toObject();

  delete branch.__v;

  return branch;
};

branchSchema.index(
  { branchCode: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  },
);

branchSchema.index(
  {
    workspaceId: 1,
    companyId: 1,
    slug: 1,
  },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  },
);

branchSchema.index({ workspaceId: 1, isDeleted: 1 });
branchSchema.index({ companyId: 1, isDeleted: 1 });
branchSchema.index({ workspaceId: 1, companyId: 1, isDeleted: 1 });
branchSchema.index({ workspaceId: 1, companyId: 1, status: 1, isDeleted: 1 });
branchSchema.index({ createdBy: 1, isDeleted: 1 });

const Branch = mongoose.models.Branch || mongoose.model("Branch", branchSchema);

export default Branch;
