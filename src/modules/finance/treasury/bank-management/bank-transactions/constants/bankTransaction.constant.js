export const BANK_TRANSACTION_TYPE = {
  DEPOSIT: "DEPOSIT",           // Cash deposited into bank
  WITHDRAWAL: "WITHDRAWAL",     // Cash withdrawn from bank
  NEFT: "NEFT",
  RTGS: "RTGS",
  IMPS: "IMPS",
  UPI: "UPI",
  CHEQUE: "CHEQUE",
  BANK_CHARGES: "BANK_CHARGES", // Bank fees, service charges
  INTEREST: "INTEREST",         // Interest credited by bank
  OTHER: "OTHER",
};

export const BANK_TRANSACTION_DIRECTION = {
  CREDIT: "CREDIT",  // Money coming in (bank balance increases)
  DEBIT: "DEBIT",    // Money going out (bank balance decreases)
};

export const BANK_TRANSACTION_STATUS = {
  DRAFT: "DRAFT",
  POSTED: "POSTED",
  CANCELLED: "CANCELLED",
  PENDING_SHIFT_CLOSE: "PENDING_SHIFT_CLOSE",
};

export const BANK_TRANSACTION_PAYMENT_MODE = {
  CASH: "CASH",       // Descriptive tag: Cash deposit/withdrawal at bank counter or ATM
  CHEQUE: "CHEQUE",   // Descriptive tag: Personal cheque
  UPI: "UPI",         // Descriptive tag: Direct UPI transfer
  NEFT: "NEFT",       // Descriptive tag: NEFT transfer
  RTGS: "RTGS",       // Descriptive tag: RTGS transfer
  IMPS: "IMPS",       // Descriptive tag: IMPS transfer
  OTHER: "OTHER",     // Descriptive tag: Other / Direct transfer
};

export const BANK_TRANSACTION_CATEGORY = {
  PERSONAL_USE: "PERSONAL_USE",         // Owner's Drawings
  CAPITAL_INFUSION: "CAPITAL_INFUSION", // Owner's Capital Contribution
  DIRECT_EXPENSE: "DIRECT_EXPENSE",     // Miscellaneous Direct Bank Expense
  DIRECT_INCOME: "DIRECT_INCOME",       // Miscellaneous Direct Bank Income
  UPI_SETTLEMENT: "UPI_SETTLEMENT",     // Consolidated Shift UPI Settlement
  OTHER: "OTHER",                       // Custom Ledger Account
};
