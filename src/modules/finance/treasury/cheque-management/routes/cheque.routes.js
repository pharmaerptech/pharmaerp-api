import { Router } from "express";
import authMiddleware from "../../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../../middlewares/validate.middleware.js";

import {
  createCheque,
  getCheques,
  getChequeById,
  depositCheque,
  clearCheque,
  bounceCheque,
  cancelCheque,
} from "../controllers/cheque.controller.js";

import {
  createChequeSchema,
  clearChequeSchema,
  bounceChequeSchema,
  cancelChequeSchema,
  chequeIdParamSchema,
  getChequesQuerySchema,
} from "../validations/cheque.validation.js";

const router = Router();

// Middleware chain
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

// Collection routes
router.post("/", validate(createChequeSchema), createCheque);
router.get("/", validate(getChequesQuerySchema, "query"), getCheques);

// Document routes
router.get(
  "/:chequeId",
  validate(chequeIdParamSchema, "params"),
  getChequeById,
);

// Lifecycle action routes
router.post(
  "/:chequeId/deposit",
  validate(chequeIdParamSchema, "params"),
  depositCheque,
);

router.post(
  "/:chequeId/clear",
  validate(chequeIdParamSchema, "params"),
  validate(clearChequeSchema),
  clearCheque,
);

router.post(
  "/:chequeId/bounce",
  validate(chequeIdParamSchema, "params"),
  validate(bounceChequeSchema),
  bounceCheque,
);

router.post(
  "/:chequeId/cancel",
  validate(chequeIdParamSchema, "params"),
  validate(cancelChequeSchema),
  cancelCheque,
);

export default router;
