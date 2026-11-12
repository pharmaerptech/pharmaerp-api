import { Router } from "express";
import authMiddleware from "../../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../../middlewares/validate.middleware.js";

import {
  createBankDepositSlip,
  getBankDepositSlips,
  getBankDepositSlipById,
  confirmDeposit,
  cancelBankDepositSlip,
  withdrawFromBankDepositSlip,
  getCashInTransit,
} from "../controllers/bankDepositSlip.controller.js";

import {
  createBankDepositSlipSchema,
  confirmDepositSchema,
  cancelBankDepositSlipSchema,
  slipIdParamSchema,
  getBankDepositSlipsQuerySchema,
  withdrawFromSlipSchema,
  getCashInTransitQuerySchema,
} from "../validations/bankDepositSlip.validation.js";

const router = Router();

// Middleware chain (mirrors all other treasury modules)
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /treasury/bank-deposit-slips/cash-in-transit
// Company-scope view of all PREPARED slips with remainingAmount (must be before /:slipId)
router.get(
  "/cash-in-transit",
  validate(getCashInTransitQuerySchema, "query"),
  getCashInTransit,
);


// POST /treasury/bank-deposit-slips
// Create a new bank deposit slip (Status → PREPARED)
router.post("/", validate(createBankDepositSlipSchema), createBankDepositSlip);

// GET /treasury/bank-deposit-slips
// List all slips (filterable by status, dates, accounts, etc.)
router.get(
  "/",
  validate(getBankDepositSlipsQuerySchema, "query"),
  getBankDepositSlips,
);

// GET /treasury/bank-deposit-slips/:slipId
// Get a single slip by ID
router.get(
  "/:slipId",
  validate(slipIdParamSchema, "params"),
  getBankDepositSlipById,
);

// POST /treasury/bank-deposit-slips/:slipId/confirm-deposit
// Confirm that the bank received the cash (Status: PREPARED → DEPOSITED)
router.post(
  "/:slipId/confirm-deposit",
  validate(slipIdParamSchema, "params"),
  validate(confirmDepositSchema),
  confirmDeposit,
);

// POST /treasury/bank-deposit-slips/:slipId/cancel
// Cancel the slip (reverses journals, returns remainingAmount denominations to frozen)
router.post(
  "/:slipId/cancel",
  validate(slipIdParamSchema, "params"),
  validate(cancelBankDepositSlipSchema),
  cancelBankDepositSlip,
);

// POST /treasury/bank-deposit-slips/:slipId/withdraw
// Partial withdraw from a PREPARED slip before deposit
router.post(
  "/:slipId/withdraw",
  validate(slipIdParamSchema, "params"),
  validate(withdrawFromSlipSchema),
  withdrawFromBankDepositSlip,
);

export default router;
