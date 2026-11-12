import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import {
  getTrialBalance,
  getGeneralLedger,
  getCustomerLedger,
  getSupplierLedger,
  getCashBook,
  getBankBook,
  getProfitLoss,
  getBalanceSheet,
  getGstReport,
} from "../controllers/reports.controller.js";

import {
  trialBalanceQuerySchema,
  generalLedgerQuerySchema,
  customerLedgerQuerySchema,
  supplierLedgerQuerySchema,
  cashBookQuerySchema,
  bankBookQuerySchema,
  profitLossQuerySchema,
  balanceSheetQuerySchema,
  gstReportQuerySchema,
} from "../validations/reports.validation.js";

const router = Router();

// Middleware chain for all report endpoints
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company", readModes: ["view"] }));

// ── Trial Balance ──────────────────────────────────────────────
router.get(
  "/trial-balance",
  validate(trialBalanceQuerySchema, "query"),
  getTrialBalance
);

// ── General Ledger ─────────────────────────────────────────────
router.get(
  "/general-ledger",
  validate(generalLedgerQuerySchema, "query"),
  getGeneralLedger
);

// ── Customer Ledger ────────────────────────────────────────────
router.get(
  "/customer-ledger",
  validate(customerLedgerQuerySchema, "query"),
  getCustomerLedger
);

// ── Supplier Ledger ────────────────────────────────────────────
router.get(
  "/supplier-ledger",
  validate(supplierLedgerQuerySchema, "query"),
  getSupplierLedger
);

// ── Cash Book ──────────────────────────────────────────────────
router.get(
  "/cash-book",
  validate(cashBookQuerySchema, "query"),
  getCashBook
);

// ── Bank Book ──────────────────────────────────────────────────
router.get(
  "/bank-book",
  validate(bankBookQuerySchema, "query"),
  getBankBook
);

// ── Profit & Loss ──────────────────────────────────────────────
router.get(
  "/profit-loss",
  validate(profitLossQuerySchema, "query"),
  getProfitLoss
);

// ── Balance Sheet ──────────────────────────────────────────────
router.get(
  "/balance-sheet",
  validate(balanceSheetQuerySchema, "query"),
  getBalanceSheet
);

// ── GST Report ─────────────────────────────────────────────────
router.get(
  "/gst-report",
  validate(gstReportQuerySchema, "query"),
  getGstReport
);

export default router;
