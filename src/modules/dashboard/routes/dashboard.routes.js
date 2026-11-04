import { Router } from "express";
import authMiddleware from "../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../middlewares/companyContext.middleware.js";
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

// GET /api/v1/dashboard/workspace (Only workspace context required)
router.get("/workspace", getWorkspaceDashboard);

// GET /api/v1/dashboard/company (Requires company context)
router.get("/company", companyContextMiddleware, getCompanyDashboard);

// GET /api/v1/dashboard/branch (Scoped to branch/company)
router.get("/branch", getBranchDashboard);

// GET /api/v1/dashboard/overview
router.get("/overview", getDashboardOverview);
router.get("/", getDashboardOverview);

export default router;
