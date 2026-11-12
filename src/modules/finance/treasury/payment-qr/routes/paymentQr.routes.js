import { Router } from "express";
import authMiddleware from "../../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../../middlewares/validate.middleware.js";

import {
  createPaymentQr,
  getPaymentQrs,
  getPaymentQrById,
  updatePaymentQr,
  deletePaymentQr,
  setPrimary,
  getStats,
  getUpiTransactions,
} from "../controllers/paymentQr.controller.js";

import {
  createPaymentQrSchema,
  updatePaymentQrSchema,
  paymentQrIdParamSchema,
  getPaymentQrsQuerySchema,
  getUpiTransactionsQuerySchema,
} from "../validations/paymentQr.validation.js";

const router = Router();

// Middleware chain
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch" }));

// Routes
router.post("/", validate(createPaymentQrSchema), createPaymentQr);
router.get("/", validate(getPaymentQrsQuerySchema, "query"), getPaymentQrs);

// Multi-source UPI reconciliation transactions endpoint
router.get(
  "/transactions",
  validate(getUpiTransactionsQuerySchema, "query"),
  getUpiTransactions,
);

router.get(
  "/:paymentQrId",
  validate(paymentQrIdParamSchema, "params"),
  getPaymentQrById,
);


router.patch(
  "/:paymentQrId",
  validate(paymentQrIdParamSchema, "params"),
  validate(updatePaymentQrSchema),
  updatePaymentQr,
);

router.delete(
  "/:paymentQrId",
  validate(paymentQrIdParamSchema, "params"),
  deletePaymentQr,
);

router.post(
  "/:paymentQrId/set-primary",
  validate(paymentQrIdParamSchema, "params"),
  setPrimary,
);

// GET stats for a specific Payment QR (per-UPI transaction breakdown)
router.get(
  "/:paymentQrId/stats",
  validate(paymentQrIdParamSchema, "params"),
  getStats,
);

export default router;
