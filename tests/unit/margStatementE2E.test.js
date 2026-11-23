import mongoose from "mongoose";
import { jest } from "@jest/globals";
import B2CLegacyImportJob from "../../src/modules/sales/invoices/models/b2cLegacyImportJob.model.js";
import B2CLegacyImportStaging from "../../src/modules/sales/invoices/models/b2cLegacyImportStaging.model.js";
import SalesInvoice from "../../src/modules/sales/invoices/models/invoice.model.js";
import WorkspaceProduct from "../../src/modules/catalog/products/models/workspaceProduct.model.js";
import Customer from "../../src/modules/parties/customers/models/customer.model.js";
import {
  processMargChunk,
  materializeHistoricalInvoices,
} from "../../src/modules/sales/invoices/services/b2cLegacyImport.service.js";
import {
  isMargStatement,
  transformMargStatementRows,
} from "../../src/modules/sales/invoices/helpers/margStatementParser.js";

describe("Task 9: Verification on User's Exact Marg ERP Sales Statement Sample", () => {
  const workspaceId = new mongoose.Types.ObjectId();
  const companyId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const migrationId = "MARG_E2E_20261017_001";

  // Product IDs for matched medicines
  const fortiusId = new mongoose.Types.ObjectId();
  const syndopaId = new mongoose.Types.ObjectId();
  const rbmLsrId = new mongoose.Types.ObjectId();
  const ecosprinId = new mongoose.Types.ObjectId();
  const tryptomerId = new mongoose.Types.ObjectId();
  const labetamacId = new mongoose.Types.ObjectId();

  const mockDbProducts = [
    { _id: fortiusId, name: "FORTIUS 5", normalizedName: "fortius 5", workspaceId },
    { _id: syndopaId, name: "SYNDOPA 110 TAB", normalizedName: "syndopa 110 tab", workspaceId },
    { _id: rbmLsrId, name: "RBM LSR TAB", normalizedName: "rbm lsr tab", workspaceId },
    { _id: ecosprinId, name: "ECOSPRIN AV 75 CAP", normalizedName: "ecosprin av 75 cap", workspaceId },
    { _id: tryptomerId, name: "TRYPTOMER 10", normalizedName: "tryptomer 10", workspaceId },
    { _id: labetamacId, name: "LABETAMAC TAB", normalizedName: "labetamac tab", workspaceId },
  ];

  let simulatedStagingStore = [];
  let simulatedCustomerStore = [];
  let simulatedInvoiceStore = [];

  beforeEach(() => {
    simulatedStagingStore = [];
    simulatedCustomerStore = [];
    simulatedInvoiceStore = [];
    jest.clearAllMocks();
  });

  // User's exact sheet layout slice
  const sampleUserMargSheetAoa = [
    ["PAHUCH AROGYAM PHARMACY PVT. LTD."],
    ["SHOP No. 17, ATAL BIHARI MARKET A.B. ROAD DHAMNOD DHARAMPURI DISTRICT DHAR - 454552 MADHAYA PRADESH"],
    ["Phone : 9425459619 E-Mail : rajupatidar619@gmail.com"],
    ["                 SALES STATEMENT FROM 01-10-2026 TO 16-10-2026"],
    [""],
    [null, "BILL NO.", "   DESCRIPTION", "", "", "CASH", "CREDIT"],
    [null, null, "D I S C R I P T I O N", "QTY.", "EXP BATCH", "", ""],
    ["SUREKHA    DR SUREKHA JAIN"],
    ["09-10-2026"],
    [null, "P3038972", "   7566881117 AJIT SHINGH YADAV", "", "", "", 408],
    [null, null, "LABETAMAC TAB        10*", 3, "1/28 971A", "", ""],
    [],
    ["NO", "OF", "BILLS : 1   TOTAL AMOUNT :", 408, "", 0, 408],
    [],
    ["DR ATUL    DR ATUL TAPADIYA"],
    ["10-10-2026"],
    [null, "P3039184", "   9174450782 JITENDRA JI", "", "", 175, ""],
    [null, null, "ECOSPRIN AV 75 CAP   10X15", 2, "11/27 28028528", "", ""],
    [null, null, "TRYPTOMER 10         1X1010T", 1, "3/28 D2600135", "", ""],
    [],
    ["NO", "OF", "BILLS : 1   TOTAL AMOUNT :", 175, "", 175, 0],
    [],
    // Non-mobile bill (must be skipped)
    ["05-10-2026"],
    [null, "P3037940", "   NOTA NONE", "", "", 150, ""],
    [null, null, "PARACETAMOL 500      10S", 1, "1/28 111", "", ""],
    [],
    // Bill 1 for Ravi Patidar (7773811976)
    ["07-10-2026"],
    [null, "P3038172", "   7773811976 RAVI PATIDAR", "", "", 120, ""],
    [null, null, "FORTIUS 5            10S", 1, "2/28 MDM0031", "", ""],
    [],
    // Bill 2 for Ravi Patidar (7773811976)
    ["08-10-2026"],
    [null, "P3038175", "   7773811976 RAVI PATIDAR", "", "", 250, ""],
    [null, null, "SYNDOPA 110 TAB      10S", 1, "3/30 GKH0725A", "", ""],
    [],
    // Bill 3 for Ravi Patidar (7773811976)
    ["12-10-2026"],
    [null, "P3039241", "   7773811976 RAVI PATIDAR", "", "", 310, ""],
    [null, null, "RBM LSR TAB          10S", 1, "10/27 GENC1911B", "", ""],
  ];

  it("should auto-detect Marg ERP statement format from user's header structure", () => {
    expect(isMargStatement(sampleUserMargSheetAoa)).toBe(true);
  });

  it("should transform Marg ERP rows extracting customer phone, name, and clean medicines while skipping non-mobiles", () => {
    const records = transformMargStatementRows(sampleUserMargSheetAoa);

    // Records should contain:
    // 1. AJIT SHINGH YADAV (7566881117) -> LABETAMAC TAB
    // 2. JITENDRA JI (9174450782) -> ECOSPRIN AV 75 CAP
    // 3. JITENDRA JI (9174450782) -> TRYPTOMER 10
    // 4. RAVI PATIDAR (7773811976) -> FORTIUS 5
    // 5. RAVI PATIDAR (7773811976) -> SYNDOPA 110 TAB
    // 6. RAVI PATIDAR (7773811976) -> RBM LSR TAB
    const validRecords = records.filter((r) => r.isValid);
    const skippedRecords = records.filter((r) => !r.isValid);

    expect(validRecords.length).toBe(6);
    expect(skippedRecords.length).toBe(1);
    expect(skippedRecords[0].skipReason).toBe("INVALID_MOBILE");

    const mobiles = validRecords.map((r) => r.mobileNumber);
    expect(mobiles).toContain("7566881117");
    expect(mobiles).toContain("9174450782");
    expect(mobiles).toContain("7773811976");
    expect(mobiles.some((m) => !m || m.includes("NOTA"))).toBe(false);

    // Check pack suffix stripping
    const raviItems = validRecords.filter((r) => r.mobileNumber === "7773811976");
    expect(raviItems.length).toBe(3);
    expect(raviItems.map((r) => r.cleanMedicineName)).toEqual([
      "FORTIUS 5",
      "SYNDOPA 110 TAB",
      "RBM LSR TAB",
    ]);

    // Check doctor headers are not used as customer names
    expect(validRecords.some((r) => r.customerName.includes("DR SUREKHA"))).toBe(false);
    expect(validRecords.some((r) => r.customerName.includes("DR ATUL"))).toBe(false);
  });

  it("should group Ravi Patidar across multiple chunks into 1 customer and 1 historical invoice", async () => {
    // 1. Mock WorkspaceProduct.find
    jest.spyOn(WorkspaceProduct, "find").mockImplementation((query) => ({
      select: () => ({
        lean: async () => {
          if (query._id && query._id.$in) {
            return mockDbProducts.filter((p) =>
              query._id.$in.some((id) => id.toString() === p._id.toString())
            );
          }
          return mockDbProducts;
        },
      }),
    }));

    // 2. Mock Staging bulkWrite ($addToSet across chunks)
    jest.spyOn(B2CLegacyImportStaging, "bulkWrite").mockImplementation(async (ops) => {
      for (const op of ops) {
        if (op.updateOne) {
          const { filter, update } = op.updateOne;
          let existing = simulatedStagingStore.find(
            (s) =>
              s.migrationId === filter.migrationId &&
              s.mobileNumber === filter.mobileNumber
          );

          if (!existing) {
            existing = {
              _id: new mongoose.Types.ObjectId(),
              migrationId: filter.migrationId,
              workspaceId: filter.workspaceId,
              companyId: update.$setOnInsert.companyId,
              branchId: update.$setOnInsert.branchId,
              customerName: update.$setOnInsert.customerName,
              mobileNumber: filter.mobileNumber,
              productIds: [],
              status: "pending",
            };
            simulatedStagingStore.push(existing);
          }

          if (update.$addToSet?.productIds?.$each) {
            for (const pid of update.$addToSet.productIds.$each) {
              if (!existing.productIds.some((id) => id.toString() === pid.toString())) {
                existing.productIds.push(pid);
              }
            }
          }
        }
      }
      return { ok: 1 };
    });

    jest.spyOn(B2CLegacyImportStaging, "find").mockImplementation(() => ({
      lean: async () => simulatedStagingStore.filter((s) => s.status === "pending"),
    }));

    jest.spyOn(B2CLegacyImportStaging, "updateMany").mockImplementation(async (query, update) => {
      const ids = query._id.$in.map((id) => id.toString());
      simulatedStagingStore.forEach((s) => {
        if (ids.includes(s._id.toString())) {
          s.status = update.$set.status;
        }
      });
      return { modifiedCount: ids.length };
    });

    // 3. Mock Customer find and bulkWrite
    jest.spyOn(Customer, "find").mockImplementation((query) => ({
      select: () => ({
        lean: async () => {
          if (query.mobile?.$in) {
            return simulatedCustomerStore.filter((c) =>
              query.mobile.$in.includes(c.mobile)
            );
          }
          return simulatedCustomerStore;
        },
      }),
    }));

    jest.spyOn(Customer, "bulkWrite").mockImplementation(async (ops) => {
      for (const op of ops) {
        if (op.insertOne) {
          simulatedCustomerStore.push({
            _id: new mongoose.Types.ObjectId(),
            ...op.insertOne.document,
          });
        }
      }
      return { ok: 1 };
    });

    // 4. Mock SalesInvoice bulkWrite
    jest.spyOn(SalesInvoice, "bulkWrite").mockImplementation(async (ops) => {
      for (const op of ops) {
        if (op.insertOne) {
          simulatedInvoiceStore.push({
            _id: new mongoose.Types.ObjectId(),
            ...op.insertOne.document,
          });
        }
      }
      return { ok: 1 };
    });

    const mockJob = {
      migrationId,
      workspaceId,
      companyId,
      branchId,
      processedRows: 0,
      validRows: 0,
      skippedRows: 0,
      matchedProducts: 0,
      unmatchedProducts: 0,
      createdCustomers: 0,
      reusedCustomers: 0,
      createdInvoices: 0,
      skippedRecords: [],
      unmatchedMedicines: [],
      save: jest.fn().mockResolvedValue(true),
    };

    // Transform full statement
    const allRecords = transformMargStatementRows(sampleUserMargSheetAoa);

    // Split records into 2 chunks to test cross-chunk staging
    // Chunk 1 has Ravi Bill 1 (FORTIUS 5)
    // Chunk 2 has Ravi Bill 2 (SYNDOPA) and Bill 3 (RBM LSR)
    const chunk1 = allRecords.slice(0, 4); // Ajit (1), Jitendra (2), Ravi (1)
    const chunk2 = allRecords.slice(4);    // Ravi (2)

    await processMargChunk({
      chunkRecords: chunk1,
      migrationId,
      workspaceId,
      companyId,
      branchId,
      job: mockJob,
    });

    await processMargChunk({
      chunkRecords: chunk2,
      migrationId,
      workspaceId,
      companyId,
      branchId,
      job: mockJob,
    });

    // Check Staging Store
    expect(simulatedStagingStore.length).toBe(3); // Ajit, Jitendra, Ravi

    const raviStaged = simulatedStagingStore.find((s) => s.mobileNumber === "7773811976");
    expect(raviStaged).toBeDefined();
    expect(raviStaged.customerName).toBe("RAVI PATIDAR");
    // All 3 medicines of Ravi should be accumulated in his staging productIds!
    expect(raviStaged.productIds.length).toBe(3);
    expect(raviStaged.productIds.map((id) => id.toString())).toEqual(
      expect.arrayContaining([
        fortiusId.toString(),
        syndopaId.toString(),
        rbmLsrId.toString(),
      ])
    );

    // Phase 2: Materialization
    await materializeHistoricalInvoices({
      migrationId,
      workspaceId,
      companyId,
      branchId,
      job: mockJob,
    });

    // Verification of customers created
    expect(simulatedCustomerStore.length).toBe(3);
    const raviCustomer = simulatedCustomerStore.find((c) => c.mobile === "7773811976");
    expect(raviCustomer).toBeDefined();
    expect(raviCustomer.name).toBe("RAVI PATIDAR");

    // Verification of Historical Sales Invoices:
    // Exactly 3 invoices total (1 per customer), NOT 6!
    expect(simulatedInvoiceStore.length).toBe(3);

    const raviInvoice = simulatedInvoiceStore.find(
      (inv) => inv.customerId.toString() === raviCustomer._id.toString()
    );
    expect(raviInvoice).toBeDefined();
    expect(raviInvoice.isHistoricalImport).toBe(true);
    expect(raviInvoice.importSource).toBe("B2C_LEGACY_HISTORY");

    // Exactly 3 medicine items in Ravi's historical invoice
    expect(raviInvoice.items.length).toBe(3);
    const invoiceProductIds = raviInvoice.items.map((i) => i.productId.toString());
    expect(invoiceProductIds).toContain(fortiusId.toString());
    expect(invoiceProductIds).toContain(syndopaId.toString());
    expect(invoiceProductIds).toContain(rbmLsrId.toString());

    // Strict zero-financial values
    expect(raviInvoice.grandTotal).toBe(0);
    expect(raviInvoice.subtotal).toBe(0);
    expect(raviInvoice.tax).toBe(0);
    expect(raviInvoice.discount).toBe(0);
    expect(raviInvoice.status).toBe("Paid");
    expect(raviInvoice.paymentMethod).toBe("Historical Import");
  });

  it("should verify parsing on the actual 19,784-row user uploaded Marg ERP file", async () => {
    const fs = await import("fs");
    const XLSX = (await import("xlsx")).default || (await import("xlsx"));
    const actualFilePath =
      "/Users/atharvasharma/.gemini/antigravity/brain/b43ff509-5611-444e-a76a-ec6ebf6fef4f/.user_uploaded/media_1792253966565_be882c07.xlsx";

    let fileExists = false;
    try {
      fs.accessSync(actualFilePath, fs.constants.R_OK);
      fileExists = true;
    } catch {
      fileExists = false;
    }

    if (!fileExists) {
      console.log("Uploaded file not found, skipping full-file integration test");
      return;
    }

    const workbook = XLSX.readFile(actualFilePath, { dense: true });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawAoa = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });

    expect(isMargStatement(rawAoa)).toBe(true);

    const parsedRecords = transformMargStatementRows(rawAoa);
    expect(parsedRecords.length).toBeGreaterThan(5000);

    const validRecords = parsedRecords.filter((r) => r.isValid);
    expect(validRecords.length).toBeGreaterThan(5000);

    // Strict validation: every valid record must have a 10-digit Indian mobile starting with 6-9
    for (const record of validRecords) {
      expect(record.mobileNumber).toMatch(/^[6-9]\d{9}$/);
      expect(record.cleanMedicineName.length).toBeGreaterThan(0);
      expect(record.customerName).not.toContain("SUREKHA JAIN");
      expect(record.customerName).not.toContain("TAPADIYA");
      expect(record.customerName).not.toContain("KUMBHAKAR");
    }

    // Customer multi-bill aggregation check for Ravi Patidar (7773811976)
    const raviRecords = validRecords.filter((r) => r.mobileNumber === "7773811976");
    expect(raviRecords.length).toBeGreaterThanOrEqual(5);

    const uniqueRaviMedicines = new Set(raviRecords.map((r) => r.cleanMedicineName));
    expect(uniqueRaviMedicines.size).toBeGreaterThanOrEqual(4);
    expect(uniqueRaviMedicines).toContain("FORTIUS 5");
    expect(uniqueRaviMedicines).toContain("SYNDOPA 110 TAB");
    expect(uniqueRaviMedicines).toContain("RBM LSR TAB");
  });
});
