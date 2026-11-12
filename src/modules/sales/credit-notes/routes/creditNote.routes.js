import { Router } from "express";
import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";

import {
  listCreditNotes,
  getCreditNoteById,
  getCustomerCreditNotes,
  issueManualCreditNote,
  cancelCreditNote,
  getCreditNoteSummaryStats,
} from "../controllers/creditNote.controller.js";

import {
  creditNoteIdParamSchema,
  customerIdParamSchema,
  queryCreditNotesSchema,
  createManualCreditNoteSchema,
  cancelCreditNoteSchema,
} from "../validations/creditNote.validation.js";

const router = Router();

// Apply auth & context middlewares
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch" }));

// Routes
router.get("/stats", getCreditNoteSummaryStats);

router.get("/", validate(queryCreditNotesSchema, "query"), listCreditNotes);

router.get(
  "/customer/:customerId",
  validate(customerIdParamSchema, "params"),
  getCustomerCreditNotes
);

router.get(
  "/:id",
  validate(creditNoteIdParamSchema, "params"),
  getCreditNoteById
);

router.post(
  "/",
  validate(createManualCreditNoteSchema),
  issueManualCreditNote
);

router.post(
  "/:id/cancel",
  validate(creditNoteIdParamSchema, "params"),
  validate(cancelCreditNoteSchema),
  cancelCreditNote
);

export default router;

