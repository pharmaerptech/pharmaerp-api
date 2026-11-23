import {
  PURCHASE_RETURN_STATUS,
  RETURN_MOTIVE,
  SETTLEMENT_TYPE,
  SETTLEMENT_STATUS,
  SEQUENCE_PREFIX,
} from "../../src/modules/catalog/purchase-returns/constants/purchaseReturn.constant.js";
import {
  createPurchaseReturnSchema,
  getPurchaseReturnsQuerySchema,
  getEligibleBatchesQuerySchema,
  dispatchReturnBoxSchema,
} from "../../src/modules/catalog/purchase-returns/validations/purchaseReturn.validation.js";
import purchaseReturnService from "../../src/modules/catalog/purchase-returns/services/purchaseReturn.service.js";

describe("Purchase Return Constants & Enums", () => {
  it("should have correct status definitions", () => {
    expect(PURCHASE_RETURN_STATUS.DRAFT).toBe("DRAFT");
    expect(PURCHASE_RETURN_STATUS.CONFIRMED).toBe("CONFIRMED");
    expect(PURCHASE_RETURN_STATUS.CANCELLED).toBe("CANCELLED");
  });

  it("should have valid return motives including scrap bin types", () => {
    expect(RETURN_MOTIVE.SELLABLE).toBe("SELLABLE");
    expect(RETURN_MOTIVE.EXPIRED).toBe("EXPIRED");
    expect(RETURN_MOTIVE.BROKEN).toBe("BROKEN");
    expect(RETURN_MOTIVE.MIXED).toBe("MIXED");
  });

  it("should have settlement types for debit note and claim memo", () => {
    expect(SETTLEMENT_TYPE.DEBIT_NOTE).toBe("DEBIT_NOTE");
    expect(SETTLEMENT_TYPE.CLAIM_MEMO).toBe("CLAIM_MEMO");
  });

  it("should have sequence prefixes", () => {
    expect(SEQUENCE_PREFIX.PURCHASE_RETURN).toBe("PR");
    expect(SEQUENCE_PREFIX.DEBIT_NOTE).toBe("DN");
  });
});

describe("Purchase Return Joi Validations", () => {
  const validSupplierId = "507f1f77bcf86cd799439011";
  const validProductId = "507f1f77bcf86cd799439012";
  const validBatchId = "507f1f77bcf86cd799439013";

  it("should validate a valid purchase return payload", () => {
    const payload = {
      supplierId: validSupplierId,
      returnMotive: "SELLABLE",
      settlementType: "DEBIT_NOTE",
      items: [
        {
          productId: validProductId,
          productName: "Paracetamol 500mg",
          pack: "10x10",
          batchId: validBatchId,
          batchNo: "BATCH-001",
          expiry: "12/28",
          sourceBin: "SELLABLE",
          returnQty: 10,
          rate: 45.5,
          gstPct: 12,
        },
      ],
      remarks: "Excess stock return",
    };

    const { error, value } = createPurchaseReturnSchema.validate(payload);
    expect(error).toBeUndefined();
    expect(value.items).toHaveLength(1);
    expect(value.returnMotive).toBe("SELLABLE");
  });

  it("should validate a scrap return payload from expired scrap bin", () => {
    const payload = {
      supplierId: validSupplierId,
      returnMotive: "EXPIRED",
      settlementType: "DEBIT_NOTE",
      items: [
        {
          productId: validProductId,
          productName: "Amoxicillin 250mg",
          pack: "10x10",
          batchId: validBatchId,
          batchNo: "BATCH-EXP-01",
          expiry: "01/25",
          sourceBin: "SCRAP_EXPIRED",
          returnQty: 5,
          rate: 120,
          gstPct: 12,
        },
      ],
      remarks: "Monthly expiry dump return",
    };

    const { error, value } = createPurchaseReturnSchema.validate(payload);
    expect(error).toBeUndefined();
    expect(value.items[0].sourceBin).toBe("SCRAP_EXPIRED");
  });

  it("should reject when supplierId is missing", () => {
    const payload = {
      items: [
        {
          productId: validProductId,
          batchId: validBatchId,
          batchNo: "BATCH-001",
          returnQty: 10,
          rate: 50,
        },
      ],
    };

    const { error } = createPurchaseReturnSchema.validate(payload);
    expect(error).toBeDefined();
    expect(error.details[0].message).toContain('"supplierId" is required');
  });

  it("should reject when items array is empty", () => {
    const payload = {
      supplierId: validSupplierId,
      items: [],
    };

    const { error } = createPurchaseReturnSchema.validate(payload);
    expect(error).toBeDefined();
    expect(error.details[0].message).toContain('"items" must contain at least 1 items');
  });

  it("should reject invalid return quantity (< 1)", () => {
    const payload = {
      supplierId: validSupplierId,
      items: [
        {
          productId: validProductId,
          batchId: validBatchId,
          batchNo: "BATCH-001",
          returnQty: 0,
          rate: 50,
        },
      ],
    };

    const { error } = createPurchaseReturnSchema.validate(payload);
    expect(error).toBeDefined();
    expect(error.details[0].message).toContain('"items[0].returnQty" must be greater than or equal to 1');
  });
});

