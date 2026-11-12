import { Router } from "express";

import validate from "../../../../middlewares/validate.middleware.js";
import authMiddleware from "../../../../middlewares/auth.middleware.js";

import {
  enableProduct,
  getEnabledProducts,
  getEnabledProductById,
  updateProduct,
  disableProduct,
} from "../controllers/marketplaceProduct.controller.js";

import {
  enableProductSchema,
  updateProductSchema,
  productIdParamSchema,
  listProductsQuerySchema,
} from "../validations/marketplaceProduct.validation.js";

import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";

const router = Router();

router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch" }));

router.get("/", validate(listProductsQuerySchema, "query"), getEnabledProducts);

router.post("/", validate(enableProductSchema), enableProduct);

router.get(
  "/:productId",
  validate(productIdParamSchema, "params"),
  getEnabledProductById,
);

router.patch(
  "/:productId",
  validate(productIdParamSchema, "params"),
  validate(updateProductSchema),
  updateProduct,
);

router.delete(
  "/:productId",
  validate(productIdParamSchema, "params"),
  disableProduct,
);

export default router;
