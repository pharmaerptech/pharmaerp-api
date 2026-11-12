import { Router } from "express";

import validate from "../../../../middlewares/validate.middleware.js";
import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import workAccessMiddleware, {
  getMethodAwareModes,
} from "../../../../middlewares/workAccess.middleware.js";

import {
  getCatalogGlobalProducts,
  getCatalogGlobalProductById,
  getCatalogGlobalProductByCode,
} from "../controllers/catalogGlobalProduct.controller.js";

import {
  getCatalogGlobalProductsQuerySchema,
  catalogGlobalProductIdParamSchema,
  catalogGlobalProductCodeParamSchema,
} from "../validations/catalogGlobalProduct.validation.js";

const router = Router();

// All requests must come from an authenticated user inside an active workspace
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(
  workAccessMiddleware((req) => ({
    minLevel: req.method === "GET" ? "branch" : "company",
    modes: getMethodAwareModes(req),
  })),
);

// ---------------------
// GET /catalog/global-products
// ---------------------
router.get(
  "/",
  validate(getCatalogGlobalProductsQuerySchema, "query"),
  getCatalogGlobalProducts,
);

// ---------------------
// GET /catalog/global-products/code/:productCode
// ---------------------
router.get(
  "/code/:productCode",
  validate(catalogGlobalProductCodeParamSchema, "params"),
  getCatalogGlobalProductByCode,
);

// ---------------------
// GET /catalog/global-products/:productId
// ---------------------
router.get(
  "/:productId",
  validate(catalogGlobalProductIdParamSchema, "params"),
  getCatalogGlobalProductById,
);

export default router;
