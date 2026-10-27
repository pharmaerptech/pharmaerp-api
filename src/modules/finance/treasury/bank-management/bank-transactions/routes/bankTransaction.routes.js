import { Router } from "express";
import authMiddleware from "../../../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../../../middlewares/companyContext.middleware.js";
import validate from "../../../../../../middlewares/validate.middleware.js";

import {
  getBankTransactions,
  getBankTransactionById,
  cancelBankTransaction,
  depositBankTransaction,
  withdrawBankTransaction,
} from "../controllers/bankTransaction.controller.js";

import {
  cancelBankTransactionSchema,
  bankTransactionIdParamSchema,
  getBankTransactionsQuerySchema,
  directDepositSchema,
  directWithdrawSchema,
} from "../validations/bankTransaction.validation.js";

const router = Router();

// Middleware chain
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);

// Routes
router.get("/", validate(getBankTransactionsQuerySchema, "query"), getBankTransactions);

// Direct Deposit into Bank Account (Always Directly POSTED)
router.post(
  "/deposit",
  validate(directDepositSchema),
  depositBankTransaction,
);

// Direct Withdrawal from Bank Account (Always Directly POSTED)
router.post(
  "/withdraw",
  validate(directWithdrawSchema),
  withdrawBankTransaction,
);

router.get(
  "/:bankTransactionId",
  validate(bankTransactionIdParamSchema, "params"),
  getBankTransactionById,
);

router.post(
  "/:bankTransactionId/cancel",
  validate(bankTransactionIdParamSchema, "params"),
  validate(cancelBankTransactionSchema),
  cancelBankTransaction,
);

export default router;
