import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import {
  createMarketplaceStore,
  getMarketplaceStores,
  getMarketplaceStoreById,
  updateMarketplaceStore,
  goOnline,
  goOffline,
  pauseStore,
  resumeStore,
  deleteMarketplaceStore,
} from "../controllers/marketplaceStore.controller.js";

import {
  createMarketplaceStoreSchema,
  updateMarketplaceStoreSchema,
  marketplaceStoreIdParamSchema,
} from "../validations/marketplaceStore.validation.js";

const router = Router();

router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch" }));

router.get("/", getMarketplaceStores);

router.post(
  "/",
  validate(createMarketplaceStoreSchema),
  createMarketplaceStore,
);

router.get(
  "/:storeId",
  validate(marketplaceStoreIdParamSchema, "params"),
  getMarketplaceStoreById,
);

router.patch(
  "/:storeId",
  validate(marketplaceStoreIdParamSchema, "params"),
  validate(updateMarketplaceStoreSchema),
  updateMarketplaceStore,
);

router.delete(
  "/:storeId",
  validate(marketplaceStoreIdParamSchema, "params"),
  deleteMarketplaceStore,
);

router.patch(
  "/:storeId/go-online",
  validate(marketplaceStoreIdParamSchema, "params"),
  goOnline,
);

router.patch(
  "/:storeId/go-offline",
  validate(marketplaceStoreIdParamSchema, "params"),
  goOffline,
);

router.patch(
  "/:storeId/pause",
  validate(marketplaceStoreIdParamSchema, "params"),
  pauseStore,
);

router.patch(
  "/:storeId/resume",
  validate(marketplaceStoreIdParamSchema, "params"),
  resumeStore,
);

export default router;