describe("Purchase Return Query Validations", () => {
  it("should accept valid query parameters for listing", () => {
    const query = {
      page: 1,
      limit: 25,
      returnMotive: "EXPIRED",
      status: "CONFIRMED",
      search: "PR-2026",
    };

    const { error, value } = getPurchaseReturnsQuerySchema.validate(query);
    expect(error).toBeUndefined();
    expect(value.limit).toBe(25);
  });

  it("should validate eligible batches query", () => {
    const query = {
      sourceBin: "SCRAP",
      search: "AZITHRO",
      limit: 50,
    };

    const { error, value } = getEligibleBatchesQuerySchema.validate(query);
    expect(error).toBeUndefined();
    expect(value.sourceBin).toBe("SCRAP");
  });

  it("should accept valid query parameters for incoming box returns", () => {
    const query = {
      direction: "incoming",
      page: 1,
      limit: 20,
    };

    const { error, value } = getPurchaseReturnsQuerySchema.validate(query);
    expect(error).toBeUndefined();
    expect(value.direction).toBe("incoming");
  });

  it("should validate dispatch return box payload", () => {
    const payload = {
      destinationCompanyId: "507f1f77bcf86cd799439011",
      destinationBranchId: "507f1f77bcf86cd799439012",
      boxCount: 2,
      packageNotes: "Fragile ampoules",
    };

    const { error, value } = dispatchReturnBoxSchema.validate(payload);
    expect(error).toBeUndefined();
    expect(value.boxCount).toBe(2);
  });

  it("should have dispatchReturnBox and receiveReturnBox methods defined on service", () => {
    expect(typeof purchaseReturnService.dispatchReturnBox).toBe("function");
    expect(typeof purchaseReturnService.receiveReturnBox).toBe("function");
  });

  it("should fail gracefully if destinationBranchId is missing in dispatchReturnBox", async () => {
    await expect(
      purchaseReturnService.dispatchReturnBox(
        "507f1f77bcf86cd799439011",
        "507f1f77bcf86cd799439012",
        "507f1f77bcf86cd799439013",
        "507f1f77bcf86cd799439014",
        {}
      )
    ).rejects.toThrow("Destination branch is required");
  });
});

describe("Rate & Tax Calculation Verification", () => {
  it("should compute effective purchase rate with scheme clawback", () => {
    // Purchased 100 units + 10 free units with gross taxable subtotal ₹8000
    const billedQty = 100;
    const freeQty = 10;
    const taxableSubtotal = 8000;
    const totalInflow = billedQty + freeQty;
    const effectiveRate = Number((taxableSubtotal / totalInflow).toFixed(2));

    expect(effectiveRate).toBe(72.73);

    // Returning 20 units
    const returnQty = 20;
    const lineTaxable = Number((returnQty * effectiveRate).toFixed(2));
    const gstRate = 12;
    const gstAmount = Number(((lineTaxable * gstRate) / 100).toFixed(2));
    const totalAmount = Number((lineTaxable + gstAmount).toFixed(2));

    expect(lineTaxable).toBe(1454.60);
    expect(gstAmount).toBe(174.55);
    expect(totalAmount).toBe(1629.15);
  });
});

