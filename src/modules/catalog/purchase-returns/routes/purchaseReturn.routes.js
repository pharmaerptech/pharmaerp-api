import { Router } from "express";
import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import {
  createPurchaseReturn,
  getPurchaseReturns,
  getPurchaseReturnById,
  getEligibleBatches,
  cancelPurchaseReturn,
  dispatchReturnBox,
  receiveReturnBox,
  ingestFreshStockToStore,
} from "../controllers/purchaseReturn.controller.js";

import {
  createPurchaseReturnSchema,
  getPurchaseReturnsQuerySchema,
  getEligibleBatchesQuerySchema,
  purchaseReturnIdParamSchema,
  cancelPurchaseReturnSchema,
  dispatchReturnBoxSchema,
} from "../validations/purchaseReturn.validation.js";

const router = Router();

// Middleware chain
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);

// Get eligible batches with FIFO inflow details
router.get(
  "/eligible-batches",
  validate(getEligibleBatchesQuerySchema, "query"),
  getEligibleBatches
);

// Create purchase return
router.post(
  "/",
  validate(createPurchaseReturnSchema),
  createPurchaseReturn
);

// List purchase returns
router.get(
  "/",
  validate(getPurchaseReturnsQuerySchema, "query"),
  getPurchaseReturns
);

// Get single purchase return by ID
router.get(
  "/:returnId",
  validate(purchaseReturnIdParamSchema, "params"),
  getPurchaseReturnById
);

// Cancel purchase return and reverse stock
router.post(
  "/:returnId/cancel",
  validate(purchaseReturnIdParamSchema, "params"),
  validate(cancelPurchaseReturnSchema),
  cancelPurchaseReturn
);

// Dispatch / ship return box to destination facility or other company branch
router.post(
  "/:returnId/dispatch",
  validate(purchaseReturnIdParamSchema, "params"),
  validate(dispatchReturnBoxSchema),
  dispatchReturnBox
);

// Mark incoming return box as received at destination facility
router.post(
  "/:returnId/receive-box",
  validate(purchaseReturnIdParamSchema, "params"),
  receiveReturnBox
);

// Ingest fresh general return stock directly into store shelf inventory
router.post(
  "/:returnId/ingest-to-store",
  validate(purchaseReturnIdParamSchema, "params"),
  ingestFreshStockToStore
);

export default router;

