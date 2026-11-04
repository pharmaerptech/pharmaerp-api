import mongoose from "mongoose";
import { pharmacyReportsService } from "../src/modules/reports/services/pharmacyReports.service.js";

async function verify() {
  await mongoose.connect("mongodb+srv://dev:dev%401234@erp-cluster.tqgbpyi.mongodb.net/erp?retryWrites=true&w=majority");
  console.log("Connected to MongoDB for Purchase Reports Verification");

  const workspaceId = "6ab77b681fba63d384f9542d";
  const companyId = "6ab7830e1fba63d384f95439";
  const startDate = "2026-09-01";
  const endDate = "2026-11-05";

  console.log("\n========================================================");
  console.log("TEST 1: getPurchaseSummaryReport");
  console.log("========================================================");
  const summaryRes = await pharmacyReportsService.getPurchaseSummaryReport({
    workspaceId,
    companyId,
    startDate,
    endDate,
    page: 1,
    limit: 5,
  });
  console.log("Summary Stats:", summaryRes.summary);
  console.log("Chart Title:", summaryRes.chart.title);
  console.log("Chart Data Points:", summaryRes.chart.data.length);
  console.log("Total Count:", summaryRes.total);
  console.log("Rows Sample (First Row):", summaryRes.rows[0]);

  if (summaryRes.total > 0 && summaryRes.summary.totalPurchases > 0 && summaryRes.rows.length > 0) {
    console.log(">>> TEST 1 PASSED: Purchase Summary returned valid live data!");
  } else {
    throw new Error("TEST 1 FAILED: Invalid summary result");
  }

  console.log("\n========================================================");
  console.log("TEST 2: getPurchaseDetailReport");
  console.log("========================================================");
  const detailRes = await pharmacyReportsService.getPurchaseDetailReport({
    workspaceId,
    companyId,
    startDate,
    endDate,
    page: 1,
    limit: 5,
  });
  console.log("Detail Stats:", detailRes.summary);
  console.log("Chart Title:", detailRes.chart.title);
  console.log("Chart Data Points:", detailRes.chart.data.length);
  console.log("Total Count:", detailRes.total);
  console.log("Detail Rows Sample (First Row):", detailRes.rows[0]);

  if (detailRes.total > 0 && detailRes.summary.totalLineItems > 0 && detailRes.rows.length > 0) {
    console.log(">>> TEST 2 PASSED: Purchase Detail returned unwound item records!");
  } else {
    throw new Error("TEST 2 FAILED: Invalid detail result");
  }

  console.log("\n========================================================");
  console.log("TEST 3: getSupplierPurchaseReport");
  console.log("========================================================");
  const supplierRes = await pharmacyReportsService.getSupplierPurchaseReport({
    workspaceId,
    companyId,
    startDate,
    endDate,
    page: 1,
    limit: 5,
  });
  console.log("Supplier Stats:", supplierRes.summary);
  console.log("Chart Title:", supplierRes.chart.title);
  console.log("Total Suppliers:", supplierRes.total);
  console.log("Supplier Rows Sample (First Row):", supplierRes.rows[0]);

  if (supplierRes.total > 0 && supplierRes.summary.activeSuppliers > 0 && supplierRes.rows.length > 0) {
    console.log(">>> TEST 3 PASSED: Supplier Purchase returned grouped supplier aggregations!");
  } else {
    throw new Error("TEST 3 FAILED: Invalid supplier result");
  }

  console.log("\n========================================================");
  console.log("TEST 4: getPurchaseReturnReport");
  console.log("========================================================");
  const returnRes = await pharmacyReportsService.getPurchaseReturnReport({
    workspaceId,
    companyId,
    startDate,
    endDate,
    page: 1,
    limit: 5,
  });
  console.log("Return Stats:", returnRes.summary);
  console.log("Return Total:", returnRes.total);
  console.log(">>> TEST 4 PASSED: Purchase Return handled gracefully without errors!");

  console.log("\n========================================================");
  console.log("TEST 5: getPurchaseGrnReport");
  console.log("========================================================");
  const grnRes = await pharmacyReportsService.getPurchaseGrnReport({
    workspaceId,
    companyId,
    startDate,
    endDate,
    page: 1,
    limit: 5,
  });
  console.log("GRN Stats:", grnRes.summary);
  console.log("Chart Title:", grnRes.chart.title);
  console.log("Total GRNs:", grnRes.total);
  console.log("GRN Rows Sample (First Row):", grnRes.rows[0]);

  if (grnRes.total > 0 && grnRes.summary.totalInwards > 0 && grnRes.rows.length > 0) {
    console.log(">>> TEST 5 PASSED: Purchase GRN Inward log returned live verification records!");
  } else {
    throw new Error("TEST 5 FAILED: Invalid GRN result");
  }

  console.log("\n========================================================");
  console.log("TEST 6: Search Filter Check");
  console.log("========================================================");
  const searchRes = await pharmacyReportsService.getPurchaseSummaryReport({
    workspaceId,
    companyId,
    startDate,
    endDate,
    search: "PB828681",
    page: 1,
    limit: 5,
  });
  console.log("Search 'PB828681' count:", searchRes.total);
  console.log("Found Bill No:", searchRes.rows[0]?.billNo);
  if (searchRes.total > 0 && searchRes.rows[0]?.billNo.includes("PB828681")) {
    console.log(">>> TEST 6 PASSED: Search query matched purchase bill correctly!");
  } else {
    throw new Error("TEST 6 FAILED: Search filter failed");
  }

  console.log("\n========================================================");
  console.log("ALL 6 TESTS PASSED SUCCESSFULLY! Real Purchase Data Verified!");
  console.log("========================================================");

  process.exit(0);
}

verify().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});

