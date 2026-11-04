import {
  CREDIT_NOTE_STATUS,
  CREDIT_NOTE_SOURCE,
  DEFAULT_CREDIT_NOTE_VALIDITY_DAYS,
} from "../../src/modules/sales/credit-notes/constants/creditNote.constant.js";
import { VOUCHER_TYPE } from "../../src/modules/finance/journal-vouchers/constants/voucherType.constant.js";
import { VOUCHER_PREFIX } from "../../src/modules/finance/journal-vouchers/constants/voucherNumber.constant.js";
import {
  queryCreditNotesSchema,
  createManualCreditNoteSchema,
  cancelCreditNoteSchema,
} from "../../src/modules/sales/credit-notes/validations/creditNote.validation.js";

describe("Credit Note Constants & Validations", () => {
  describe("Constants", () => {
    it("should define CREDIT_NOTE in VOUCHER_TYPE and VOUCHER_PREFIX", () => {
      expect(VOUCHER_TYPE.CREDIT_NOTE).toBe("CREDIT_NOTE");
      expect(VOUCHER_PREFIX[VOUCHER_TYPE.CREDIT_NOTE]).toBe("CNJ");
    });

    it("should define standard status enum values", () => {
      expect(CREDIT_NOTE_STATUS.ACTIVE).toBe("ACTIVE");
      expect(CREDIT_NOTE_STATUS.PARTIALLY_REDEEMED).toBe("PARTIALLY_REDEEMED");
      expect(CREDIT_NOTE_STATUS.FULLY_REDEEMED).toBe("FULLY_REDEEMED");
      expect(CREDIT_NOTE_STATUS.CANCELLED).toBe("CANCELLED");
      expect(CREDIT_NOTE_STATUS.EXPIRED).toBe("EXPIRED");
    });

    it("should define sources", () => {
      expect(CREDIT_NOTE_SOURCE.SALES_RETURN).toBe("SALES_RETURN");
      expect(CREDIT_NOTE_SOURCE.MANUAL).toBe("MANUAL");
      expect(CREDIT_NOTE_SOURCE.RATE_DIFFERENCE).toBe("RATE_DIFFERENCE");
    });

    it("should define default validity days", () => {
      expect(DEFAULT_CREDIT_NOTE_VALIDITY_DAYS).toBeGreaterThan(0);
    });
  });

  describe("Query Validation Schema", () => {
    it("should validate default query params", () => {
      const { error, value } = queryCreditNotesSchema.validate({});
      expect(error).toBeUndefined();
      expect(value.page).toBe(1);
      expect(value.limit).toBe(20);
    });

    it("should validate query with status, date, and sorting parameters", () => {
      const { error, value } = queryCreditNotesSchema.validate({
        page: 2,
        limit: 10,
        status: "ACTIVE",
        search: "CN-2026",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-31T23:59:59.999Z",
        sortBy: "totalAmount",
        sortOrder: "desc",
      });
      expect(error).toBeUndefined();
      expect(value.sortBy).toBe("totalAmount");
      expect(value.sortOrder).toBe("desc");
    });

    it("should reject invalid status", () => {
      const { error } = queryCreditNotesSchema.validate({
        status: "INVALID_STATUS",
      });
      expect(error).toBeDefined();
    });
  });

  describe("Manual Credit Note Schema", () => {
    it("should validate valid manual creation", () => {
      const validPayload = {
        customerId: "507f1f77bcf86cd799439011",
        totalAmount: 1500,
        subtotal: 1400,
        tax: 100,
        billingMode: "B2C",
        notes: "Customer courtesy credit",
      };
      const { error } = createManualCreditNoteSchema.validate(validPayload);
      expect(error).toBeUndefined();
    });

    it("should fail when totalAmount is non-positive or missing", () => {
      const { error } = createManualCreditNoteSchema.validate({
        customerId: "507f1f77bcf86cd799439011",
        totalAmount: 0,
      });
      expect(error).toBeDefined();
    });
  });

  describe("Cancel Credit Note Schema", () => {
    it("should require reason", () => {
      const { error } = cancelCreditNoteSchema.validate({ reason: "Duplicate return" });
      expect(error).toBeUndefined();
    });

    it("should reject reason shorter than 3 chars", () => {
      const { error } = cancelCreditNoteSchema.validate({ reason: "No" });
      expect(error).toBeDefined();
    });
  });

  describe("Redeem Credit Notes Edge Cases", () => {
    it("should return empty redemption for zero or negative amount", async () => {
      const { redeemCreditNotesForInvoice } = await import(
        "../../src/modules/sales/credit-notes/services/creditNote.service.js"
      );
      const resZero = await redeemCreditNotesForInvoice("507f1f77bcf86cd799439011", 0, { invoiceNo: "INV-1" });
      expect(resZero).toEqual({ redeemedNotes: [], totalRedeemed: 0 });

      const resNeg = await redeemCreditNotesForInvoice("507f1f77bcf86cd799439011", -50, { invoiceNo: "INV-1" });
      expect(resNeg).toEqual({ redeemedNotes: [], totalRedeemed: 0 });
    });
  });

  describe("Split Payment Matrix with Credit Note", () => {
    it("should correctly validate and decompose cash when split with Credit Note", async () => {
      const branchCashRepo = (await import("../../src/modules/finance/treasury/cash-management/branch-cash/repositories/branchCash.repository.js")).default;
      const saleData = {
        grandTotal: 1000,
        paymentMethod: "Split",
        payments: [
          { paymentType: "CreditNote", amount: 500 },
          { paymentType: "Cash", amount: 500 },
        ],
      };

      // Decompose cash amount auto-decomposition check
      const denoms = branchCashRepo.decomposeCashAmount(500);
      expect(denoms.length).toBeGreaterThan(0);
      const total = denoms.reduce((s, d) => s + d.denomination * d.quantity, 0);
      expect(total).toBe(500);
    });

    it("should safely handle revertInvoiceCreditNotes when invoiceId is empty or parameters are null", async () => {
      const { revertInvoiceCreditNotes } = await import(
        "../../src/modules/sales/credit-notes/services/creditNote.service.js"
      );
      const res = await revertInvoiceCreditNotes(null, null, null);
      expect(res).toEqual({ totalRestored: 0 });
    });
  });
});
