import asyncHandler from "../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../utils/ApiResponse.js";
import creditNoteService from "../services/creditNote.service.js";

/**
 * List credit notes with pagination and filters
 */
export const listCreditNotes = asyncHandler(async (req, res) => {
  const branchId =
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.query.branchId ||
    null;

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;

  const query = {
    workspaceId: req.workspaceId,
    companyId: req.companyId,
    branchId,
    customerId: req.query.customerId,
    status: req.query.status,
    search: req.query.search,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    billingMode: req.query.billingMode,
  };

  const options = { page, limit };
  if (req.query.sortBy) {
    const order = req.query.sortOrder === "asc" ? 1 : -1;
    options.sort = { [req.query.sortBy]: order };
  }

  const result = await creditNoteService.getCreditNotes(query, options);

  return res
    .status(200)
    .json(new ApiResponse(200, "Credit notes retrieved successfully", result));
});

/**
 * Get single credit note by ID or Number
 */
export const getCreditNoteById = asyncHandler(async (req, res) => {
  const creditNote = await creditNoteService.getCreditNoteById(
    req.params.id,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Credit note details retrieved successfully", creditNote));
});

/**
 * Get active credit notes and total balance for a customer
 */
export const getCustomerCreditNotes = asyncHandler(async (req, res) => {
  const customerId = req.params.customerId;

  const result = await creditNoteService.getCustomerCreditNotes(
    customerId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Customer credit notes retrieved successfully", result));
});

/**
 * Issue a manual credit note
 */
export const issueManualCreditNote = asyncHandler(async (req, res) => {
  const branchId =
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.body.branchId ||
    null;

  const creditNote = await creditNoteService.issueCreditNote(
    {
      ...req.body,
      workspaceId: req.workspaceId,
      companyId: req.companyId,
      branchId,
      source: "MANUAL",
    },
    { user: req.user }
  );

  return res
    .status(201)
    .json(new ApiResponse(201, "Credit note issued successfully", creditNote));
});

/**
 * Cancel an unredeemed credit note
 */
export const cancelCreditNote = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const cancelledNote = await creditNoteService.cancelCreditNote(
    id,
    reason,
    req.user,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Credit note cancelled successfully", cancelledNote));
});

/**
 * Get credit note summary statistics
 */
export const getCreditNoteSummaryStats = asyncHandler(async (req, res) => {
  const branchId =
    req.headers["x-branch-id"] ||
    req.branchId ||
    req.query.branchId ||
    null;

  const stats = await creditNoteService.getCreditNoteSummaryStats(
    req.companyId,
    req.workspaceId,
    branchId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Credit note statistics retrieved successfully", stats));
});

export default {
  listCreditNotes,
  getCreditNoteById,
  getCustomerCreditNotes,
  issueManualCreditNote,
  cancelCreditNote,
  getCreditNoteSummaryStats,
};

