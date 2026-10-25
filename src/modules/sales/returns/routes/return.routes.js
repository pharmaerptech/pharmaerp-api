import { Router } from "express";
import {
  recordCustomerReturn,
  getNextReturnNumber,
  getAllCustomerReturns,
  getReturnById,
} from "../controllers/return.controller.js";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";

const router = Router();

// Apply standard middlewares
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);

// Routes
router.get("/next-number", getNextReturnNumber);
router.get("/", getAllCustomerReturns);
router.get("/:returnId", getReturnById);
router.post("/customer/:customerId?", recordCustomerReturn);
router.post("/", recordCustomerReturn);

export default router;
