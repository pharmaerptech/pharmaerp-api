import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import {
  setAccountOpeningBalance,
  setCustomerOpeningBalance,
  setSupplierOpeningBalance,
  setBankAccountOpeningBalance,
} from "../controllers/openingBalance.controller.js";

import {
  setAccountOpeningBalanceSchema,
  setCustomerOpeningBalanceSchema,
  setSupplierOpeningBalanceSchema,
  setBankAccountOpeningBalanceSchema,
} from "../validations/openingBalance.validation.js";

const router = Router();

// Middleware chain for all endpoints
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

// Routes
router.post(
  "/account",
  validate(setAccountOpeningBalanceSchema),
  setAccountOpeningBalance,
);
router.post(
  "/customer",
  validate(setCustomerOpeningBalanceSchema),
  setCustomerOpeningBalance,
);
router.post(
  "/supplier",
  validate(setSupplierOpeningBalanceSchema),
  setSupplierOpeningBalance,
);
router.post(
  "/bank-account",
  validate(setBankAccountOpeningBalanceSchema),
  setBankAccountOpeningBalance,
);

export default router;
