import { describe, it, expect, jest } from "@jest/globals";
import { validatePaymentSplitIntegrity } from "../../src/modules/sales/invoices/services/invoice.service.js";

describe("Strict Split Payment Exact Match Validation", () => {
  it("should REJECT when total payments exceed grand total (overpayment)", () => {
    const saleData = {
      grandTotal: 7000,
      payments: [
        { paymentType: "Cash", amount: 4000 },
        { paymentType: "CreditNote", amount: 4000 }, // Total = 8000, grandTotal = 7000
      ],
    };

    expect(() => validatePaymentSplitIntegrity(saleData)).toThrow(
      /Total payment amount \(₹8000\.00\) exceeds bill grand total \(₹7000\.00\)/
    );
  });

  it("should REJECT when total payments are less than grand total (underpayment / shortfall)", () => {
    const saleData = {
      grandTotal: 7000,
      payments: [
        { paymentType: "Cash", amount: 4000 }, // Total = 4000, missing 3000
      ],
    };

    expect(() => validatePaymentSplitIntegrity(saleData)).toThrow(
      /Total payment amount \(₹4000\.00\) is less than bill grand total \(₹7000\.00\)/
    );
  });

  it("should ACCEPT when split payments exactly equal grand total across Cash and Credit Note", () => {
    const saleData = {
      grandTotal: 7000,
      payments: [
        { paymentType: "Cash", amount: 4000 },
        { paymentType: "CreditNote", amount: 3000 }, // Total = 7000
      ],
    };

    expect(() => validatePaymentSplitIntegrity(saleData)).not.toThrow();
  });

  it("should ACCEPT when split payments exactly equal grand total with Credit (Udhar / Pay Later)", () => {
    const saleData = {
      grandTotal: 7000,
      payments: [
        { paymentType: "Cash", amount: 4000 },
        { paymentType: "Credit", amount: 3000 }, // Total = 7000
      ],
    };

    expect(() => validatePaymentSplitIntegrity(saleData)).not.toThrow();
  });

  it("should ACCEPT 3-way split (Cash + UPI + CreditNote) equaling grand total", () => {
    const saleData = {
      grandTotal: 7000,
      payments: [
        { paymentType: "Cash", amount: 2000 },
        { paymentType: "UPI", amount: 2000 },
        { paymentType: "CreditNote", amount: 3000 },
      ],
    };

    expect(() => validatePaymentSplitIntegrity(saleData)).not.toThrow();
  });

  it("should REJECT negative payment amounts", () => {
    const saleData = {
      grandTotal: 7000,
      payments: [
        { paymentType: "Cash", amount: 8000 },
        { paymentType: "CreditNote", amount: -1000 },
      ],
    };

    expect(() => validatePaymentSplitIntegrity(saleData)).toThrow(
      /cannot be negative/
    );
  });

  it("should REJECT invalid/non-numeric payment amounts", () => {
    const saleData = {
      grandTotal: 7000,
      payments: [
        { paymentType: "Cash", amount: "abc" },
      ],
    };

    expect(() => validatePaymentSplitIntegrity(saleData)).toThrow(
      /Must be a valid number/
    );
  });

  it("should allow microscopic floating point rounding differences within 0.01", () => {
    const saleData = {
      grandTotal: 100,
      payments: [
        { paymentType: "Cash", amount: 33.33 },
        { paymentType: "UPI", amount: 33.33 },
        { paymentType: "CreditNote", amount: 33.34 },
      ],
    };

    expect(() => validatePaymentSplitIntegrity(saleData)).not.toThrow();
  });
});

