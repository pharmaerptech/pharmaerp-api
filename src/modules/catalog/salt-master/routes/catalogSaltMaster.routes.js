import { Router } from "express";

import validate from "../../../../middlewares/validate.middleware.js";
import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import workAccessMiddleware, {
  getMethodAwareModes,
} from "../../../../middlewares/workAccess.middleware.js";

import {
  getCatalogSaltMasters,
  getCatalogSaltMasterById,
  getCatalogSaltMasterByName,
} from "../controllers/catalogSaltMaster.controller.js";

import {
  getCatalogSaltMastersQuerySchema,
  catalogSaltMasterIdParamSchema,
  catalogSaltMasterNameParamSchema,
} from "../validations/catalogSaltMaster.validation.js";

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
// GET /catalog/salt-master
// ---------------------
router.get(
  "/",
  validate(getCatalogSaltMastersQuerySchema, "query"),
  getCatalogSaltMasters,
);

// ---------------------
// GET /catalog/salt-master/name/:name
// ---------------------
router.get(
  "/name/:name",
  validate(catalogSaltMasterNameParamSchema, "params"),
  getCatalogSaltMasterByName,
);

// ---------------------
// GET /catalog/salt-master/:saltId
// ---------------------
router.get(
  "/:saltId",
  validate(catalogSaltMasterIdParamSchema, "params"),
  getCatalogSaltMasterById,
);

export default router;
