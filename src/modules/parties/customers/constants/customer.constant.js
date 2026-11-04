export const CUSTOMER_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  BLOCKED: "blocked",
};

export const CUSTOMER_TYPE = {
  RETAIL: "retail",
  WHOLESALE: "wholesale",
  HOSPITAL: "hospital",
  CLINIC: "clinic",
  CORPORATE: "corporate",
  WALK_IN: "walk_in",
  OTHER: "other",
};

export const WALK_IN_CUSTOMER_DEFAULTS = {
  name: "Walk-in Customer",
  customerCode: "WALK-IN",
  customerType: "walk_in",
  isWalkIn: true,
  isSystemCustomer: true,
  creditLimit: 0,
  creditDays: 0,
  openingBalance: 0,
  advanceBalance: 0,
  creditOutstanding: 0,
  creditNoteBalance: 0,
};

export const CUSTOMER_OPENING_BALANCE_TYPE = {
  DR: "dr",
  CR: "cr",
};

export const CUSTOMER_CODE_PREFIX = "CUS";

export const CUSTOMER_TRANSACTION_TYPE = {
  ADVANCE_RECEIVED: "ADVANCE_RECEIVED",
  ADVANCE_SETTLED: "ADVANCE_SETTLED",
  CREDIT_SETTLED: "CREDIT_SETTLED",
};

export const CREDIT_STATUS = {
  NA: "NA",
  PENDING: "PENDING",
  PARTIAL: "PARTIAL",
  SETTLED: "SETTLED",
  CANCELLED: "CANCELLED",
};
