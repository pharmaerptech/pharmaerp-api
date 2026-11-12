import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import workAccessMiddleware, {
  requireWorkAccess,
} from "../../../../middlewares/workAccess.middleware.js";

import validate from "../../../../middlewares/validate.middleware.js";

import {
  createCompany,
  getWorkspaceCompanies,
  getCompanyById,
  getCompanyMembers,
  updateCompany,
  deleteCompany,
} from "../controllers/company.controller.js";

import {
  createCompanySchema,
  updateCompanySchema,
} from "../validations/company.validation.js";

const router = Router();

router.use(authMiddleware);
router.use(workspaceContextMiddleware);

router.post(
  "/",
  requireWorkAccess({ minLevel: "workspace", modes: ["operation"] }),
  validate(createCompanySchema),
  createCompany,
);

// Boot hydration needs permitted company list regardless of level
router.get("/", workAccessMiddleware({ allowBootDiscovery: true }), getWorkspaceCompanies);

router.get(
  "/:companyId/members",
  requireWorkAccess({ minLevel: "company", modes: ["view", "operation"] }),
  getCompanyMembers,
);
router.get(
  "/:companyId/employees",
  requireWorkAccess({ minLevel: "company", modes: ["view", "operation"] }),
  getCompanyMembers,
);

// Single company lookup is allowed down to branch level for branch headers/context
router.get(
  "/:companyId",
  requireWorkAccess({ minLevel: "branch", modes: ["view", "operation"] }),
  getCompanyById,
);

router.patch(
  "/:companyId",
  requireWorkAccess({ minLevel: "company", modes: ["operation"] }),
  validate(updateCompanySchema),
  updateCompany,
);

router.delete(
  "/:companyId",
  requireWorkAccess({ minLevel: "workspace", modes: ["operation"] }),
  deleteCompany,
);

export default router;
