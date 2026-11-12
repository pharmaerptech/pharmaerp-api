import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import {
  createAccountGroup,
  getAccountGroups,
  getAccountGroupById,
  updateAccountGroup,
  deleteAccountGroup,
} from "../controllers/accountGroup.controller.js";

import {
  createAccountGroupSchema,
  updateAccountGroupSchema,
  accountGroupIdParamSchema,
  getAccountGroupsQuerySchema,
} from "../validations/accountGroup.validation.js";

const router = Router();

// Middleware chain for all account group endpoints
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

// CRUD
router.post("/", validate(createAccountGroupSchema), createAccountGroup);
router.get(
  "/",
  validate(getAccountGroupsQuerySchema, "query"),
  getAccountGroups,
);
router.get(
  "/:accountGroupId",
  validate(accountGroupIdParamSchema, "params"),
  getAccountGroupById,
);
router.patch(
  "/:accountGroupId",
  validate(accountGroupIdParamSchema, "params"),
  validate(updateAccountGroupSchema),
  updateAccountGroup,
);
router.delete(
  "/:accountGroupId",
  validate(accountGroupIdParamSchema, "params"),
  deleteAccountGroup,
);

export default router;
