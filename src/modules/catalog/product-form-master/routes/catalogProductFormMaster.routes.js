import { Router } from "express";

import validate from "../../../../middlewares/validate.middleware.js";
import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import workAccessMiddleware, {
  getMethodAwareModes,
} from "../../../../middlewares/workAccess.middleware.js";

import {
  getCatalogProductFormMasters,
  getCatalogProductFormMasterById,
} from "../controllers/catalogProductFormMaster.controller.js";

import {
  getCatalogProductFormMastersQuerySchema,
  catalogProductFormMasterIdParamSchema,
} from "../validations/catalogProductFormMaster.validation.js";

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
// GET /catalog/product-form-master
// ---------------------
router.get(
  "/",
  validate(getCatalogProductFormMastersQuerySchema, "query"),
  getCatalogProductFormMasters,
);

// ---------------------
// GET /catalog/product-form-master/:formId
// ---------------------
router.get(
  "/:formId",
  validate(catalogProductFormMasterIdParamSchema, "params"),
  getCatalogProductFormMasterById,
);

export default router;
