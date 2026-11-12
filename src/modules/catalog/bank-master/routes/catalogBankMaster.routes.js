import { Router } from "express";

import validate from "../../../../middlewares/validate.middleware.js";
import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import workAccessMiddleware, {
  getMethodAwareModes,
} from "../../../../middlewares/workAccess.middleware.js";

import {
  getCatalogBankMasters,
  getCatalogBankMasterById,
  getCatalogBankMasterByName,
} from "../controllers/catalogBankMaster.controller.js";

import {
  getCatalogBankMastersQuerySchema,
  catalogBankMasterIdParamSchema,
  catalogBankMasterNameParamSchema,
} from "../validations/catalogBankMaster.validation.js";

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
// GET /catalog/bank-master
// ---------------------
router.get(
  "/",
  validate(getCatalogBankMastersQuerySchema, "query"),
  getCatalogBankMasters,
);

// ---------------------
// GET /catalog/bank-master/name/:name
// ---------------------
router.get(
  "/name/:name",
  validate(catalogBankMasterNameParamSchema, "params"),
  getCatalogBankMasterByName,
);

// ---------------------
// GET /catalog/bank-master/:bankId
// ---------------------
router.get(
  "/:bankId",
  validate(catalogBankMasterIdParamSchema, "params"),
  getCatalogBankMasterById,
);

export default router;
