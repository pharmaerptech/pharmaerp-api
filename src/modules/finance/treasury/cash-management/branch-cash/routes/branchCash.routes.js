import { Router } from "express";
import authMiddleware from "../../../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../../../middlewares/validate.middleware.js";

import {
  initializeBranchCash,
  getAllBranchCash,
  getBranchCash,
  depositCash,
  withdrawCash,
  getFrozenHistory,
} from "../controllers/branchCash.controller.js";

import {
  initializeBranchCashSchema,
  depositSchema,
  withdrawSchema,
} from "../validations/branchCash.validation.js";

const router = Router();

router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch" }));

// Initialize BranchCash with opening balance (user-triggered, post branch creation)
router.post("/initialize", validate(initializeBranchCashSchema), initializeBranchCash);


// List all branches' cash for company
router.get("/", getAllBranchCash);

// Get cash for a specific branch (running + frozen + denominations)
router.get("/:branchId", getBranchCash);

// Deposit external cash into running partition (shift must be open)
router.post("/deposit", validate(depositSchema), depositCash);

// Withdraw cash from running / frozen (shift must be open — enforced by service)
router.post("/withdraw", validate(withdrawSchema), withdrawCash);

// Frozen cash history for a specific date (used by day-closing timeline)
router.get("/:branchId/frozen-history", getFrozenHistory);

export default router;
