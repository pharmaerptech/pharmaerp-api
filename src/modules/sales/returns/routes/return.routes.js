import { Router } from "express";
import {
  recordCustomerReturn,
  getNextReturnNumber,
  getAllCustomerReturns,
  getReturnById,
  ingestFreshStockToStore,
  quarantineScrapToStore,
  approveSalesReturn,
} from "../controllers/return.controller.js";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";

const router = Router();

// Apply standard middlewares
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch" }));

// Routes
router.get("/next-number", getNextReturnNumber);
router.get("/", getAllCustomerReturns);
router.get("/:returnId", getReturnById);
router.put("/:returnId/approve", approveSalesReturn);
router.post("/:returnId/approve", approveSalesReturn);
router.post("/:returnId/ingest-to-store", ingestFreshStockToStore);
router.post("/:returnId/quarantine-scrap", quarantineScrapToStore);
router.post("/customer/:customerId?", recordCustomerReturn);
router.post("/", recordCustomerReturn);

export default router;
