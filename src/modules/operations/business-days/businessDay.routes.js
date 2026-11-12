import { Router } from "express";
import {
  openBusinessDay,
  listBusinessDays,
  getOpenBusinessDay,
  getSuggestedBusinessDate,
  getBusinessDayById,
  getBusinessDaySummary,
  closeBusinessDay,
  cancelBusinessDay,
} from "./businessDay.controller.js";

import authMiddleware from "../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../middlewares/workAccess.middleware.js";

const router = Router();

router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch" }));

// ── Business Day lifecycle routes ─────────────────────────────────────────────
router.post("/", openBusinessDay);                          // Open a new Business Day
router.get("/", listBusinessDays);                          // List all Business Days
router.get("/open", getOpenBusinessDay);                    // Get currently open Business Day
router.get("/suggested-date", getSuggestedBusinessDate);    // Get suggested date for next open

// ── Business Day detail routes ────────────────────────────────────────────────
router.get("/:id/summary", getBusinessDaySummary);          // Full financial summary
router.get("/:id", getBusinessDayById);                     // Get by ID

// ── Business Day action routes ────────────────────────────────────────────────
router.patch("/:id/close", closeBusinessDay);               // Close the Business Day
router.patch("/:id/cancel", cancelBusinessDay);             // Cancel the Business Day

export default router;
