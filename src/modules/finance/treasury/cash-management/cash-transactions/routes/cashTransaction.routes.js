import { Router } from "express";
import authMiddleware from "../../../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../../../middlewares/validate.middleware.js";

import {
  getCashTransactions,
  getCashTransactionById,
  cancelCashTransaction,
} from "../controllers/cashTransaction.controller.js";

import {
  cancelCashTransactionSchema,
  cashTransactionIdParamSchema,
  getCashTransactionsQuerySchema,
} from "../validations/cashTransaction.validation.js";

const router = Router();

// Middleware chain
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch" }));

// Routes
router.get("/", validate(getCashTransactionsQuerySchema, "query"), getCashTransactions);

router.get(
  "/:cashTransactionId",
  validate(cashTransactionIdParamSchema, "params"),
  getCashTransactionById,
);

router.post(
  "/:cashTransactionId/cancel",
  validate(cashTransactionIdParamSchema, "params"),
  validate(cancelCashTransactionSchema),
  cancelCashTransaction,
);

export default router;
