import mongoose from "mongoose";
import crypto from "crypto";

import {
  CUSTOMER_STATUS,
  CUSTOMER_TYPE,
  CUSTOMER_OPENING_BALANCE_TYPE,
  CUSTOMER_CODE_PREFIX,
} from "../constants/customer.constant.js";

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
  },
  { _id: false },
);

const customerSchema = new mongoose.Schema(
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

    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
    },

    customerCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },

    customerType: {
      type: String,
      enum: Object.values(CUSTOMER_TYPE),
      default: CUSTOMER_TYPE.RETAIL,
      index: true,
    },

    name: {
      type: String,
      required: [true, "Customer name is required"],
      trim: true,
      minlength: [2, "Customer name must be at least 2 characters"],
      maxlength: [160, "Customer name cannot exceed 160 characters"],
    },

    gender: {
      type: String,
      enum: ["male", "female", "other"],
      default: null,
      lowercase: true,
      trim: true,
    },

    mobile: {
      type: String,
      trim: true,
      match: [/^[6-9][0-9]{9}$/, "Invalid mobile number"],
      default: null,
    },

    alternateMobile: {
      type: String,
      trim: true,
      match: [/^[6-9][0-9]{9}$/, "Invalid alternate mobile number"],
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

    gstNumber: {
      type: String,
      trim: true,
      uppercase: true,
      match: [
        /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
        "Invalid GST Number",
      ],
      default: null,
    },

    panNumber: {
      type: String,
      trim: true,
      uppercase: true,
      match: [/^[A-Z]{5}[0-9]{4}[A-Z]$/, "Invalid PAN Number"],
      default: null,
    },

    drugLicenseNumber: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },

    billingAddress: {
      type: ADDRESS_SCHEMA,
      default: () => ({}),
    },

    shippingAddress: {
      type: ADDRESS_SCHEMA,
      default: () => ({}),
    },

    creditLimit: {
      type: Number,
      min: [0, "Credit limit cannot be negative"],
      default: 0,
    },

    creditDays: {
      type: Number,
      min: [0, "Credit days cannot be negative"],
      default: 0,
    },

    openingBalance: {
      type: Number,
      min: [0, "Opening balance cannot be negative"],
      default: 0,
    },

    openingBalanceType: {
      type: String,
      enum: Object.values(CUSTOMER_OPENING_BALANCE_TYPE),
      default: CUSTOMER_OPENING_BALANCE_TYPE.DR,
    },

    advanceBalance: {
      type: Number,
      min: [0, "Advance balance cannot be negative"],
      default: 0,
      index: true,
    },

    creditNoteBalance: {
      type: Number,
      min: [0, "Credit note balance cannot be negative"],
      default: 0,
      index: true,
    },

    creditOutstanding: {
      type: Number,
      min: [0, "Credit outstanding cannot be negative"],
      default: 0,
      index: true,
    },

    ledgerAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
      index: true,
    },

    sharedContactGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SharedContactGroup",
      default: null,
      index: true,
    },

    notes: {
      type: String,
      trim: true,
      maxlength: [1000, "Notes cannot exceed 1000 characters"],
      default: null,
    },

    status: {
      type: String,
      enum: Object.values(CUSTOMER_STATUS),
      default: CUSTOMER_STATUS.ACTIVE,
      index: true,
    },

    isWalkIn: {
      type: Boolean,
      default: false,
      index: true,
    },

    isSystemCustomer: {
      type: Boolean,
      default: false,
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

export const generateCustomerCode = async () => {
  const Customer = mongoose.models.Customer;

  while (true) {
    const code = `${CUSTOMER_CODE_PREFIX}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    if (!Customer || !Customer.db || Customer.db.readyState !== 1) return code;

    const exists = await Customer.exists({
      customerCode: code,
      isDeleted: false,
    });

    if (!exists) return code;
  }
};

customerSchema.pre("validate", async function () {
  if (this.isWalkIn) {
    this.creditLimit = 0;
    this.creditDays = 0;
    this.openingBalance = 0;
    this.advanceBalance = 0;
    this.creditNoteBalance = 0;
    this.creditOutstanding = 0;
  }
  if (this.customerCode === "") {
    this.customerCode = null;
  }
  // Only auto-generate if customerCode is undefined (not passed at all).
  // If caller explicitly sets null, keep it null so customerCode can be skipped cleanly!
  if (this.customerCode === undefined) {
    this.customerCode = await generateCustomerCode();
  }
});

customerSchema.index(
  { companyId: 1, isWalkIn: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      isWalkIn: true,
    },
  },
);

customerSchema.methods.toSafeObject = function () {
  const customer = this.toObject();

  delete customer.__v;

  return customer;
};

customerSchema.index(
  { companyId: 1, customerCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      customerCode: { $type: "string" },
    },
  },
);

customerSchema.index({
  workspaceId: 1,
  mobile: 1,
  isDeleted: 1,
});

customerSchema.index({
  workspaceId: 1,
  companyId: 1,
  isDeleted: 1,
});

customerSchema.index({
  workspaceId: 1,
  companyId: 1,
  branchId: 1,
  isDeleted: 1,
});

customerSchema.index({
  workspaceId: 1,
  companyId: 1,
  customerType: 1,
  status: 1,
  isDeleted: 1,
});

customerSchema.index({
  createdBy: 1,
  isDeleted: 1,
});

customerSchema.index({
  companyId: 1,
  isDeleted: 1,
  isWalkIn: -1,
  updatedAt: -1,
});

const Customer =
  mongoose.models.Customer || mongoose.model("Customer", customerSchema);

export default Customer;
