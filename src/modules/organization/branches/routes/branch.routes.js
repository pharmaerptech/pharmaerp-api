import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import workAccessMiddleware, {
  requireWorkAccess,
} from "../../../../middlewares/workAccess.middleware.js";

import validate from "../../../../middlewares/validate.middleware.js";

import {
  createBranch,
  getCompanyBranches,
  getWorkspaceBranches,
  getBranchById,
  getBranchMembers,
  updateBranch,
  deleteBranch,
} from "../controllers/branch.controller.js";

import {
  createBranchSchema,
  updateBranchSchema,
} from "../validations/branch.validation.js";

const router = Router();

router.use(authMiddleware);
router.use(workspaceContextMiddleware);

/*
|--------------------------------------------------------------------------
| Workspace Level Routes
|--------------------------------------------------------------------------
*/

// Boot hydration needs permitted branch discovery regardless of active level/mode
router.get(
  "/workspace/all",
  workAccessMiddleware({ allowBootDiscovery: true }),
  getWorkspaceBranches,
);

router.get(
  "/:branchId/members",
  requireWorkAccess({ minLevel: "branch", modes: ["view", "operation"] }),
  getBranchMembers,
);
router.get(
  "/:branchId/employees",
  requireWorkAccess({ minLevel: "branch", modes: ["view", "operation"] }),
  getBranchMembers,
);

/*
|--------------------------------------------------------------------------
| Company Level Routes
|--------------------------------------------------------------------------
*/

router.use(companyContextMiddleware);

router.post(
  "/",
  requireWorkAccess({ minLevel: "company", modes: ["operation"] }),
  validate(createBranchSchema),
  createBranch,
);

router.get(
  "/",
  workAccessMiddleware({ allowBootDiscovery: true }),
  getCompanyBranches,
);

router.get(
  "/:branchId",
  requireWorkAccess({ minLevel: "branch", modes: ["view", "operation"] }),
  getBranchById,
);

router.patch(
  "/:branchId",
  requireWorkAccess({ minLevel: "company", modes: ["operation"] }),
  validate(updateBranchSchema),
  updateBranch,
);

router.delete(
  "/:branchId",
  requireWorkAccess({ minLevel: "company", modes: ["operation"] }),
  deleteBranch,
);

export default router;
