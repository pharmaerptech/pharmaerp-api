import mongoose from "mongoose";
import { CREDIT_NOTE_STATUS, CREDIT_NOTE_SOURCE } from "../constants/creditNote.constant.js";

const redemptionSchema = new mongoose.Schema(
  {
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesInvoice",
      required: true,
      index: true,
    },
    invoiceNo: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    redeemedAt: {
      type: Date,
      default: Date.now,
    },
    shiftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    notes: {
      type: String,
      default: null,
      trim: true,
    },
  },
  { _id: true, timestamps: true }
);

const creditNoteSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: [true, "Workspace ID is required"],
      index: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: [true, "Company ID is required"],
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
    },
    financialPeriodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FinancialPeriod",
      default: null,
      index: true,
    },
    shiftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
      index: true,
    },
    businessDayId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessDay",
      default: null,
      index: true,
    },
    creditNoteNo: {
      type: String,
      required: [true, "Credit Note number is required"],
      trim: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: [true, "Customer ID is required"],
      index: true,
    },
    customerName: {
      type: String,
      default: null,
      trim: true,
    },
    customerPhone: {
      type: String,
      default: null,
      trim: true,
    },
    customerGst: {
      type: String,
      default: null,
      trim: true,
    },
    billingMode: {
      type: String,
      enum: ["B2C", "B2B"],
      default: "B2C",
      index: true,
    },
    source: {
      type: String,
      enum: Object.values(CREDIT_NOTE_SOURCE),
      default: CREDIT_NOTE_SOURCE.SALES_RETURN,
      index: true,
    },
    sourceReturnId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesReturn",
      default: null,
      index: true,
    },
    sourceReturnNo: {
      type: String,
      default: null,
      trim: true,
    },
    originalInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesInvoice",
      default: null,
      index: true,
    },
    originalInvoiceNo: {
      type: String,
      default: null,
      trim: true,
    },
    subtotal: {
      type: Number,
      default: 0,
    },
    discount: {
      type: Number,
      default: 0,
    },
    tax: {
      type: Number,
      default: 0,
    },
    cgst: {
      type: Number,
      default: 0,
    },
    sgst: {
      type: Number,
      default: 0,
    },
    igst: {
      type: Number,
      default: 0,
    },
    roundOff: {
      type: Number,
      default: 0,
    },
    totalAmount: {
      type: Number,
      required: [true, "Total amount is required"],
      min: [0, "Total amount cannot be negative"],
    },
    redeemedAmount: {
      type: Number,
      default: 0,
      min: [0, "Redeemed amount cannot be negative"],
    },
    balanceAmount: {
      type: Number,
      default: function () {
        return this.totalAmount != null ? this.totalAmount : 0;
      },
      min: [0, "Balance amount cannot be negative"],
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(CREDIT_NOTE_STATUS),
      default: CREDIT_NOTE_STATUS.ACTIVE,
      index: true,
    },
    issueDate: {
      type: Date,
      default: Date.now,
      index: true,
    },
    expiryDate: {
      type: Date,
      default: null,
      index: true,
    },
    items: {
      type: Array,
      default: [],
    },
    redemptions: {
      type: [redemptionSchema],
      default: [],
    },
    journalVoucherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JournalVoucher",
      default: null,
    },
    notes: {
      type: String,
      default: null,
      trim: true,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    cancelReason: {
      type: String,
      default: null,
      trim: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    createdByName: {
      type: String,
      default: null,
      trim: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

creditNoteSchema.pre("save", function () {
  if (this.balanceAmount === undefined || this.balanceAmount === null) {
    this.balanceAmount = Math.max(0, (this.totalAmount || 0) - (this.redeemedAmount || 0));
  }

  // Auto-update status if active/partially redeemed
  if (this.status !== CREDIT_NOTE_STATUS.CANCELLED && this.status !== CREDIT_NOTE_STATUS.EXPIRED) {
    const bal = Math.round(Number(this.balanceAmount) * 100) / 100;
    const tot = Math.round(Number(this.totalAmount) * 100) / 100;
    if (bal <= 0.001) {
      this.status = CREDIT_NOTE_STATUS.FULLY_REDEEMED;
      this.balanceAmount = 0;
    } else if (bal < tot) {
      this.status = CREDIT_NOTE_STATUS.PARTIALLY_REDEEMED;
    } else {
      this.status = CREDIT_NOTE_STATUS.ACTIVE;
    }
  }
});

creditNoteSchema.index({ workspaceId: 1, creditNoteNo: 1 }, { unique: true });
creditNoteSchema.index({ workspaceId: 1, companyId: 1, branchId: 1, issueDate: -1 });
creditNoteSchema.index({ workspaceId: 1, customerId: 1, status: 1 });
creditNoteSchema.index({ workspaceId: 1, sourceReturnId: 1 });

const CreditNote =
  mongoose.models.CreditNote || mongoose.model("CreditNote", creditNoteSchema, "sales_credit_notes");

export default CreditNote;

