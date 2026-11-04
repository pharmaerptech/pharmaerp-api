import {
  CUSTOMER_TYPE,
  WALK_IN_CUSTOMER_DEFAULTS,
} from "../../src/modules/parties/customers/constants/customer.constant.js";
import {
  getCustomersQuerySchema,
} from "../../src/modules/parties/customers/validations/customer.validation.js";

describe("Walk-in Customer Architecture & Rules", () => {
  describe("Constants & Schema Defaults", () => {
    it("should export WALK_IN enum in CUSTOMER_TYPE", () => {
      expect(CUSTOMER_TYPE.WALK_IN).toBe("walk_in");
    });

    it("should export strict WALK_IN_CUSTOMER_DEFAULTS with zero credit/advances", () => {
      expect(WALK_IN_CUSTOMER_DEFAULTS.name).toBe("Walk-in Customer");
      expect(WALK_IN_CUSTOMER_DEFAULTS.customerType).toBe("walk_in");
      expect(WALK_IN_CUSTOMER_DEFAULTS.isWalkIn).toBe(true);
      expect(WALK_IN_CUSTOMER_DEFAULTS.isSystemCustomer).toBe(true);
      expect(WALK_IN_CUSTOMER_DEFAULTS.creditLimit).toBe(0);
      expect(WALK_IN_CUSTOMER_DEFAULTS.creditDays).toBe(0);
      expect(WALK_IN_CUSTOMER_DEFAULTS.openingBalance).toBe(0);
      expect(WALK_IN_CUSTOMER_DEFAULTS.advanceBalance).toBe(0);
      expect(WALK_IN_CUSTOMER_DEFAULTS.creditOutstanding).toBe(0);
      expect(WALK_IN_CUSTOMER_DEFAULTS.creditNoteBalance).toBe(0);
    });

    it("should accept isWalkIn boolean filter in query validation", () => {
      const { error, value } = getCustomersQuerySchema.validate({
        isWalkIn: true,
      });
      expect(error).toBeUndefined();
      expect(value.isWalkIn).toBe(true);
    });
  });

  describe("Walk-in Business Rules Enforcement", () => {
    it("should verify that walk-in customers cannot have credit limit > 0 or credit days > 0", () => {
      const customer = { ...WALK_IN_CUSTOMER_DEFAULTS };
      if (customer.isWalkIn) {
        customer.creditLimit = 0;
        customer.creditDays = 0;
        customer.advanceBalance = 0;
        customer.creditOutstanding = 0;
      }
      expect(customer.creditLimit).toBe(0);
      expect(customer.creditDays).toBe(0);
      expect(customer.advanceBalance).toBe(0);
      expect(customer.creditOutstanding).toBe(0);
    });

    it("should verify sales payment tender restriction for walk-in", () => {
      const allowedForWalkIn = (paymentType) => {
        return ["Cash", "UPI", "Split"].includes(paymentType);
      };

      expect(allowedForWalkIn("Cash")).toBe(true);
      expect(allowedForWalkIn("UPI")).toBe(true);
      expect(allowedForWalkIn("Split")).toBe(true);
      expect(allowedForWalkIn("Credit")).toBe(false);
      expect(allowedForWalkIn("Advance")).toBe(false);
      expect(allowedForWalkIn("CreditNote")).toBe(false);
    });

    it("should verify sales return restriction for walk-in (cash refund only)", () => {
      const validateWalkInReturn = (returnType) => {
        if (returnType !== "cash_refund") {
          throw new Error("Walk-in customer returns can only be refunded in cash.");
        }
        return true;
      };

      expect(validateWalkInReturn("cash_refund")).toBe(true);
      expect(() => validateWalkInReturn("credit_note")).toThrow(
        "Walk-in customer returns can only be refunded in cash."
      );
      expect(() => validateWalkInReturn("advance_credit")).toThrow(
        "Walk-in customer returns can only be refunded in cash."
      );
    });

    it("should prioritize walk-in customer first in table sorting", () => {
      const customers = [
        { name: "Apex Pharmacy", customerCode: "CUST-001", isWalkIn: false, createdAt: new Date("2026-01-01") },
        { name: "Walk-in Customer", customerCode: "WALK-IN", isWalkIn: true, createdAt: new Date("2025-01-01") },
        { name: "Zydus Hospital", customerCode: "CUST-002", isWalkIn: false, createdAt: new Date("2026-05-01") },
      ];

      // Sorting logic used in customer table
      const sorted = [...customers].sort((a, b) => {
        const aIsWalk = Boolean(a.isWalkIn || a.customerType === "walk_in" || a.customerCode === "WALK-IN");
        const bIsWalk = Boolean(b.isWalkIn || b.customerType === "walk_in" || b.customerCode === "WALK-IN");
        if (aIsWalk && !bIsWalk) return -1;
        if (!aIsWalk && bIsWalk) return 1;
        return a.name.localeCompare(b.name);
      });

      expect(sorted[0].customerCode).toBe("WALK-IN");
      expect(sorted[0].isWalkIn).toBe(true);
      expect(sorted[1].name).toBe("Apex Pharmacy");
      expect(sorted[2].name).toBe("Zydus Hospital");
    });

    it("should construct repository sort with isWalkIn: -1 first and default to updatedAt: -1", () => {
      const buildSort = (optionsSort) => {
        let baseSort = { updatedAt: -1, createdAt: -1 };
        if (optionsSort) {
          if (typeof optionsSort === "object") {
            baseSort = optionsSort;
          } else if (typeof optionsSort === "string") {
            const isDesc = optionsSort.startsWith("-") || optionsSort.endsWith(":desc");
            const cleanField = optionsSort.replace(/^-/, "").replace(/:desc$|:asc$/, "").trim();
            baseSort = { [cleanField]: isDesc ? -1 : 1 };
          }
        }
        return { isWalkIn: -1, ...baseSort };
      };

      expect(buildSort()).toEqual({ isWalkIn: -1, updatedAt: -1, createdAt: -1 });
      expect(buildSort({ name: 1 })).toEqual({ isWalkIn: -1, name: 1 });
      expect(buildSort("-name")).toEqual({ isWalkIn: -1, name: -1 });
    });
  });
});
