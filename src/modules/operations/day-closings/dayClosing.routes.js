import { Router } from "express";
import {
  createDayClosing,
  listDayClosings,
  getDayClosingById,
  getDraftDayClosingSummary,
  getDayClosingSummary,
  updateDayClosing,
  syncDayClosingController,
  updateDayClosingStatus,
  cancelDayClosing,
} from "./dayClosing.controller.js";

import authMiddleware from "../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../middlewares/workAccess.middleware.js";

const router = Router();

router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch" }));

router.post("/", createDayClosing);
router.get("/", listDayClosings);
router.get("/draft-summary", getDraftDayClosingSummary);
router.get("/:id/summary", getDayClosingSummary);
router.get("/:id", getDayClosingById);
router.put("/:id", updateDayClosing);
router.patch("/:id/sync", syncDayClosingController);
router.patch("/:id/status", updateDayClosingStatus);
router.patch("/:id/cancel", cancelDayClosing);

export default router;
