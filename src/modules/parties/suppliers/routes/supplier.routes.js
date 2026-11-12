import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import {
  createSupplier,
  getSuppliers,
  getSupplierById,
  updateSupplier,
  deleteSupplier,
  getSupplierLedger,
  getSupplierOutstanding,
  getSupplierPurchases,
  getSupplierPayments,
  previewImport,
  confirmImport,
} from "../controllers/supplier.controller.js";

import {
  createSupplierSchema,
  updateSupplierSchema,
  supplierIdParamSchema,
  getSuppliersQuerySchema,
} from "../validations/supplier.validation.js";

const router = Router();

// Middleware chain for all supplier endpoints
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

import uploadFile from "../../../../middlewares/upload.middleware.js";

// Import APIs
router.post("/import/preview", uploadFile.single("file"), previewImport);
router.post("/import/confirm", confirmImport);

// CRUD
router.post("/", validate(createSupplierSchema), createSupplier);

router.get("/", validate(getSuppliersQuerySchema, "query"), getSuppliers);

router.get(
  "/:supplierId",
  validate(supplierIdParamSchema, "params"),
  getSupplierById,
);

router.patch(
  "/:supplierId",
  validate(supplierIdParamSchema, "params"),
  validate(updateSupplierSchema),
  updateSupplier,
);

router.delete(
  "/:supplierId",
  validate(supplierIdParamSchema, "params"),
  deleteSupplier,
);

// Additional APIs
router.get(
  "/:supplierId/ledger",
  validate(supplierIdParamSchema, "params"),
  getSupplierLedger,
);

router.get(
  "/:supplierId/outstanding",
  validate(supplierIdParamSchema, "params"),
  getSupplierOutstanding,
);

router.get(
  "/:supplierId/purchases",
  validate(supplierIdParamSchema, "params"),
  getSupplierPurchases,
);

router.get(
  "/:supplierId/payments",
  validate(supplierIdParamSchema, "params"),
  getSupplierPayments,
);

export default router;
