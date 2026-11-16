import asyncHandler from "../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../utils/ApiResponse.js";
import supplierService from "../services/supplier.service.js";

export const createSupplier = asyncHandler(async (req, res) => {
  const supplier = await supplierService.createSupplier(
    req.workspaceId,
    req.companyId,
    req.user._id,
    req.body
  );

  return res
    .status(201)
    .json(new ApiResponse(201, "Supplier created successfully", supplier));
});

export const getSuppliers = asyncHandler(async (req, res) => {
  const rawCompanyId =
    req.query.companyId !== undefined
      ? req.query.companyId
      : (req.headers["x-company-id"] || req.companyId || null);

  const companyId =
    rawCompanyId && rawCompanyId !== "all" && rawCompanyId !== "undefined" && rawCompanyId !== "null"
      ? rawCompanyId
      : null;

  const result = await supplierService.getSuppliers(
    req.workspaceId,
    companyId,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Suppliers fetched successfully", result));
});

export const getSupplierById = asyncHandler(async (req, res) => {
  const supplier = await supplierService.getSupplierById(
    req.params.supplierId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Supplier fetched successfully", supplier));
});

export const updateSupplier = asyncHandler(async (req, res) => {
  const supplier = await supplierService.updateSupplier(
    req.params.supplierId,
    req.companyId,
    req.workspaceId,
    req.user._id,
    req.body
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Supplier updated successfully", supplier));
});

export const deleteSupplier = asyncHandler(async (req, res) => {
  await supplierService.deleteSupplier(
    req.params.supplierId,
    req.companyId,
    req.workspaceId,
    req.user._id
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Supplier deleted successfully"));
});

export const getSupplierLedger = asyncHandler(async (req, res) => {
  const ledger = await supplierService.getSupplierLedger(
    req.params.supplierId,
    req.companyId,
    req.workspaceId,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Supplier ledger fetched successfully", ledger));
});

export const getSupplierOutstanding = asyncHandler(async (req, res) => {
  const outstanding = await supplierService.getSupplierOutstanding(
    req.params.supplierId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Supplier outstanding fetched successfully", outstanding));
});

export const getSupplierPurchases = asyncHandler(async (req, res) => {
  const purchases = await supplierService.getSupplierPurchases(
    req.params.supplierId,
    req.companyId,
    req.workspaceId,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Supplier purchases fetched successfully", purchases));
});

export const getSupplierPayments = asyncHandler(async (req, res) => {
  const payments = await supplierService.getSupplierPayments(
    req.params.supplierId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Supplier payments fetched successfully", payments));
});

export const previewImport = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json(new ApiResponse(400, "Excel file is required"));
  }
  
  const importType = req.body.importType || "standard";
  let result;
  
  if (importType === "outstanding") {
    result = await supplierService.previewOutstandingImport(
      req.workspaceId,
      req.companyId,
      req.file.buffer
    );
  } else {
    result = await supplierService.previewImport(
      req.workspaceId,
      req.companyId,
      req.file.buffer
    );
  }
  return res.status(200).json(new ApiResponse(200, "Preview generated successfully", result));
});

export const confirmImport = asyncHandler(async (req, res) => {
  const importType = req.body.importType || "standard";
  let result;
  
  if (importType === "outstanding") {
    result = await supplierService.confirmOutstandingImport(
      req.workspaceId,
      req.companyId,
      req.user._id,
      req.body.suppliers
    );
  } else {
    result = await supplierService.confirmImport(
      req.workspaceId,
      req.companyId,
      req.user._id,
      req.body.suppliers
    );
  }
  return res.status(200).json(new ApiResponse(200, "Suppliers imported successfully", result));
});
