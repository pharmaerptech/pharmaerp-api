import mongoose from "mongoose";

const invoiceSchema = new mongoose.Schema(
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
    invoiceNo: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    billingMode: {
      type: String,
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
    grandTotal: {
      type: Number,
      default: 0,
    },
    cashTendered: {
      type: Number,
      default: 0,
    },
    changeDue: {
      type: Number,
      default: 0,
    },
    paymentMethod: {
      type: String,
      default: "Cash",
    },
    // For single-method UPI invoices: which PaymentQr (UPI VPA) received the payment
    // For split payments, each UPI entry inside payments[] carries its own paymentQrId
    paymentQrId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentQr",
      default: null,
      index: true,
    },
    payments: {
      type: Array,
      default: [],
    },
    denominations: {
      type: Array,
      default: [],
    },
    returnedDenominations: {
      type: Array,
      default: [],
    },
    refundDenominations: {
      type: Array,
      default: [],
    },
    customerChangeDenominations: {
      type: Array,
      default: [],
    },
    status: {
      type: String,
      default: "Paid",
    },
    creditDueDate: {
      type: Date,
      default: null,
    },
    creditStatus: {
      type: String,
      enum: ["NA", "PENDING", "PARTIAL", "SETTLED"],
      default: "NA",
      index: true,
    },
    creditPaidAmount: {
      type: Number,
      default: 0,
    },
    creditTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerCreditTransaction",
      default: null,
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
    },
    isReturn: {
      type: Boolean,
      default: false,
      index: true,
    },
    returnType: {
      type: String,
      enum: ["CASH", "ADVANCE", "CREDIT_NOTE", "SPLIT", "OTHER", "advance_credit", "credit_note", "cash_refund", null],
      default: null,
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
    returnInvoiceIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SalesReturn",
      },
    ],
    returnInvoices: {
      type: Array,
      default: [],
    },
    returnStatus: {
      type: String,
      enum: ["NONE", "PARTIAL", "FULL"],
      default: "NONE",
      index: true,
    },
    totalReturnedAmount: {
      type: Number,
      default: 0,
    },
    isFullyReturned: {
      type: Boolean,
      default: false,
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
    isDeleted: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
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
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    updatedByName: {
      type: String,
      default: null,
    },
    updatedByEmail: {
      type: String,
      default: null,
    },
    isHistoricalImport: {
      type: Boolean,
      default: false,
      index: true,
    },
    importSource: {
      type: String,
      default: null,
      index: true,
    },
    migrationId: {
      type: String,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

invoiceSchema.index({ companyId: 1, workspaceId: 1, date: -1 });
invoiceSchema.index({ workspaceId: 1, migrationId: 1, customerId: 1 });
// Per-UPI analytics: single-method UPI invoices
invoiceSchema.index({ companyId: 1, paymentQrId: 1, date: -1 });
// Per-UPI analytics: split-payment UPI sub-items
invoiceSchema.index({ companyId: 1, "payments.paymentQrId": 1, date: -1 });

const SalesInvoice = mongoose.model("SalesInvoice", invoiceSchema);

export default SalesInvoice;
