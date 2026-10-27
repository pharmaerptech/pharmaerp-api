import mongoose from "mongoose";

const salesReturnSchema = new mongoose.Schema(
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
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    financialPeriodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FinancialPeriod",
      default: null,
    },
    shiftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
      index: true,
    },
    returnNo: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    // Mirror invoiceNo for backward compatibility and uniform printing templates
    invoiceNo: {
      type: String,
      trim: true,
    },
    isReturn: {
      type: Boolean,
      default: true,
      index: true,
    },
    date: {
      type: Date,
      default: Date.now,
      index: true,
    },
    billingMode: {
      type: String,
      enum: ["B2C", "B2B"],
      default: "B2C",
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
    roundOff: {
      type: Number,
      default: 0,
    },
    grandTotal: {
      type: Number,
      default: 0,
    },
    returnAmount: {
      type: Number,
      default: 0,
    },
    returnType: {
      type: String,
      enum: [
        "cash_refund",
        "advance_credit",
        "credit_note",
        "split_refund",
        "CASH",
        "ADVANCE",
        "CREDIT_NOTE",
        "SPLIT",
        "OTHER",
        null,
      ],
      default: "cash_refund",
    },
    paymentMethod: {
      type: String,
      default: "Cash",
    },
    refundMethod: {
      type: String,
      default: "Cash",
    },
    refundDenominations: {
      type: Array,
      default: [],
    },
    payments: {
      type: Array,
      default: [],
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
      index: true,
    },
    items: {
      type: Array,
      default: [],
    },
    doctor: {
      type: String,
      default: null,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      default: null,
      index: true,
    },
    notes: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ["Completed", "Draft", "Cancelled"],
      default: "Completed",
      index: true,
    },
    advanceTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerAdvanceTransaction",
      default: null,
    },
    creditTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerCreditTransaction",
      default: null,
    },
    gstLedgerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GstLedgerEntry",
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    createdByName: {
      type: String,
      default: null,
    },
    createdByEmail: {
      type: String,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

salesReturnSchema.pre("save", function () {
  if (this.isReturn === undefined) {
    this.isReturn = true;
  }
  if (!this.invoiceNo && this.returnNo) {
    this.invoiceNo = this.returnNo;
  }
  if (!this.returnAmount && this.grandTotal) {
    this.returnAmount = this.grandTotal;
  }
});

salesReturnSchema.index({ workspaceId: 1, returnNo: 1 }, { unique: true });
salesReturnSchema.index({ workspaceId: 1, companyId: 1, branchId: 1, date: -1 });
salesReturnSchema.index({ workspaceId: 1, customerId: 1, date: -1 });

const SalesReturn =
  mongoose.models.SalesReturn || mongoose.model("SalesReturn", salesReturnSchema, "sales_returns");

export default SalesReturn;
