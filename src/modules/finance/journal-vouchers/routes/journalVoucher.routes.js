import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import {
  createVoucher,
  getVouchers,
  getVoucherById,
  updateVoucher,
  postVoucher,
  cancelVoucher,
  submitApproval,
  approveVoucher,
  reverseVoucher,
} from "../controllers/journalVoucher.controller.js";

import {
  createVoucherSchema,
  updateVoucherSchema,
  voucherIdParamSchema,
  getVouchersQuerySchema,
} from "../validations/journalVoucher.validation.js";

const router = Router();

// Middleware chain for all endpoints
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

// Routes
router.post("/", validate(createVoucherSchema), createVoucher);
router.get("/", validate(getVouchersQuerySchema, "query"), getVouchers);

router.get(
  "/:voucherId",
  validate(voucherIdParamSchema, "params"),
  getVoucherById,
);

router.patch(
  "/:voucherId",
  validate(voucherIdParamSchema, "params"),
  validate(updateVoucherSchema),
  updateVoucher,
);

router.post(
  "/:voucherId/post",
  validate(voucherIdParamSchema, "params"),
  postVoucher,
);

router.post(
  "/:voucherId/cancel",
  validate(voucherIdParamSchema, "params"),
  cancelVoucher,
);

router.post(
  "/:voucherId/submit-approval",
  validate(voucherIdParamSchema, "params"),
  submitApproval,
);

router.post(
  "/:voucherId/approve",
  validate(voucherIdParamSchema, "params"),
  approveVoucher,
);

router.post(
  "/:voucherId/reverse",
  validate(voucherIdParamSchema, "params"),
  reverseVoucher,
);

export default router;
