import { Router } from "express";
import authMiddleware from "../../../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../../../middlewares/validate.middleware.js";

import {
  createCashExchange,
  getCashExchanges,
  getCashExchangeById,
} from "../controllers/cashExchange.controller.js";

import {
  createCashExchangeSchema,
  cashExchangeIdParamSchema,
  getCashExchangesQuerySchema,
} from "../validations/cashExchange.validation.js";

const router = Router();

// Middleware chain
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch" }));

// Routes
router.post("/", validate(createCashExchangeSchema), createCashExchange);
router.get("/", validate(getCashExchangesQuerySchema, "query"), getCashExchanges);

router.get(
  "/:cashExchangeId",
  validate(cashExchangeIdParamSchema, "params"),
  getCashExchangeById,
);

export default router;
