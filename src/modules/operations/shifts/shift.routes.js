import { Router } from "express";
import {
  createShift,
  listShifts,
  getOpenShift,
  getShiftById,
  getShiftByShiftNo,
  getShiftCountByDate,
  getShiftSummary,
  updateShift,
  syncShiftController,
  updateShiftStatus,
  cancelShift,
} from "./shift.controller.js";

import authMiddleware from "../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../middlewares/workAccess.middleware.js";

const router = Router();

router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch" }));

router.post("/", createShift);
router.get("/", listShifts);
router.get("/open", getOpenShift);
router.get("/count", getShiftCountByDate);
router.get("/by-number/:shiftNo", getShiftByShiftNo);
router.get("/:id/summary", getShiftSummary);
router.get("/:id", getShiftById);
router.put("/:id", updateShift);
router.patch("/:id/sync", syncShiftController);
router.patch("/:id/status", updateShiftStatus);
router.patch("/:id/cancel", cancelShift);

export default router;
