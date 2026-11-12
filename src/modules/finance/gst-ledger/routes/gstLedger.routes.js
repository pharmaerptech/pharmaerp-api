import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";

import {
  getGstr1Ledger,
  getGstr1Summary,
  getGstr2Ledger,
  getGstr3bSummary,
  createGstr1Ledger,
  createGstr2Ledger,
} from "../controllers/gstLedger.controller.js";

const router = Router();

// Middleware chain for all endpoints
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

// Routes
router.get("/gstr-1/summary", getGstr1Summary);
router.get("/gstr-1", getGstr1Ledger);
router.post("/gstr-1", createGstr1Ledger);
router.get("/gstr-2", getGstr2Ledger);
router.post("/gstr-2", createGstr2Ledger);
router.get("/gstr-3b/summary", getGstr3bSummary);

export default router;
