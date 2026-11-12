import { Router } from "express";
import authMiddleware from "../../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../../middlewares/validate.middleware.js";

import {
  createFundTransfer,
  getFundTransfers,
  getFundTransferById,
  cancelFundTransfer,
} from "../controllers/fundTransfer.controller.js";

import {
  createFundTransferSchema,
  cancelFundTransferSchema,
  fundTransferIdParamSchema,
  getFundTransfersQuerySchema,
} from "../validations/fundTransfer.validation.js";

const router = Router();

// Middleware chain
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

// Routes
router.post("/", validate(createFundTransferSchema), createFundTransfer);
router.get("/", validate(getFundTransfersQuerySchema, "query"), getFundTransfers);

router.get(
  "/:fundTransferId",
  validate(fundTransferIdParamSchema, "params"),
  getFundTransferById,
);

router.post(
  "/:fundTransferId/cancel",
  validate(fundTransferIdParamSchema, "params"),
  validate(cancelFundTransferSchema),
  cancelFundTransfer,
);

export default router;
