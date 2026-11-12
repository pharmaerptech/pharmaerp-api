import { Router } from "express";
import authMiddleware from "../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../middlewares/companyContext.middleware.js";
import { requireWorkAccess } from "../../../middlewares/workAccess.middleware.js";
import {
  getDashboardOverview,
  getBranchDashboard,
  getCompanyDashboard,
  getWorkspaceDashboard,
} from "../controllers/dashboard.controller.js";

const router = Router();

// Base middleware chain for all dashboard routes
router.use(authMiddleware);
router.use(workspaceContextMiddleware);

// GET /api/v1/dashboard/workspace
router.get(
  "/workspace",
  requireWorkAccess({ minLevel: "workspace", modes: ["view"], strictActiveLevel: true }),
  getWorkspaceDashboard,
);

// GET /api/v1/dashboard/company (Requires company context)
router.get(
  "/company",
  companyContextMiddleware,
  requireWorkAccess({ minLevel: "company", modes: ["view"], strictActiveLevel: true }),
  getCompanyDashboard,
);

// GET /api/v1/dashboard/branch (Scoped to branch/company)
router.get(
  "/branch",
  requireWorkAccess({ minLevel: "branch", modes: ["view"], strictActiveLevel: true }),
  getBranchDashboard,
);

// GET /api/v1/dashboard/overview
router.get(
  "/overview",
  requireWorkAccess({ minLevel: "branch", modes: ["view"] }),
  getDashboardOverview,
);
router.get(
  "/",
  requireWorkAccess({ minLevel: "branch", modes: ["view"] }),
  getDashboardOverview,
);

export default router;
