import { Router } from "express";
import authMiddleware from "../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../middlewares/companyContext.middleware.js";
import validate from "../../../middlewares/validate.middleware.js";

import {
  getDailySalesReport,
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

// 1. Daily Sales & Payment Split
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
