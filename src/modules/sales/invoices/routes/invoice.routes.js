import { Router } from "express";
import {
  recordCustomerSale,
  getCustomerSales,
  getAllCustomerSales,
  updateCustomerSale,
  cancelCustomerSale,
  getNextInvoiceNumber,
  getInvoiceById,
} from "../controllers/invoice.controller.js";

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
router.get("/next-number", getNextInvoiceNumber);
router.get("/", getAllCustomerSales);
router.get("/customer/:customerId", getCustomerSales);
router.get("/:invoiceId", getInvoiceById);
router.post("/customer/:customerId?", recordCustomerSale);
router.post("/", recordCustomerSale);
router.put("/customer/:invoiceId", updateCustomerSale);
router.put("/customer/:customerId/:invoiceId", updateCustomerSale);
router.put("/:invoiceId", updateCustomerSale);
router.put("/:invoiceId/cancel", cancelCustomerSale);

export default router;
