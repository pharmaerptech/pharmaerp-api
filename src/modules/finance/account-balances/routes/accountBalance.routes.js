import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import {
  getBalances,
  getBalanceByAccountId,
  recalculateBalance,
} from "../controllers/accountBalance.controller.js";

import {
  accountIdParamSchema,
  getBalancesQuerySchema,
} from "../validations/accountBalance.validation.js";

const router = Router();

// Middleware chain for all account balance endpoints
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

router.get("/", validate(getBalancesQuerySchema, "query"), getBalances);

router.get(
  "/:accountId",
  validate(accountIdParamSchema, "params"),
  getBalanceByAccountId,
);

router.post(
  "/:accountId/recalculate",
  validate(accountIdParamSchema, "params"),
  recalculateBalance,
);

export default router;
