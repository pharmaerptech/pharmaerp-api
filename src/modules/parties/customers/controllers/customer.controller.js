import creditNoteService from "../../../sales/credit-notes/services/creditNote.service.js";
import asyncHandler from "../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../utils/ApiResponse.js";
import xlsx from "xlsx";
import customerService from "../services/customer.service.js";
import b2cCustomerImportService from "../services/b2cCustomerImport.service.js";
import customerAdvanceService from "../services/customerAdvance.service.js";
import invoiceService from "../../../sales/invoices/services/invoice.service.js";

export const getWalkInCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.getWalkInCustomer(
    req.workspaceId,
    req.companyId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Walk-in customer fetched successfully", customer));
});

export const ensureWalkInCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.findOrCreateWalkInCustomer(
    req.workspaceId,
    req.companyId,
    req.user?._id
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Walk-in customer ensured successfully", customer));
});

export const createCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.createCustomer(
    req.workspaceId,
    req.companyId,
    req.user._id,
    req.body
  );

  return res
    .status(201)
    .json(new ApiResponse(201, "Customer created successfully", customer));
});

export const getCustomers = asyncHandler(async (req, res) => {
  const result = await customerService.getCustomers(
    req.workspaceId,
    req.companyId,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customers fetched successfully", result));
});

export const getCustomerById = asyncHandler(async (req, res) => {
  const customer = await customerService.getCustomerById(
    req.params.customerId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer fetched successfully", customer));
});

export const updateCustomer = asyncHandler(async (req, res) => {
  const customer = await customerService.updateCustomer(
    req.params.customerId,
    req.companyId,
    req.workspaceId,
    req.user._id,
    req.body
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer updated successfully", customer));
});

export const deleteCustomer = asyncHandler(async (req, res) => {
  await customerService.deleteCustomer(
    req.params.customerId,
    req.companyId,
    req.workspaceId,
    req.user._id
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer deleted successfully"));
});

export const getCustomerLedger = asyncHandler(async (req, res) => {
  const ledger = await customerService.getCustomerLedger(
    req.params.customerId,
    req.companyId,
    req.workspaceId,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer ledger fetched successfully", ledger));
});

export const getCustomerOutstanding = asyncHandler(async (req, res) => {
  const outstanding = await customerService.getCustomerOutstanding(
    req.params.customerId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer outstanding fetched successfully", outstanding));
});



export const getCustomerPayments = asyncHandler(async (req, res) => {
  const payments = await customerService.getCustomerPayments(
    req.params.customerId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer payments fetched successfully", payments));
});

export const getCustomerSales = asyncHandler(async (req, res) => {
  const salesResult = await invoiceService.getCustomerSales(
    req.params.customerId,
    req.companyId,
    req.workspaceId,
    null,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer sales fetched successfully", salesResult));
});

export const previewImport = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json(new ApiResponse(400, "Excel file is required"));
  }
  
  const importType = req.body.importType || "b2b";
  let result;
  
  if (importType === "b2b-outstanding") {
    // We will inject the new parser service later
    result = await customerService.previewB2BOutstandingImport(
      req.workspaceId,
      req.companyId,
      req.file.buffer
    );
  } else if (importType === "b2c") {
    // Parse using the robust xlsx parser for .xlsx files
    const parsedData = await customerService.previewImport(
      req.workspaceId,
      req.companyId,
      req.file.buffer,
      importType
    );

    const validCustomersData = parsedData
      .filter((r) => r.isValid)
      .map((r) => ({ ...r.data, customerType: "other" }));

    if (validCustomersData.length > 0) {
      try {
        const importResult = await customerService.confirmImport(
          req.workspaceId,
          req.companyId,
          req.user._id,
          validCustomersData,
          importType
        );

        return res.status(200).json(
          new ApiResponse(200, "B2C Customers imported successfully", {
            isDirectlyImported: true,
            importResult,
          })
        );
      } catch (err) {
        return res.status(500).json(new ApiResponse(500, `Bulk insert failed: ${err.message}`));
      }
    } else {
      return res.status(400).json(new ApiResponse(400, "No valid B2C customer records found in the file. Ensure the Excel file has valid 'Name' columns."));
    }
  } else {
    // Default to B2B logic
    result = await customerService.previewImport(
      req.workspaceId,
      req.companyId,
      req.file.buffer,
      importType
    );
  }
  
  return res.status(200).json(new ApiResponse(200, "Preview generated successfully", result));
});

export const confirmImport = asyncHandler(async (req, res) => {
  const importType = req.body.importType || "b2b";
  let result;
  
  if (importType === "b2b-outstanding") {
    result = await customerService.confirmB2BOutstandingImport(
      req.workspaceId,
      req.companyId,
      req.user._id,
      req.body.customers
    );
  } else {
    result = await customerService.confirmImport(
      req.workspaceId,
      req.companyId,
      req.user._id,
      req.body.customers,
      importType
    );
  }
  
  return res.status(200).json(new ApiResponse(200, "Customers imported successfully", result));
});

export const importChunk = asyncHandler(async (req, res) => {
  const { customers, importType } = req.body;

  if (!Array.isArray(customers) || customers.length === 0) {
    return res.status(400).json(new ApiResponse(400, "Customers array is required and cannot be empty"));
  }

  const resolvedImportType = importType || "b2c";
  
  const importResult = await customerService.confirmImport(
    req.workspaceId,
    req.companyId,
    req.user._id,
    customers,
    resolvedImportType
  );

  return res.status(200).json(
    new ApiResponse(200, "Chunk imported successfully", {
      importResult,
    })
  );
});

export const previewB2CImport = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json(new ApiResponse(400, "Excel file is required"));
  }

  const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return res.status(400).json(new ApiResponse(400, "Excel file contains no sheets"));
  }

  const sheetNames = workbook.SheetNames;
  const selectedSheet = req.body.sheetName || sheetNames[0];
  const worksheet = workbook.Sheets[selectedSheet];

  if (!worksheet) {
    return res.status(400).json(new ApiResponse(400, `Sheet '${selectedSheet}' not found in workbook`));
  }

  const rawRows = xlsx.utils.sheet_to_json(worksheet, { defval: "" });
  if (rawRows.length === 0) {
    return res.status(400).json(new ApiResponse(400, "The selected sheet is empty"));
  }

  const headers = Object.keys(rawRows[0] || {});

  let columnMapping = {};
  if (req.body.columnMapping) {
    try {
      columnMapping = typeof req.body.columnMapping === "string" 
        ? JSON.parse(req.body.columnMapping) 
        : req.body.columnMapping;
    } catch {
      columnMapping = {};
    }
  }

  const detectedMapping = {
    nameField:
      columnMapping.nameField ||
      headers.find((h) => /name|customer|patient|client/i.test(h)) ||
      headers[0] ||
      "",
    phoneField:
      columnMapping.phoneField ||
      headers.find((h) => /phone|mobile|contact|cell/i.test(h)) ||
      headers[1] ||
      "",
    cityField:
      columnMapping.cityField ||
      headers.find((h) => /city|location|town|district|station|address/i.test(h)) ||
      "",
    genderField:
      columnMapping.genderField ||
      headers.find((h) => /gender|sex/i.test(h)) ||
      "",
  };

  const analysis = await b2cCustomerImportService.analyzeB2CImport(
    req.workspaceId,
    req.companyId,
    rawRows,
    detectedMapping
  );

  return res.status(200).json(
    new ApiResponse(200, "B2C import preview generated successfully", {
      sheetNames,
      selectedSheet,
      headers,
      detectedMapping,
      summary: analysis.summary,
      previewRows: analysis.previewRows,
      allRowsCount: analysis.allRowsCount,
    })
  );
});

export const confirmB2CImport = asyncHandler(async (req, res) => {
  let rawRows = [];

  if (req.file && req.file.buffer) {
    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const selectedSheet = req.body.sheetName || workbook.SheetNames[0];
    const worksheet = workbook.Sheets[selectedSheet];
    if (worksheet) {
      rawRows = xlsx.utils.sheet_to_json(worksheet, { defval: "" });
    }
  } else if (Array.isArray(req.body.rows)) {
    rawRows = req.body.rows;
  }

  if (rawRows.length === 0) {
    return res.status(400).json(new ApiResponse(400, "No customer rows provided for import"));
  }

  let columnMapping = {};
  if (req.body.columnMapping) {
    try {
      columnMapping = typeof req.body.columnMapping === "string"
        ? JSON.parse(req.body.columnMapping)
        : req.body.columnMapping;
    } catch {
      columnMapping = {};
    }
  }

  const startRowNumber = Number(req.body.startRowNumber) || 2;

  const result = await b2cCustomerImportService.executeB2CImport(
    req.workspaceId,
    req.companyId,
    req.user._id,
    rawRows,
    columnMapping,
    { startRowNumber }
  );

  return res.status(200).json(
    new ApiResponse(200, "B2C Customers imported successfully", result)
  );
});

export const receiveAdvance = asyncHandler(async (req, res) => {
  const result = await customerAdvanceService.receiveCustomerAdvance(
    req.workspaceId,
    req.companyId,
    req.user._id,
    {
      customerId: req.params.customerId,
      ...req.body,
    }
  );

  return res
    .status(201)
    .json(new ApiResponse(201, "Customer advance received successfully", result));
});

export const getAdvanceBalance = asyncHandler(async (req, res) => {
  const balance = await customerAdvanceService.getAdvanceBalance(
    req.params.customerId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer advance balance fetched successfully", { advanceBalance: balance }));
});

export const settleCredit = asyncHandler(async (req, res) => {
  const result = await customerAdvanceService.settleCustomerCredit(
    req.workspaceId,
    req.companyId,
    req.user._id,
    {
      customerId: req.params.customerId,
      ...req.body,
    }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer credit settled successfully", result));
});

export const getCreditOutstanding = asyncHandler(async (req, res) => {
  const result = await customerAdvanceService.getCreditOutstanding(
    req.params.customerId,
    req.companyId,
    req.workspaceId,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer credit outstanding fetched successfully", result));
});

export const getCustomerTransactions = asyncHandler(async (req, res) => {
  const result = await customerAdvanceService.getCustomerTransactions(
    req.params.customerId,
    req.companyId,
    req.workspaceId,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer transactions fetched successfully", result));
});

export const getCustomerStatement = asyncHandler(async (req, res) => {
  const result = await customerAdvanceService.getCustomerStatement(
    req.params.customerId,
    req.companyId,
    req.workspaceId,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer statement fetched successfully", result));
});

export const getAllPendingCredits = asyncHandler(async (req, res) => {
  const result = await customerAdvanceService.getAllPendingCredits(
    req.companyId,
    req.workspaceId,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "All pending credits fetched successfully", result));
});

export const updateCustomerRelationship = asyncHandler(async (req, res) => {
  const { customerId, targetCustomerId } = req.params;
  const { relationship, confirmationStatus, notes } = req.body;

  const result = await customerService.updateCustomerRelationship(
    req.workspaceId,
    req.companyId,
    req.user._id,
    customerId,
    targetCustomerId,
    { relationship, confirmationStatus, notes }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer relationship updated successfully", result));
});

export const addCustomerRelationship = asyncHandler(async (req, res) => {
  const { customerId } = req.params;

  const result = await customerService.addCustomerRelationship(
    req.workspaceId,
    req.companyId,
    req.user._id,
    customerId,
    req.body
  );

  return res
    .status(201)
    .json(new ApiResponse(201, "Customer relationship added successfully", result));
});

export const deleteCustomerRelationship = asyncHandler(async (req, res) => {
  const { customerId, targetCustomerId } = req.params;

  const result = await customerService.deleteCustomerRelationship(
    req.workspaceId,
    req.companyId,
    req.user._id,
    customerId,
    targetCustomerId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer relationship removed successfully", result));
});

export const getCustomerCreditNotes = asyncHandler(async (req, res) => {
  const { customerId } = req.params;
  const result = await creditNoteService.getCustomerCreditNotes(
    customerId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer credit notes fetched successfully", result));
});
