import mongoose from "mongoose";

/**
 * BusinessDay — Proactive session model for a pharmacy's operating day.
 *
 * Lifecycle:
 *   OPEN   → Created at the start of the day by a manager.
 *            All Shifts and Bank Deposit Slips created during the day
 *            are linked to this record via businessDayId.
 *
 *   CLOSED → Closed after the last shift ends.
 *            All financial aggregation (cash totals, shift breakdown)
 *            is populated at close time.
 *
 *   CANCELLED → Voided. No financial operations.
 *
 * Date Model (3-date system):
 *   - actualOpenedAt  : Real UTC timestamp when the "Open Business Day" button was clicked.
 *   - businessDate    : Logical date declared by the user (e.g., Oct 4th).
 *                       This is the canonical date used for ALL reports and accounting.
 *                       It does NOT change even if the day runs past midnight.
 *   - actualClosedAt  : Real UTC timestamp when "Close Business Day" was clicked.
 *
 * Key Rules (enforced at API level):
 *   1. Only ONE BusinessDay per branch can have status === 'open' at a time.
 *   2. businessDate can only be today or tomorrow (no backdating, no far future).
 *   3. Cannot close a BusinessDay if any linked Shift is still 'open'.
 *   4. Once 'closed', no new Shifts or Bank Slips can be linked to this day.
 */
const businessDaySchema = new mongoose.Schema(
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

    // ── 3-Date System ─────────────────────────────────────────────────────────

    /** The logical business date declared by the user.
     *  Used for all accounting, reporting, and financial grouping.
     *  Stored as a canonical midnight UTC date for consistent comparison. */
    businessDate: {
      type: Date,
      required: true,
      index: true,
    },

    /** Real UTC timestamp when the Business Day was opened (button clicked). */
    actualOpenedAt: {
      type: Date,
      default: Date.now,
    },

    /** Real UTC timestamp when the Business Day was closed (button clicked).
     *  Null while still open. */
    actualClosedAt: {
      type: Date,
      default: null,
    },

    // ── Identification ────────────────────────────────────────────────────────

    /** Auto-generated identifier: BD-{timestamp}-{rand} */
    businessDayNo: {
      type: String,
      trim: true,
      index: true,
    },

    // ── Status ────────────────────────────────────────────────────────────────

    status: {
      type: String,
      enum: ["open", "closed", "cancelled"],
      default: "open",
      index: true,
    },

    // ── Audit ─────────────────────────────────────────────────────────────────

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ── Shifts ────────────────────────────────────────────────────────────────

    /** Array of Shift IDs that belong to this Business Day.
     *  Populated incrementally as each shift is opened. */
    shifts: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Shift",
      },
    ],

    // ── Financial Aggregation (populated at CLOSE time) ───────────────────────
    // These fields are empty while the day is OPEN.
    // They are calculated and written when closeBusinessDay() is called.

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
      },
    ],
    closingDenominations: [
      {
        denomination: { type: Number },
        count: { type: Number },
        amount: { type: Number },
      },
    ],
    totalFundWithdrawals: {
      type: Number,
      default: 0,
    },
    totalFundDeposits: {
      type: Number,
      default: 0,
    },
    /** Aggregated manual deposit totals across all shifts for this day. */
    totalManualDeposits: { type: Number, default: 0 },
    /** Aggregated manual withdrawal totals across all shifts for this day. */
    totalManualWithdrawals: { type: Number, default: 0 },
    /** Per-shift cash breakdown — populated when Business Day is closed. */
    cashByShift: [
      {
        shiftId:      { type: mongoose.Schema.Types.ObjectId, ref: "Shift" },
        shiftName:    { type: String, default: "" },
        shiftNo:      { type: String, default: "" },
        openingFloat: { type: Number, default: 0 },
        cashSales:    { type: Number, default: 0 },
        deposits:     { type: Number, default: 0 },
        withdrawals:  { type: Number, default: 0 },
        expectedCash: { type: Number, default: 0 },
        actualCash:   { type: Number, default: 0 },
      },
    ],
    cashDifferenceAmount: {
      type: Number,
      default: 0,
    },

    // ── Consolidated UPI Settlement (populated at Business Day Close) ──────────
    upiSettlementStatus: {
      type: String,
      enum: ["PENDING", "SETTLED", "NOT_APPLICABLE"],
      default: "PENDING",
      index: true,
    },
    upiSettledAt: {
      type: Date,
      default: null,
    },
    upiSettledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    totalUpiAmount: {
      type: Number,
      default: 0,
    },
    totalUpiTransactions: {
      type: Number,
      default: 0,
    },
    upiBankBreakdown: [
      {
        bankAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BankAccount" },
        bankName: { type: String, default: "" },
        accountNumber: { type: String, default: "" },
        totalAmount: { type: Number, default: 0 },
        transactionCount: { type: Number, default: 0 },
        billCount: { type: Number, default: 0 },
        bankTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "BankTransaction", default: null },
      },
    ],
    upiSettlementTransactions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "BankTransaction",
      },
    ],

    // ── Notes ─────────────────────────────────────────────────────────────────
    note: {
      type: String,
      trim: true,
      default: "",
    },

    // ── Migration Reference (kept for traceability only) ─────────────────────
    /** References the old DayClosing._id this record was migrated from. Null for new records. */
    _legacyDayClosingId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

/**
 * Prevent two OPEN Business Days for the same branch simultaneously.
 * This is a partial unique index — it only applies to records where status === 'open'.
 */
businessDaySchema.index(
  { branchId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "open" },
    name: "unique_open_business_day_per_branch",
  }
);

/** Fast lookup: all Business Days for a branch sorted by businessDate. */
businessDaySchema.index({ branchId: 1, businessDate: -1 });

/** Company-level reporting index. */
businessDaySchema.index({ companyId: 1, businessDate: -1 });

export const BusinessDay = mongoose.model("BusinessDay", businessDaySchema);
export default BusinessDay;
