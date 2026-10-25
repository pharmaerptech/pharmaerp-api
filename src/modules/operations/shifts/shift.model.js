import mongoose from "mongoose";

const shiftSchema = new mongoose.Schema(
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
    financialPeriodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FinancialPeriod",
      default: null,
      index: true,
    },

    /** The BusinessDay this shift belongs to.
     *  Required for all NEW shifts. Null only on legacy migrated records. */
    businessDayId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessDay",
      default: null,
      index: true,
    },

    /** Logical business date — derived from the parent BusinessDay.businessDate.
     *  Always set from businessDay.businessDate at shift creation time.
     *  Retained for backward-compatible queries (e.g. date-range reports). */
    date: {
      type: Date,
      required: true,
      index: true,
    },
    shiftNo: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    shiftName: {
      type: String,
      trim: true,
      default: "",
    },
    openPeriod: {
      type: String,
      enum: ["morning", "afternoon", "evening", "night"],
      default: null,
    },
    closePeriod: {
      type: String,
      enum: ["morning", "afternoon", "evening", "night"],
      default: null,
    },
    status: {
      type: String,
      enum: ["open", "closed", "cancelled"],
      default: "open",
      index: true,
    },
    openedAt: {
      type: Date,
      default: Date.now,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    openedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // cashAccountId removed — branch cash is now tracked via BranchCash (one per branch)
    // branchId already identifies the cash context

    openingFloatAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    expectedClosingCashAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    actualClosingCashAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    openingDenominations: [
      {
        denomination: { type: Number },
        count: { type: Number },
        amount: { type: Number },
      }
    ],
    closingDenominations: [
      {
        denomination: { type: Number },
        count: { type: Number },
        amount: { type: Number },
      }
    ],
    expectedDenominations: [
      {
        denomination: { type: Number },
        count: { type: Number },
        amount: { type: Number },
      }
    ],
    adjustedDenominations: [
      {
        denomination: { type: Number },
        expectedCount: { type: Number },
        actualCount: { type: Number },
      }
    ],
    cashDifferenceAmount: {
      type: Number,
      default: 0,
    },
    isAdjusted: {
      type: Boolean,
      default: false,
    },
    note: {
      type: String,
      trim: true,
      default: "",
    },
    branchRunningCashAtClose: {
      type: Number,
      default: null,
    },
    branchFrozenCashAtClose: {
      type: Number,
      default: null,
    },

    // Fund transfer totals — kept for backward compat but no longer updated
    // (fund transfers between cash accounts are deprecated)
    totalFundWithdrawals: {
      type: Number,
      default: 0,
    },
    totalFundDeposits: {
      type: Number,
      default: 0,
    },
    
    // Arrays to store explicit breakdown of manual deposits/withdrawals during the shift
    manualDeposits: [
      {
        amount: { type: Number, required: true },
        narration: { type: String, trim: true },
        date: { type: Date, default: Date.now },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
      }
    ],
    manualWithdrawals: [
      {
        amount: { type: Number, required: true },
        narration: { type: String, trim: true },
        date: { type: Date, default: Date.now },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        source: { type: String, enum: ["running", "frozen", "bankslip"] } // optional source context
      }
    ],

    // ── Shift-close carry-forward ─────────────────────────────────────────
    // Amount the pharmacist chose to keep as running cash for the next shift
    carryForwardAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Amount moved to frozen reserve at shift close (totalCash - carryForwardAmount)
    frozenAtClose: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Total cash-collected from sales during this shift.
    // Populated at shift-close so day-closing can sum per-shift without re-querying invoices.
    cashSalesTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Total UPI collected from sales during this shift (populated at shift close).
    upiSalesTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Total Split payment invoices amount (populated at shift close).
    splitSalesTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Count of Split invoices (populated at shift close).
    splitInvoiceCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Split Cash and UPI portion breakdown
    splitCashAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    splitUpiAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    pureCashAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    pureUpiAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    cashInvoiceCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    paymentQrCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditSalesTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditInvoiceCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    advanceSalesTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    advanceInvoiceCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Per-QR and per-Bank UPI collections breakdown (populated at shift close)
    upiBreakdown: [
      {
        paymentQrId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentQr", default: null },
        upiId: { type: String, default: "" },
        label: { type: String, default: "" },
        provider: { type: String, default: null },
        bankAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BankAccount", default: null },
        bankName: { type: String, default: "" },
        accountName: { type: String, default: "" },
        accountNumber: { type: String, default: "" },
        qrImageUrl: { type: String, default: null },
        transactionCount: { type: Number, default: 0 },
        billCount: { type: Number, default: 0 },
        pureBillCount: { type: Number, default: 0 },
        splitBillCount: { type: Number, default: 0 },
        totalAmount: { type: Number, default: 0 },
      }
    ],

    // ── Customer Advance & Credit Settlement Tracking ──────────────────────
    advanceCashTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    advanceCashTendered: {
      type: Number,
      default: 0,
      min: 0,
    },
    advanceChangeDue: {
      type: Number,
      default: 0,
      min: 0,
    },
    advanceUpiTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    advanceCashCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    advanceUpiCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditCashTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditCashTendered: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditChangeDue: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditUpiTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditCashCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    creditUpiCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Per-QR breakdown for Customer Advance & Credit UPI payments
    advanceCreditUpiBreakdown: [
      {
        paymentQrId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentQr", default: null },
        upiId: { type: String, default: "" },
        label: { type: String, default: "" },
        provider: { type: String, default: null },
        bankAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BankAccount", default: null },
        bankName: { type: String, default: "" },
        accountName: { type: String, default: "" },
        accountNumber: { type: String, default: "" },
        qrImageUrl: { type: String, default: null },
        transactionCount: { type: Number, default: 0 },
        totalAmount: { type: Number, default: 0 },
        sourceType: { type: String, enum: ["ADVANCE", "CREDIT", "MIXED"], default: "MIXED" },
      }
    ],

    // ── Cancelled Bills Tracking ──────────────────────────────────────────
    // Total count of invoices cancelled in this shift
    cancelledInvoiceCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Total gross amount of invoices cancelled in this shift
    cancelledSalesTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Total cash cancelled in this shift
    cancelledCashTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Total UPI cancelled in this shift
    cancelledUpiTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Total Split payment invoices cancelled in this shift
    cancelledSplitTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Detailed list of invoices cancelled in this shift
    cancelledInvoices: [
      {
        invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", default: null },
        invoiceNo: { type: String, default: "" },
        grandTotal: { type: Number, default: 0 },
        paymentMethod: { type: String, default: "Cash" },
        payments: { type: Array, default: [] },
        cancelledAt: { type: Date, default: Date.now },
        cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        customerName: { type: String, default: "" },
      }
    ],
    // Payment method breakdown of cancelled bills
    cancelledBreakdown: {
      cash: {
        count: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
      upi: {
        count: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
      split: {
        count: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
      card: {
        count: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
      wallet: {
        count: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
      other: {
        count: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
    },

    // ── Returned Bills Tracking ──────────────────────────────────────────
    returnInvoiceCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnSalesTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnCashTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnUpiTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnAdvanceTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnCreditTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnSplitTotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    returnInvoices: [
      {
        invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", default: null },
        returnId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesReturn", default: null },
        invoiceNo: { type: String, default: "" },
        returnNo: { type: String, default: "" },
        originalInvoiceNo: { type: String, default: "" },
        originalInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", default: null },
        grandTotal: { type: Number, default: 0 },
        returnType: { type: String, default: "cash_refund" },
        paymentMethod: { type: String, default: "Cash" },
        payments: { type: Array, default: [] },
        returnedAt: { type: Date, default: Date.now },
        returnedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        createdByName: { type: String, default: null },
        customerName: { type: String, default: "" },
        customerPhone: { type: String, default: "" },
        itemsCount: { type: Number, default: 0 },
        items: { type: Array, default: [] },
        notes: { type: String, default: "" },
      }
    ],
    returnBreakdown: {
      cash: {
        count: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
      advance: {
        count: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
      credit: {
        count: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
      upi: {
        count: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
      split: {
        count: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
      other: {
        count: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
    },
  },
  { timestamps: true }
);

// Ensure unique shift per branch per day
shiftSchema.index({ branchId: 1, date: 1, shiftNo: 1 }, { unique: true });
// Unique shift number within a Business Day
shiftSchema.index({ businessDayId: 1, shiftNo: 1 }, { unique: true, sparse: true });

export const Shift = mongoose.model("Shift", shiftSchema);
