import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import {
  createPeriod,
  getPeriods,
  getCurrentPeriod,
  updatePeriodStatus,
} from "../controllers/financialPeriod.controller.js";

import {
  createPeriodSchema,
  updatePeriodStatusSchema,
  periodIdParamSchema,
  getPeriodsQuerySchema,
} from "../validations/financialPeriod.validation.js";

const router = Router();

// Middleware chain for all endpoints
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

// Routes
router.post("/", validate(createPeriodSchema), createPeriod);
router.get("/", validate(getPeriodsQuerySchema, "query"), getPeriods);
router.get("/current", getCurrentPeriod);

router.patch(
  "/:periodId/status",
  validate(periodIdParamSchema, "params"),
  validate(updatePeriodStatusSchema),
  updatePeriodStatus,
);

export default router;
