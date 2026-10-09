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

// Middleware chain for dashboard overview.
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);

// GET /api/v1/dashboard/branch
router.get("/branch", getBranchDashboard);

// GET /api/v1/dashboard/company
router.get("/company", getCompanyDashboard);

// GET /api/v1/dashboard/workspace
router.get("/workspace", getWorkspaceDashboard);

// GET /api/v1/dashboard/overview
router.get("/overview", getDashboardOverview);
router.get("/", getDashboardOverview);

export default router;
