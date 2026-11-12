import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import {
  createPurchaseBill,
  updatePurchaseBill,
  getPurchaseBills,
  getPurchaseBillById,
  ingestPurchaseBill,
  getPurchaseHistory,
  payPurchaseBill,
  bulkPayPurchaseBills,
  importLegacyBills,
} from "../controllers/purchaseBill.controller.js";
import multer from "multer";

const upload = multer({ dest: "uploads/" });

import {
  createPurchaseBillSchema,
  updatePurchaseBillSchema,
  purchaseBillIdParamSchema,
  getPurchaseBillsQuerySchema,
} from "../validations/purchaseBill.validation.js";

const router = Router();

// Middleware chain
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch" }));

// Create purchase bill
router.post("/", validate(createPurchaseBillSchema), createPurchaseBill);

// Update purchase bill
router.put(
  "/:billId",
  validate(purchaseBillIdParamSchema, "params"),
  validate(updatePurchaseBillSchema),
  updatePurchaseBill
);

// List purchase bills
router.get(
  "/",
  validate(getPurchaseBillsQuerySchema, "query"),
  getPurchaseBills
);

// Get purchase bill by id
router.get(
  "/:billId",
  validate(purchaseBillIdParamSchema, "params"),
  getPurchaseBillById
);

// Get purchase history by product ID
// We can use a custom validation or just let the repository handle the ObjectId check
router.get(
  "/purchase-history/:productId",
  getPurchaseHistory
);

// Ingest stock from purchase bill
router.post(
  "/:billId/ingest",
  validate(purchaseBillIdParamSchema, "params"),
  ingestPurchaseBill
);

// Bulk pay purchase bills
router.post(
  "/bulk/pay",
  bulkPayPurchaseBills
);

// Pay purchase bill
router.post(
  "/:billId/pay",
  validate(purchaseBillIdParamSchema, "params"),
  payPurchaseBill
);

// Import legacy bills
router.post(
  "/import/legacy-bills",
  upload.single("file"),
  importLegacyBills
);

export default router;
