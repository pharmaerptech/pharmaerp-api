import { Router } from "express";
import authMiddleware from "../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../middlewares/companyContext.middleware.js";
import { requireMethodWorkAccess } from "../../../middlewares/workAccess.middleware.js";
import validate from "../../../middlewares/validate.middleware.js";

import {
  getDailySalesReport,
  getSalesDetailReport,
  getCustomerSalesReport,
  getProductSalesReport,
  getSalesReturnReport,
  getPurchaseSummaryReport,
  getPurchaseDetailReport,
  getSupplierPurchaseReport,
  getPurchaseReturnReport,
  getPurchaseGrnReport,
  getNearExpiryReport,
  getLowStockReorderReport,
  getStockValuationReport,
  getCustomerOutstandingReport,
  getSupplierPayablesReport,
  getPurchaseRegisterReport,
  getDoctorReferralReport,
  getScheduleHRegisterReport,
  getUpiSettlementReport,
  getCashRegisterTallyReport,
} from "../controllers/pharmacyReports.controller.js";

import { reportQuerySchema } from "../validations/pharmacyReports.validation.js";

const router = Router();

// Middleware chain for all reports
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "branch", readModes: ["view"] }));

// 1. Sales Reports Suite
router.get("/sales/summary", validate(reportQuerySchema, "query"), getDailySalesReport);
router.get("/sales/detail", validate(reportQuerySchema, "query"), getSalesDetailReport);
router.get("/sales/customer", validate(reportQuerySchema, "query"), getCustomerSalesReport);
router.get("/sales/product", validate(reportQuerySchema, "query"), getProductSalesReport);
router.get("/sales/return", validate(reportQuerySchema, "query"), getSalesReturnReport);

// 2. Purchase Reports Suite
router.get("/purchase/summary", validate(reportQuerySchema, "query"), getPurchaseSummaryReport);
router.get("/purchase/detail", validate(reportQuerySchema, "query"), getPurchaseDetailReport);
router.get("/purchase/supplier", validate(reportQuerySchema, "query"), getSupplierPurchaseReport);
router.get("/purchase/return", validate(reportQuerySchema, "query"), getPurchaseReturnReport);
router.get("/purchase/grn", validate(reportQuerySchema, "query"), getPurchaseGrnReport);

// Backward-compatibility alias
router.get("/daily-sales", validate(reportQuerySchema, "query"), getDailySalesReport);

// 2. Near-Expiry Medicines
router.get("/near-expiry", validate(reportQuerySchema, "query"), getNearExpiryReport);

// 3. Low Stock & Reorder Register
router.get("/low-stock-reorder", validate(reportQuerySchema, "query"), getLowStockReorderReport);

// 4. Stock Valuation (QOH Matrix)
router.get("/stock-valuation", validate(reportQuerySchema, "query"), getStockValuationReport);

// 5. Customer Outstanding & Credit Aging
router.get("/customer-outstanding", validate(reportQuerySchema, "query"), getCustomerOutstandingReport);

// 6. Supplier Payables & Due Dates
router.get("/supplier-payables", validate(reportQuerySchema, "query"), getSupplierPayablesReport);

// 7. Purchase Bill Register (GRN)
router.get("/purchase-register", validate(reportQuerySchema, "query"), getPurchaseRegisterReport);

// 8. Doctor Prescription Analytics
router.get("/doctor-referral", validate(reportQuerySchema, "query"), getDoctorReferralReport);

// 9. Schedule H / H1 / Narcotic Register
router.get("/schedule-h-register", validate(reportQuerySchema, "query"), getScheduleHRegisterReport);

// 10. UPI & QR Settlement
router.get("/upi-settlement", validate(reportQuerySchema, "query"), getUpiSettlementReport);

// 11. Daily Cash Register Tally
router.get("/cash-register-tally", validate(reportQuerySchema, "query"), getCashRegisterTallyReport);

export default router;
