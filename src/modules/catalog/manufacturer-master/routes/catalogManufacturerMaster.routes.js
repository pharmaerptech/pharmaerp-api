import { Router } from "express";

import validate from "../../../../middlewares/validate.middleware.js";
import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import workAccessMiddleware, {
  getMethodAwareModes,
} from "../../../../middlewares/workAccess.middleware.js";

import {
  getCatalogManufacturerMasters,
  getCatalogManufacturerMasterById,
  getCatalogManufacturerMasterByName,
} from "../controllers/catalogManufacturerMaster.controller.js";

import {
  getCatalogManufacturerMastersQuerySchema,
  catalogManufacturerMasterIdParamSchema,
  catalogManufacturerMasterNameParamSchema,
} from "../validations/catalogManufacturerMaster.validation.js";

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
// GET /catalog/manufacturer-master
// ---------------------
router.get(
  "/",
  validate(getCatalogManufacturerMastersQuerySchema, "query"),
  getCatalogManufacturerMasters,
);

// ---------------------
// GET /catalog/manufacturer-master/name/:name
// ---------------------
router.get(
  "/name/:name",
  validate(catalogManufacturerMasterNameParamSchema, "params"),
  getCatalogManufacturerMasterByName,
);

// ---------------------
// GET /catalog/manufacturer-master/:manufacturerId
// ---------------------
router.get(
  "/:manufacturerId",
  validate(catalogManufacturerMasterIdParamSchema, "params"),
  getCatalogManufacturerMasterById,
);

export default router;
