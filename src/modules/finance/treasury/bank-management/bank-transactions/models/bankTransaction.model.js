import mongoose from "mongoose";
import {
  BANK_TRANSACTION_TYPE,
  BANK_TRANSACTION_DIRECTION,
  BANK_TRANSACTION_STATUS,
  BANK_TRANSACTION_PAYMENT_MODE,
  BANK_TRANSACTION_CATEGORY,
} from "../constants/bankTransaction.constant.js";

const bankTransactionSchema = new mongoose.Schema(
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

    transactionNumber: {
      type: String,
      required: [true, "Transaction number is required"],
      trim: true,
    },

    transactionDate: {
      type: Date,
      required: [true, "Transaction date is required"],
      index: true,
    },

    bankAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      required: [true, "Bank Account is required"],
      index: true,
    },

    transactionType: {
      type: String,
      enum: Object.values(BANK_TRANSACTION_TYPE),
      required: [true, "Transaction type is required"],
      index: true,
    },

    // Descriptive payment mode tag (CASH, CHEQUE, UPI, NEFT, RTGS, IMPS, OTHER)
    paymentMode: {
      type: String,
      enum: Object.values(BANK_TRANSACTION_PAYMENT_MODE),
      default: BANK_TRANSACTION_PAYMENT_MODE.OTHER,
      index: true,
    },

    // Transaction reason category (PERSONAL_USE, CAPITAL_INFUSION, DIRECT_EXPENSE, DIRECT_INCOME, OTHER)
    category: {
      type: String,
      enum: Object.values(BANK_TRANSACTION_CATEGORY),
      default: BANK_TRANSACTION_CATEGORY.OTHER,
      index: true,
    },

    direction: {
      type: String,
      enum: Object.values(BANK_TRANSACTION_DIRECTION),
      required: [true, "Transaction direction is required"],
      index: true,
    },

    amount: {
      type: Number,
      required: [true, "Amount is required"],
      min: [0.01, "Amount must be greater than zero"],
    },

    // UTR / Reference / Cheque number from bank
    referenceNumber: {
      type: String,
      trim: true,
      default: null,
    },

    narration: {
      type: String,
      trim: true,
      default: null,
      maxlength: 500,
    },

    // Counter-party account (optional — e.g. the supplier/customer account to offset)
    counterpartyAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
      index: true,
    },

    // Linked journal voucher
    journalVoucherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JournalVoucher",
      default: null,
      index: true,
    },

    // Linked shift (e.g. for POS sales transactions held until shift close)
    shiftId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
      index: true,
    },

    status: {
      type: String,
      enum: Object.values(BANK_TRANSACTION_STATUS),
      default: BANK_TRANSACTION_STATUS.DRAFT,
      index: true,
    },

    postedAt: {
      type: Date,
      default: null,
    },

    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
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

    cancellationReason: {
      type: String,
      trim: true,
      default: null,
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
      required: [true, "Created by user is required"],
    },
  },
  {
    timestamps: true,
  },
);

bankTransactionSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

// Unique index: transactionNumber per company
bankTransactionSchema.index(
  { companyId: 1, transactionNumber: 1 },
  { unique: true },
);

bankTransactionSchema.index({
  workspaceId: 1,
  companyId: 1,
  bankAccountId: 1,
  isDeleted: 1,
  transactionDate: -1,
});

bankTransactionSchema.index({
  workspaceId: 1,
  companyId: 1,
  transactionType: 1,
  direction: 1,
  status: 1,
  isDeleted: 1,
});

bankTransactionSchema.index({
  shiftId: 1,
  status: 1,
});

const BankTransaction =
  mongoose.models.BankTransaction ||
  mongoose.model("BankTransaction", bankTransactionSchema);

export default BankTransaction;
