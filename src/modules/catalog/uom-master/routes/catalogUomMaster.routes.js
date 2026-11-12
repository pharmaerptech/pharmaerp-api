import { Router } from "express";

import validate from "../../../../middlewares/validate.middleware.js";
import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import workAccessMiddleware, {
  getMethodAwareModes,
} from "../../../../middlewares/workAccess.middleware.js";

import {
  getCatalogUomMasters,
  getCatalogUomMasterById,
} from "../controllers/catalogUomMaster.controller.js";

import {
  getCatalogUomMastersQuerySchema,
  catalogUomMasterIdParamSchema,
} from "../validations/catalogUomMaster.validation.js";

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
// GET /catalog/uom-master
// ---------------------
router.get(
  "/",
  validate(getCatalogUomMastersQuerySchema, "query"),
  getCatalogUomMasters,
);

// ---------------------
// GET /catalog/uom-master/:uomId
// ---------------------
router.get(
  "/:uomId",
  validate(catalogUomMasterIdParamSchema, "params"),
  getCatalogUomMasterById,
);

export default router;
