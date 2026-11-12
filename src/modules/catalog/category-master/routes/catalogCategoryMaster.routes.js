import { Router } from "express";

import validate from "../../../../middlewares/validate.middleware.js";
import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import workAccessMiddleware, {
  getMethodAwareModes,
} from "../../../../middlewares/workAccess.middleware.js";

import {
  getCatalogCategoryMasters,
  getCatalogCategoryMasterById,
  getCatalogCategoryMasterBySlug,
} from "../controllers/catalogCategoryMaster.controller.js";

import {
  getCatalogCategoryMastersQuerySchema,
  catalogCategoryMasterIdParamSchema,
  catalogCategoryMasterSlugParamSchema,
} from "../validations/catalogCategoryMaster.validation.js";

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
// GET /catalog/category-master
// ---------------------
router.get(
  "/",
  validate(getCatalogCategoryMastersQuerySchema, "query"),
  getCatalogCategoryMasters,
);

// ---------------------
// GET /catalog/category-master/slug/:slug
// ---------------------
router.get(
  "/slug/:slug",
  validate(catalogCategoryMasterSlugParamSchema, "params"),
  getCatalogCategoryMasterBySlug,
);

// ---------------------
// GET /catalog/category-master/:categoryId
// ---------------------
router.get(
  "/:categoryId",
  validate(catalogCategoryMasterIdParamSchema, "params"),
  getCatalogCategoryMasterById,
);

export default router;
