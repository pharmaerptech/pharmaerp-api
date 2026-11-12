import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import {
  getLedger,
  recalculateLedger,
} from "../controllers/ledger.controller.js";

import {
  getLedgerQuerySchema,
  recalculateLedgerSchema,
} from "../validations/ledger.validation.js";

const router = Router();

// Middleware chain for all endpoints
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

// Routes
router.get("/", validate(getLedgerQuerySchema, "query"), getLedger);
router.post(
  "/recalculate",
  validate(recalculateLedgerSchema),
  recalculateLedger,
);

export default router;
