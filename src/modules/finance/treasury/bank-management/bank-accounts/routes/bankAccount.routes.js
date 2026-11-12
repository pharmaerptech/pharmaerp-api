import { Router } from "express";
import authMiddleware from "../../../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../../../middlewares/validate.middleware.js";

import {
  createBankAccount,
  getBankAccounts,
  getBankAccountById,
  updateBankAccount,
  deleteBankAccount,
  setPrimary,
} from "../controllers/bankAccount.controller.js";

import {
  createBankAccountSchema,
  updateBankAccountSchema,
  bankAccountIdParamSchema,
  getBankAccountsQuerySchema,
} from "../validations/bankAccount.validation.js";

const router = Router();

// Middleware chain for context
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

// Routes
router.post("/", validate(createBankAccountSchema), createBankAccount);
router.get("/", validate(getBankAccountsQuerySchema, "query"), getBankAccounts);

router.get(
  "/:bankAccountId",
  validate(bankAccountIdParamSchema, "params"),
  getBankAccountById,
);

router.patch(
  "/:bankAccountId",
  validate(bankAccountIdParamSchema, "params"),
  validate(updateBankAccountSchema),
  updateBankAccount,
);

router.delete(
  "/:bankAccountId",
  validate(bankAccountIdParamSchema, "params"),
  deleteBankAccount,
);

router.post(
  "/:bankAccountId/set-primary",
  validate(bankAccountIdParamSchema, "params"),
  setPrimary,
);

export default router;
