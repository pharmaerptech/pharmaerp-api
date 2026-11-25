import fs from "fs";
import asyncHandler from "../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../utils/ApiResponse.js";
import ApiError from "../../../../utils/ApiError.js";
import purchaseBillService from "../services/purchaseBill.service.js";
import purchaseBillLegacyImportService from "../services/purchaseBillLegacyImport.service.js";
import {
  extractTextFromPdfBuffer,
  parsePurchaseBillText,
  enrichParsedBillWithCatalog,
  SAMPLE_INVOICE_TEXTS,
} from "../helpers/purchaseBillParser.helper.js";

export const createPurchaseBill = asyncHandler(async (req, res) => {
  const payload = { ...req.body };
  if (!payload.branchId && req.headers["x-branch-id"]) {
    payload.branchId = req.headers["x-branch-id"];
  }

  const bill = await purchaseBillService.createPurchaseBill(
    req.workspaceId,
    req.companyId,
    req.user._id,
    payload
  );

  return res
    .status(201)
    .json(new ApiResponse(201, "Purchase bill created successfully", bill));
});

export const updatePurchaseBill = asyncHandler(async (req, res) => {
  const payload = { ...req.body };
  if (!payload.branchId && req.headers["x-branch-id"]) {
    payload.branchId = req.headers["x-branch-id"];
  }

  const bill = await purchaseBillService.updatePurchaseBill(
    req.params.billId,
    req.workspaceId,
    req.companyId,
    req.user._id,
    payload
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Purchase bill updated successfully", bill));
});

export const getPurchaseBills = asyncHandler(async (req, res) => {
  const rawBranchId =
    req.query.branchId !== undefined
      ? req.query.branchId
      : (req.headers["x-branch-id"] || req.branchId || null);

  const branchId =
    rawBranchId && rawBranchId !== "all" && rawBranchId !== "undefined" && rawBranchId !== "null"
      ? rawBranchId
      : undefined;

  const result = await purchaseBillService.getPurchaseBills(
    req.workspaceId,
    req.companyId,
    { ...req.query, branchId }
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, "Purchase bills fetched successfully", result)
    );
});

export const getPurchaseBillById = asyncHandler(async (req, res) => {
  const bill = await purchaseBillService.getPurchaseBillById(
    req.params.billId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Purchase bill fetched successfully", bill));
});

export const ingestPurchaseBill = asyncHandler(async (req, res) => {
  let branchId = req.headers["x-branch-id"] || req.body.branchId || req.branchId || null;

  console.log(`[Controller] Ingesting Purchase Bill ID: ${req.params.billId}`);

  const bill = await purchaseBillService.ingestPurchaseBill(
    req.params.billId,
    req.workspaceId,
    req.companyId,
    branchId,
    req.user._id
  );

  console.log(`[Controller] Successfully ingested bill: ${bill.purchaseBillNo}`);

  return res
    .status(200)
    .json(new ApiResponse(200, "Stock ingested successfully", bill));
});

export const getPurchaseHistory = asyncHandler(async (req, res) => {
  const history = await purchaseBillService.getPurchaseHistory(
    req.params.productId,
    req.workspaceId,
    req.companyId,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Product purchase history fetched successfully", history));
});

export const payPurchaseBill = asyncHandler(async (req, res) => {
  const bill = await purchaseBillService.payPurchaseBill(
    req.params.billId,
    req.workspaceId,
    req.companyId,
    req.user._id,
    req.body
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Purchase bill payment recorded successfully", bill));
});

export const bulkPayPurchaseBills = asyncHandler(async (req, res) => {
  const result = await purchaseBillService.bulkPayPurchaseBills(
    req.workspaceId,
    req.companyId,
    req.user._id,
    req.body
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Bulk payment recorded successfully", result));
});

export const importLegacyBills = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, "Please upload an Excel file");
  }

  const result = await purchaseBillLegacyImportService.importSupplierBills(
    req.file.path,
    req.workspaceId,
    req.companyId,
    req.branchId || req.headers["x-branch-id"] || null,
    req.user._id
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Legacy bills imported successfully", result));
});

export const getIncomingConsignments = asyncHandler(async (req, res) => {
  const result = await purchaseBillService.getIncomingConsignments(
    req.workspaceId,
    req.companyId,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Incoming consignments fetched successfully", result));
});

export const acceptIncomingConsignment = asyncHandler(async (req, res) => {
  const branchId = req.body.branchId || req.headers["x-branch-id"] || req.branchId || null;

  const result = await purchaseBillService.acceptIncomingConsignment(
    req.params.invoiceId,
    req.workspaceId,
    req.companyId,
    branchId,
    req.user._id,
    req.body
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Incoming consignment accepted as purchase bill successfully", result));
});

export const parsePurchaseBillImport = asyncHandler(async (req, res) => {
  let rawText = "";

  if (req.file) {
    try {
      const buffer = await fs.promises.readFile(req.file.path);
      const isPdf =
        req.file.mimetype === "application/pdf" ||
        (req.file.originalname && req.file.originalname.toLowerCase().endsWith(".pdf"));
      if (isPdf) {
        rawText = await extractTextFromPdfBuffer(buffer);
      } else {
        rawText = buffer.toString("utf8");
      }
    } finally {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }
  } else if (req.body?.sampleKey && SAMPLE_INVOICE_TEXTS[req.body.sampleKey]) {
    rawText = SAMPLE_INVOICE_TEXTS[req.body.sampleKey];
  } else if (req.body?.rawText) {
    rawText = req.body.rawText;
  }

  if (!rawText || !rawText.trim()) {
    throw new ApiError(
      400,
      "Please provide a purchase bill PDF file, sampleKey ('galaxy-pharma' | 'agam-medical' | 'basant-medical'), or rawText"
    );
  }

  const parsed = parsePurchaseBillText(rawText);
  const enriched = await enrichParsedBillWithCatalog(
    req.workspaceId,
    req.companyId,
    parsed
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Purchase bill parsed successfully", enriched));
});

