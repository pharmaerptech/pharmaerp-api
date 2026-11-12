import { Router } from "express";

import validate from "../../../../middlewares/validate.middleware.js";
import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import permissionMiddleware from "../../../../middlewares/permission.middleware.js";

import {
  searchBeforeCreateWorkspaceProduct,
  createWorkspaceProduct,
  getWorkspaceProducts,
  getWorkspaceProductById,
  getWorkspaceProductByCode,
  updateWorkspaceProduct,
  deleteWorkspaceProduct,
  detectInventoryProducts,
  importWorkspaceProducts,
  importWorkspaceProductsGst,
  getProductFacilityBatchesByQueryV2,
} from "../controllers/workspaceProduct.controller.js";

import {
  createWorkspaceProductSchema,
  updateWorkspaceProductSchema,
  workspaceProductIdParamSchema,
  workspaceProductCodeParamSchema,
  getWorkspaceProductsQuerySchema,
  searchBeforeCreateQuerySchema,
} from "../validations/workspaceProduct.validation.js";

import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import workAccessMiddleware, {
  getMethodAwareModes,
} from "../../../../middlewares/workAccess.middleware.js";
import uploadFile from "../../../../middlewares/upload.middleware.js";

const router = Router();

// All workspace product routes require authentication + active workspace membership
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(
  workAccessMiddleware((req) => ({
    minLevel:
      req.method === "DELETE" ||
      req.path.startsWith("/import") ||
      req.path === "/detect"
        ? "company"
        : "branch",
    modes: getMethodAwareModes(req),
  })),
);

// ---------------------
// POST /catalog/products/detect
// Detect inventory file, parse rows, and match brand mappings
// ---------------------
router.post(
  "/detect",
  permissionMiddleware("catalog:product:create"),
  uploadFile.single("file"),
  detectInventoryProducts,
);

// ---------------------
// POST /catalog/products/import
// Bulk import workspace products, stock, and batch entries via file upload or JSON payload
// ---------------------
router.post(
  "/import",
  permissionMiddleware("catalog:product:create"),
  uploadFile.single("file"),
  importWorkspaceProducts,
);

// ---------------------
// POST /catalog/products/import-gst
// Bulk import GST and HSN mapping via file upload or JSON payload
// ---------------------
router.post(
  "/import-gst",
  permissionMiddleware("catalog:product:create"),
  uploadFile.single("file"),
  importWorkspaceProductsGst,
);

// ---------------------
// GET /catalog/products
// ---------------------
router.get(
  "/",
  validate(getWorkspaceProductsQuerySchema, "query"),
  getWorkspaceProducts,
);

// ---------------------
// GET /catalog/products/search?name=...&productType=...
// Search global catalog BEFORE creating a workspace product.
// Frontend calls this first to check for existing global products.
// ---------------------
router.get(
  "/search",
  validate(searchBeforeCreateQuerySchema, "query"),
  searchBeforeCreateWorkspaceProduct,
);

// ---------------------
// GET /catalog/products/code/:productCode
// ---------------------
router.get(
  "/code/:productCode",
  validate(workspaceProductCodeParamSchema, "params"),
  getWorkspaceProductByCode,
);

// ---------------------
// GET /catalog/products/:productId
// ---------------------
router.get(
  "/:productId",
  validate(workspaceProductIdParamSchema, "params"),
  getWorkspaceProductById,
);

// ---------------------
// POST /catalog/products
// ---------------------
router.post(
  "/",
  permissionMiddleware("catalog:product:create"),
  validate(createWorkspaceProductSchema),
  createWorkspaceProduct,
);

// ---------------------
// PATCH /catalog/products/:productId
// ---------------------
router.patch(
  "/:productId",
  permissionMiddleware("catalog:product:update"),
  validate(workspaceProductIdParamSchema, "params"),
  validate(updateWorkspaceProductSchema),
  updateWorkspaceProduct,
);

// ---------------------
// DELETE /catalog/products/:productId
// ---------------------
router.delete(
  "/:productId",
  permissionMiddleware("catalog:product:delete"),
  validate(workspaceProductIdParamSchema, "params"),
  deleteWorkspaceProduct,
);

// ---------------------
// POST /catalog/products/workspace-product/batches/query
// ---------------------
router.post(
  "/workspace-product/batches/query",
  getProductFacilityBatchesByQueryV2,
);

export default router;
