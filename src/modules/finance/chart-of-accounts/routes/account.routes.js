import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import {
  createAccount,
  getAccounts,
  getAccountById,
  updateAccount,
  deleteAccount,
} from "../controllers/account.controller.js";

import {
  createAccountSchema,
  updateAccountSchema,
  accountIdParamSchema,
  getAccountsQuerySchema,
} from "../validations/account.validation.js";

const router = Router();

// Middleware chain for all account endpoints
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

// CRUD
router.post("/", validate(createAccountSchema), createAccount);
router.get("/", validate(getAccountsQuerySchema, "query"), getAccounts);
router.get(
  "/:accountId",
  validate(accountIdParamSchema, "params"),
  getAccountById,
);
router.patch(
  "/:accountId",
  validate(accountIdParamSchema, "params"),
  validate(updateAccountSchema),
  updateAccount,
);
router.delete(
  "/:accountId",
  validate(accountIdParamSchema, "params"),
  deleteAccount,
);

export default router;
