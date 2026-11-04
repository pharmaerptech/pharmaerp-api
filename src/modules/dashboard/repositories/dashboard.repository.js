import mongoose from "mongoose";
import SalesInvoice from "../../sales/invoices/models/invoice.model.js";
import WorkspaceProduct from "../../catalog/products/models/workspaceProduct.model.js";
import Batch from "../../catalog/products/models/batch.model.js";
import ProductFacility from "../../catalog/products/models/productFacility.model.js";
import PurchaseBill from "../../catalog/purchase-bills/models/purchaseBill.model.js";
import { Shift } from "../../operations/shifts/shift.model.js";
import Customer from "../../parties/customers/models/customer.model.js";
import Supplier from "../../parties/suppliers/models/supplier.model.js";
import Branch from "../../organization/branches/models/branch.model.js";
import Company from "../../organization/companies/models/company.model.js";
import Workspace from "../../organization/workspaces/models/workspace.model.js";
import WorkspaceMember from "../../organization/workspaces/models/workspaceMember.model.js";
import Subscription from "../../subscription/subscriptions/models/subscription.model.js";
import BranchCashBalance from "../../finance/treasury/cash-management/branch-cash/models/branchCashBalance.model.js";
import AccountBalance from "../../finance/account-balances/models/accountBalance.model.js";
import { BusinessDay } from "../../operations/business-days/businessDay.model.js";
import TransferOrder from "../../transfer-order/models/transferOrder.model.js";
import Role from "../../core/access-control/models/role.model.js";
import User from "../../core/users/models/user.model.js";
import BankAccount from "../../finance/treasury/bank-management/bank-accounts/models/bankAccount.model.js";
import Account from "../../finance/chart-of-accounts/models/account.model.js";
import BankMaster from "../../platform/global-catalog/bank-master/models/bankMaster.model.js";
import GstLedger from "../../finance/gst-ledger/models/gstLedger.model.js";

/**
 * Parse an expiry string like "MM/YY", "MM/YYYY", "YYYY-MM", or "YYYY-MM-DD"
 * into a Date object representing the last millisecond of that expiry month/day.
 */
const parseExpiryDate = (str) => {
  if (!str || typeof str !== "string") return null;
  const trimmed = str.trim();

  // Pattern MM/YY or MM/YYYY
  if (trimmed.includes("/")) {
    const parts = trimmed.split("/");
    if (parts.length === 2) {
      const month = parseInt(parts[0], 10);
      let year = parseInt(parts[1], 10);
      if (year < 100) year += 2000;
      if (month >= 1 && month <= 12) {
        // Expiry is end of that month
        return new Date(year, month, 0, 23, 59, 59, 999);
      }
    }
  }

  // Pattern YYYY-MM or YYYY-MM-DD
  if (trimmed.includes("-")) {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
      return d;
    }
  }

  return null;
};

const getDashboardOverview = async ({ workspaceId, companyId, branchId = null }) => {
  const wsObjectId = new mongoose.Types.ObjectId(workspaceId);
  const compObjectId = new mongoose.Types.ObjectId(companyId);
  const branchObjectId = branchId && mongoose.Types.ObjectId.isValid(branchId) ? new mongoose.Types.ObjectId(branchId) : null;

  // Base scope filters
  const invoiceBaseFilter = {
    workspaceId: wsObjectId,
    companyId: compObjectId,
    isDeleted: false,
  };
  if (branchObjectId) {
    invoiceBaseFilter.branchId = branchObjectId;
  }

  const purchaseBillBaseFilter = {
    workspaceId: wsObjectId,
    companyId: compObjectId,
    isDeleted: false,
  };

  const batchBaseFilter = {
    workspaceId: wsObjectId,
    isDeleted: false,
  };

  const productFacilityBaseFilter = {
    workspaceId: wsObjectId,
    isDeleted: false,
  };
  if (branchObjectId) {
    productFacilityBaseFilter.facility_id = branchObjectId;
  }

  // Time boundaries
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1, 0, 0, 0, 0);

  // 1. Sales Aggregations (Today, This Month, Last Month, All Time)
  const salesAggPromise = SalesInvoice.aggregate([
    { $match: invoiceBaseFilter },
    {
      $facet: {
        today: [
          { $match: { date: { $gte: startOfToday, $lte: endOfToday } } },
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$grandTotal" },
              count: { $sum: 1 },
              tax: { $sum: "$tax" },
            },
          },
        ],
        thisMonth: [
          { $match: { date: { $gte: startOfMonth } } },
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$grandTotal" },
              count: { $sum: 1 },
              tax: { $sum: "$tax" },
            },
          },
        ],
        lastMonth: [
          { $match: { date: { $gte: startOfLastMonth, $lte: endOfLastMonth } } },
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$grandTotal" },
              count: { $sum: 1 },
            },
          },
        ],
        allTime: [
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$grandTotal" },
              count: { $sum: 1 },
            },
          },
        ],
        monthlyHistory: [
          { $match: { date: { $gte: sixMonthsAgo } } },
          {
            $group: {
              _id: {
                year: { $year: "$date" },
                month: { $month: "$date" },
              },
              revenue: { $sum: "$grandTotal" },
              tax: { $sum: "$tax" },
              invoicesCount: { $sum: 1 },
            },
          },
        ],
      },
    },
  ]);

  // 2. Purchase Bills Aggregation (Monthly Expenses)
  const purchasesAggPromise = PurchaseBill.aggregate([
    { $match: purchaseBillBaseFilter },
    {
      $facet: {
        thisMonth: [
          { $match: { createdAt: { $gte: startOfMonth } } },
          {
            $group: {
              _id: null,
              totalExpenses: { $sum: "$grandTotal" },
              count: { $sum: 1 },
            },
          },
        ],
        allTime: [
          {
            $group: {
              _id: null,
              totalExpenses: { $sum: "$grandTotal" },
              count: { $sum: 1 },
            },
          },
        ],
        monthlyHistory: [
          { $match: { createdAt: { $gte: sixMonthsAgo } } },
          {
            $group: {
              _id: {
                year: { $year: "$createdAt" },
                month: { $month: "$createdAt" },
              },
              expenses: { $sum: "$grandTotal" },
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ]);

  // 3. Inventory Stock & Batches
  const activeProductsCountPromise = WorkspaceProduct.countDocuments({
    workspaceId: wsObjectId,
    isDeleted: false,
    status: { $regex: /^active$/i },
  });

  const batchesPromise = Batch.find(batchBaseFilter)
    .populate("product", "name workspaceProductCode productType category")
    .sort({ createdAt: -1 })
    .lean();

  // 4. Products Distribution by Category / Product Type
  const categoryDistributionPromise = WorkspaceProduct.aggregate([
    { $match: { workspaceId: wsObjectId, isDeleted: false, status: { $regex: /^active$/i } } },
    {
      $lookup: {
        from: "categorymasters",
        localField: "category",
        foreignField: "_id",
        as: "categoryDoc",
      },
    },
    {
      $project: {
        categoryName: {
          $ifNull: [
            { $arrayElemAt: ["$categoryDoc.name", 0] },
            { $toUpper: "$productType" },
          ],
        },
      },
    },
    {
      $group: {
        _id: "$categoryName",
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
  ]);

  // 5. Recent 5 Sales Invoices
  const recentInvoicesPromise = SalesInvoice.find(invoiceBaseFilter)
    .populate("customerId", "name mobile")
    .sort({ date: -1 })
    .limit(5)
    .lean();

  // 6. Recent 5 Purchase Bills
  const recentPurchasesPromise = PurchaseBill.find(purchaseBillBaseFilter)
    .populate("supplierId", "businessName")
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  // 7. Active Shift status (if branch provided)
  const activeShiftPromise = branchObjectId
    ? Shift.findOne({ branchId: branchObjectId, status: "OPEN" }).lean()
    : null;

  // Execute all concurrent queries
  const [
    salesAggResult,
    purchasesAggResult,
    totalActiveProducts,
    allBatches,
    categoryDistResult,
    recentInvoices,
    recentPurchases,
    activeShift,
  ] = await Promise.all([
    salesAggPromise,
    purchasesAggPromise,
    activeProductsCountPromise,
    batchesPromise,
    categoryDistributionPromise,
    recentInvoicesPromise,
    recentPurchasesPromise,
    activeShiftPromise,
  ]);

  // Process Sales Facet Data
  const salesFacets = salesAggResult[0] || {};
  const todaySales = salesFacets.today?.[0] || { totalAmount: 0, count: 0, tax: 0 };
  const thisMonthSales = salesFacets.thisMonth?.[0] || { totalAmount: 0, count: 0, tax: 0 };
  const lastMonthSales = salesFacets.lastMonth?.[0] || { totalAmount: 0, count: 0 };
  const allTimeSales = salesFacets.allTime?.[0] || { totalAmount: 0, count: 0 };
  const monthlySalesHistory = salesFacets.monthlyHistory || [];

  // Process Purchases Facet Data
  const purchaseFacets = purchasesAggResult[0] || {};
  const thisMonthPurchases = purchaseFacets.thisMonth?.[0] || { totalExpenses: 0, count: 0 };
  const allTimePurchases = purchaseFacets.allTime?.[0] || { totalExpenses: 0, count: 0 };
  const monthlyPurchasesHistory = purchaseFacets.monthlyHistory || [];

  // Month-over-month revenue trend calculation
  let revenueTrendPercent = 0;
  if (lastMonthSales.totalAmount > 0) {
    revenueTrendPercent = Number(
      (((thisMonthSales.totalAmount - lastMonthSales.totalAmount) / lastMonthSales.totalAmount) * 100).toFixed(1)
    );
  }

  // Process Batches for:
  // - Total Units in Stock
  // - Low Stock Batches (qty <= 10)
  // - Expiring Soon Batches (expiry <= 30 days from now)
  let totalStockUnits = 0;
  const lowStockList = [];
  const expiringSoonList = [];

  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  for (const b of allBatches) {
    const qty = Number(b.batchQty || 0);
    totalStockUnits += qty;

    const productName = b.product?.name || "Product";
    const productSku = b.product?.workspaceProductCode || "SKU";
    const productType = b.product?.productType || "Medicine";

    // Low stock check
    if (qty <= 10) {
      lowStockList.push({
        id: b._id.toString(),
        productId: b.product?._id?.toString(),
        name: productName,
        sku: productSku,
        form: productType,
        batch: b.batchNo,
        remaining: qty,
      });
    }

    // Expiry check
    const expDate = parseExpiryDate(b.expiryDate);
    if (expDate) {
      const diffMs = expDate.getTime() - now.getTime();
      const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      if (daysLeft <= 30) {
        expiringSoonList.push({
          id: b._id.toString(),
          productId: b.product?._id?.toString(),
          name: productName,
          sku: productSku,
          batch: b.batchNo,
          daysLeft: daysLeft < 0 ? 0 : daysLeft,
          isExpired: daysLeft <= 0,
          rawExpiry: b.expiryDate,
          count: qty,
        });
      }
    }
  }

  // Sort expiring soon by urgency
  expiringSoonList.sort((a, b) => a.daysLeft - b.daysLeft);
  lowStockList.sort((a, b) => a.remaining - b.remaining);

  // Build unified 6-Month Points Array
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const chartPoints = [];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1; // 1-12
    const mLabel = monthNames[d.getMonth()];

    const salesMatch = monthlySalesHistory.find(
      (item) => item._id.year === y && item._id.month === m
    );
    const purchaseMatch = monthlyPurchasesHistory.find(
      (item) => item._id.year === y && item._id.month === m
    );

    const rev = salesMatch ? Math.round(salesMatch.revenue) : 0;
    const exp = purchaseMatch ? Math.round(purchaseMatch.expenses) : 0;
    const profit = rev - exp;
    const invCount = salesMatch ? salesMatch.invoicesCount : 0;

    chartPoints.push({
      month: mLabel,
      year: y,
      revenue: rev,
      expenses: exp,
      profit: profit > 0 ? profit : 0,
      invoices: invCount,
    });
  }

  // Category Distribution formatting
  const colorVars = [
    "var(--app-color-primary)",
    "var(--app-color-success)",
    "var(--app-color-warning)",
    "var(--app-color-info)",
    "var(--app-color-error)",
  ];
  const bgClasses = [
    "bg-primary",
    "bg-success",
    "bg-warning",
    "bg-info",
    "bg-error",
  ];

  const totalCategorized = categoryDistResult.reduce((sum, item) => sum + item.count, 0);
  const categoriesFormatted = categoryDistResult.slice(0, 5).map((item, idx) => ({
    name: item._id || "Other",
    count: item.count,
    percentage: totalCategorized > 0 ? Math.round((item.count / totalCategorized) * 100) : 0,
    colorVar: colorVars[idx % colorVars.length],
    bgClass: bgClasses[idx % bgClasses.length],
  }));

  // Build Live Operational Alerts (Deterministic Real Data)
  const liveAlerts = [];
  if (lowStockList.length > 0) {
    liveAlerts.push({
      id: "alert-low-stock",
      text: `${lowStockList.length} medicine batch${lowStockList.length > 1 ? "es" : ""} running critically low on stock (<= 10 units).`,
      intent: "warning",
      iconName: "Package",
    });
  }
  if (expiringSoonList.length > 0) {
    liveAlerts.push({
      id: "alert-expiring",
      text: `${expiringSoonList.length} batch${expiringSoonList.length > 1 ? "es" : ""} expiring within the next 30 days.`,
      intent: "error",
      iconName: "CalendarDays",
    });
  }
  if (todaySales.count > 0) {
    liveAlerts.push({
      id: "alert-today-sales",
      text: `Today's revenue reached ₹${todaySales.totalAmount.toLocaleString()} across ${todaySales.count} completed transaction${todaySales.count > 1 ? "s" : ""}.`,
      intent: "success",
      iconName: "TrendingUp",
    });
  } else if (allTimeSales.count > 0) {
    liveAlerts.push({
      id: "alert-total-sales",
      text: `Total sales recorded: ₹${allTimeSales.totalAmount.toLocaleString()} across ${allTimeSales.count} completed transaction${allTimeSales.count > 1 ? "s" : ""}.`,
      intent: "success",
      iconName: "TrendingUp",
    });
  } else {
    liveAlerts.push({
      id: "alert-no-sales",
      text: "No sales recorded yet. Billing terminal is open and ready.",
      intent: "primary",
      iconName: "ShoppingCart",
    });
  }

  if (allTimePurchases.count > 0) {
    liveAlerts.push({
      id: "alert-purchases",
      text: `Total purchases: ₹${allTimePurchases.totalExpenses.toLocaleString()} recorded across ${allTimePurchases.count} purchase bill${allTimePurchases.count > 1 ? "s" : ""}.`,
      intent: "info",
      iconName: "Package",
    });
  }

  if (activeShift) {
    liveAlerts.push({
      id: "alert-shift-open",
      text: `Cashier shift #${activeShift.shiftNo || 1} is currently active and open for transactions.`,
      intent: "info",
      iconName: "ShieldCheck",
    });
  }

  const effectiveTodaysSales = todaySales.totalAmount > 0 ? todaySales.totalAmount : (allTimeSales.totalAmount || 0);
  const effectiveTransactionsToday = todaySales.count > 0 ? todaySales.count : (allTimeSales.count || 0);

  return {
    kpis: {
      totalRevenue: allTimeSales.totalAmount || 0,
      totalInvoicesCount: allTimeSales.count || 0,
      totalPurchases: allTimePurchases.totalExpenses || 0,
      totalPurchasesCount: allTimePurchases.count || 0,
      thisMonthRevenue: (thisMonthSales.totalAmount || allTimeSales.totalAmount) || 0,
      thisMonthPurchases: (thisMonthPurchases.totalExpenses || allTimePurchases.totalExpenses) || 0,
      revenueTrendPercent,
      medicinesInStock: totalActiveProducts || 0,
      totalStockUnits: totalStockUnits || 0,
      lowStockAlertsCount: lowStockList.length,
      expiringSoonCount: expiringSoonList.length,
      todaysSalesAmount: effectiveTodaysSales,
      transactionsToday: effectiveTransactionsToday,
      taxCollectedThisMonth: (thisMonthSales.tax || allTimeSales.tax) || 0,
    },
    monthlyFinancials: {
      revenue: (thisMonthSales.totalAmount || allTimeSales.totalAmount) || 0,
      expenses: (thisMonthPurchases.totalExpenses || allTimePurchases.totalExpenses) || 0,
      profit: Math.max(
        0,
        ((thisMonthSales.totalAmount || allTimeSales.totalAmount) || 0) -
          ((thisMonthPurchases.totalExpenses || allTimePurchases.totalExpenses) || 0)
      ),
      invoicesCount: (thisMonthSales.count || allTimeSales.count) || 0,
      chartPoints,
    },
    inventoryDistribution: {
      totalProducts: totalActiveProducts,
      categories: categoriesFormatted,
    },
    lowStockItems: lowStockList.slice(0, 5),
    expiringBatches: expiringSoonList.slice(0, 5),
    recentTransactions: recentInvoices.map((inv) => ({
      id: inv._id.toString(),
      invoiceNo: inv.invoiceNo,
      customerName: inv.customerId?.name || "Walk-in Customer",
      customerMobile: inv.customerId?.mobile || null,
      amount: inv.grandTotal,
      paymentMethod: inv.paymentMethod,
      date: inv.date,
      status: inv.status,
    })),
    recentPurchaseBills: recentPurchases.map((pb) => ({
      id: pb._id.toString(),
      billNo: pb.purchaseBillNo || "PB-N/A",
      supplierName: pb.supplierId?.businessName || "Supplier",
      amount: pb.grandTotal,
      amountDue: pb.amountDue,
      status: pb.status,
      date: pb.createdAt,
    })),
    liveAlerts,
    shift: activeShift ? { isOpen: true, shiftNo: activeShift.shiftNo } : { isOpen: false },
  };
};

export const getBranchDashboardData = async ({ workspaceId, companyId, branchId = null, date = null }) => {
  const wsObjectId = workspaceId && mongoose.Types.ObjectId.isValid(workspaceId) ? new mongoose.Types.ObjectId(workspaceId) : null;
  const compObjectId = companyId && mongoose.Types.ObjectId.isValid(companyId) ? new mongoose.Types.ObjectId(companyId) : null;
  let branchObjectId = branchId && mongoose.Types.ObjectId.isValid(branchId) ? new mongoose.Types.ObjectId(branchId) : null;

  // Resolve Branch Document
  let branchDoc = null;
  if (branchObjectId) {
    branchDoc = await Branch.findOne({ _id: branchObjectId, isDeleted: false }).lean();
  }
  if (!branchDoc && compObjectId) {
    branchDoc = await Branch.findOne({ companyId: compObjectId, isDeleted: false }).lean();
    if (branchDoc) branchObjectId = branchDoc._id;
  }

  // Resolve Active Business Day
  const activeBusinessDay = branchObjectId
    ? await BusinessDay.findOne({ branchId: branchObjectId, status: { $regex: /^open$/i } }).lean()
    : null;

  // IST Date Boundaries (UTC+05:30)
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const now = date && date !== "Today" && date !== "Yesterday" ? new Date(date) : new Date();
  const nowIST = new Date(now.getTime() + IST_OFFSET_MS);

  const y = nowIST.getUTCFullYear();
  const m = nowIST.getUTCMonth();
  const d = nowIST.getUTCDate();

  const startOfToday = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endOfToday = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - IST_OFFSET_MS);

  const startOfYesterday = new Date(Date.UTC(y, m, d - 1, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endOfYesterday = new Date(Date.UTC(y, m, d - 1, 23, 59, 59, 999) - IST_OFFSET_MS);

  const todayDateStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateFormatted = `${MONTH_NAMES[m]} ${String(d).padStart(2, "0")}, ${y}`;

  // Invoice Filters
  const branchInvoiceFilter = {
    isDeleted: false,
    ...(wsObjectId ? { workspaceId: wsObjectId } : {}),
    ...(compObjectId ? { companyId: compObjectId } : {}),
    ...(branchObjectId ? { branchId: branchObjectId } : {}),
  };

  const isYesterday = date === "Yesterday";

  const todayInvoiceFilter = isYesterday
    ? {
        ...branchInvoiceFilter,
        $or: [
          { date: { $gte: startOfYesterday, $lte: endOfYesterday } },
          { createdAt: { $gte: startOfYesterday, $lte: endOfYesterday } },
        ],
      }
    : {
        ...branchInvoiceFilter,
        $or: [
          { date: { $gte: startOfToday, $lte: endOfToday } },
          { createdAt: { $gte: startOfToday, $lte: endOfToday } },
          ...(activeBusinessDay?._id ? [{ businessDayId: activeBusinessDay._id }] : []),
        ],
      };

  const yesterdayInvoiceFilter = {
    ...branchInvoiceFilter,
    $or: [
      { date: { $gte: startOfYesterday, $lte: endOfYesterday } },
      { createdAt: { $gte: startOfYesterday, $lte: endOfYesterday } },
    ],
  };

  const todayPurchasesFilter = {
    isDeleted: false,
    ...(wsObjectId ? { workspaceId: wsObjectId } : {}),
    ...(compObjectId ? { companyId: compObjectId } : {}),
    ...(branchObjectId ? { branchId: branchObjectId } : {}),
    $or: [
      { createdAt: { $gte: startOfToday, $lte: endOfToday } },
      { invoiceDate: todayDateStr },
      ...(activeBusinessDay?.actualOpenedAt ? [{ createdAt: { $gte: activeBusinessDay.actualOpenedAt } }] : []),
    ],
  };

  // Execute Parallel Aggregations
  const [
    activeShift,
    branchCashDoc,
    todaySalesAgg,
    yesterdaySalesAgg,
    hourlyAggResult,
    paymentAggResult,
    todayInvoices,
    lowStockResult,
    allBatchesResult,
    recentPurchases,
    transferOrders,
  ] = await Promise.all([
    branchObjectId ? Shift.findOne({ branchId: branchObjectId, status: { $regex: /^open$/i } }).populate("openedBy", "fullName firstName lastName").lean() : null,
    branchObjectId ? BranchCashBalance.findOne({ branchId: branchObjectId }).lean() : null,
    SalesInvoice.aggregate([
      { $match: todayInvoiceFilter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$grandTotal" },
          count: { $sum: 1 },
          itemsSold: {
            $sum: {
              $reduce: {
                input: { $ifNull: ["$items", []] },
                initialValue: 0,
                in: { $add: ["$$value", { $ifNull: ["$$this.qty", 1] }] },
              },
            },
          },
          uniqueCustomers: { $addToSet: "$customerId" },
        },
      },
    ]),
    SalesInvoice.aggregate([
      { $match: yesterdayInvoiceFilter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$grandTotal" },
          count: { $sum: 1 },
          itemsSold: {
            $sum: {
              $reduce: {
                input: { $ifNull: ["$items", []] },
                initialValue: 0,
                in: { $add: ["$$value", { $ifNull: ["$$this.qty", 1] }] },
              },
            },
          },
        },
      },
    ]),
    // Hourly Aggregation for Today
    SalesInvoice.aggregate([
      { $match: todayInvoiceFilter },
      {
        $project: {
          hour: { $hour: { date: { $ifNull: ["$date", "$createdAt"] }, timezone: "+05:30" } },
          grandTotal: 1,
        },
      },
      {
        $group: {
          _id: "$hour",
          sales: { $sum: "$grandTotal" },
          invoices: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    // Payment Mode Breakdown
    SalesInvoice.aggregate([
      { $match: todayInvoiceFilter },
      {
        $group: {
          _id: { $ifNull: ["$paymentMethod", "Cash"] },
          amount: { $sum: "$grandTotal" },
          count: { $sum: 1 },
        },
      },
      { $sort: { amount: -1 } },
    ]),
    // Recent 5 Sales Invoices
    SalesInvoice.find(todayInvoiceFilter)
      .sort({ createdAt: -1, date: -1 })
      .limit(5)
      .populate("customerId", "name mobile")
      .lean(),
    // Low Stock (total_qty_available <= 20)
    branchObjectId
      ? ProductFacility.find({
          workspaceId: wsObjectId,
          facility_id: branchObjectId,
          isDeleted: false,
          total_qty_available: { $lte: 20 },
        })
          .populate("product_id", "name workspaceProductCode productType")
          .sort({ total_qty_available: 1 })
          .limit(5)
          .lean()
      : [],
    // Batches for Near Expiry (< 30 days) and Expired
    branchObjectId
      ? Batch.find({
          workspaceId: wsObjectId,
          branch_id: branchObjectId,
          isDeleted: false,
          batchQty: { $gt: 0 },
        })
          .populate("product", "name workspaceProductCode productType")
          .lean()
      : [],
    // Recent Purchases received today
    PurchaseBill.find(todayPurchasesFilter)
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("supplierId", "businessName name")
      .lean(),
    // Inter-Branch Transfers
    branchObjectId
      ? TransferOrder.find({
          workspaceId: wsObjectId,
          isDeleted: false,
          $or: [{ sourceBranchId: branchObjectId }, { destinationBranchId: branchObjectId }],
        })
          .sort({ createdAt: -1 })
          .limit(5)
          .populate("sourceBranchId destinationBranchId", "name branchName branchCode")
          .lean()
      : [],
  ]);

  const todayStat = todaySalesAgg[0] || { totalAmount: 0, count: 0, itemsSold: 0, uniqueCustomers: [] };
  const yesterdayStat = yesterdaySalesAgg[0] || { totalAmount: 0, count: 0, itemsSold: 0 };

  const todaysSales = todayStat.totalAmount || 0;
  const yesterdaySales = yesterdayStat.totalAmount || 0;
  const salesGrowth =
    yesterdaySales > 0
      ? Math.round(((todaysSales - yesterdaySales) / yesterdaySales) * 1000) / 10
      : (todaysSales > 0 ? 100 : 0);

  const totalInvoices = todayStat.count || 0;
  const yesterdayInvoices = yesterdayStat.count || 0;
  const totalInvoicesGrowth =
    yesterdayInvoices > 0
      ? Math.round(((totalInvoices - yesterdayInvoices) / yesterdayInvoices) * 1000) / 10
      : (totalInvoices > 0 ? 100 : 0);

  const newCustomers = Array.isArray(todayStat.uniqueCustomers)
    ? todayStat.uniqueCustomers.filter(Boolean).length
    : 0;
  const itemsSold = todayStat.itemsSold || 0;
  const avgBillValue = totalInvoices > 0 ? Math.round(todaysSales / totalInvoices) : 0;

  // Format Payment Mode Breakdown (Real data)
  const totalPaymentAmount = paymentAggResult.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const colorMap = {
    CASH: "#16a34a",
    UPI: "#2563eb",
    CARD: "#f59e0b",
    CREDIT: "#dc2626",
    KHATA: "#dc2626",
    SPLIT: "#8b5cf6",
  };

  const paymentBreakdownList = paymentAggResult.map((item) => {
    const rawMode = String(item._id || "Cash").trim();
    const upperMode = rawMode.toUpperCase();
    let color = "#64748b";
    for (const [key, c] of Object.entries(colorMap)) {
      if (upperMode.includes(key)) {
        color = c;
        break;
      }
    }
    const amt = Number(item.amount) || 0;
    const pct = totalPaymentAmount > 0 ? Math.round((amt / totalPaymentAmount) * 1000) / 10 : 0;
    return {
      mode: rawMode,
      percentage: pct,
      amount: Math.round(amt),
      count: item.count || 0,
      color,
    };
  });

  // Hourly Sales Trend (8 AM to 10 PM slots)
  const slotHours = [8, 10, 12, 14, 16, 18, 20, 22];
  const slotLabels = ["8 AM", "10 AM", "12 PM", "2 PM", "4 PM", "6 PM", "8 PM", "10 PM"];

  const hourlyData = slotHours.map((slotH, idx) => {
    const matching = hourlyAggResult.filter((item) => {
      const h = Number(item._id);
      return idx === 0 ? h <= 8 : h === slotH || h === slotH - 1;
    });
    const s = matching.reduce((sum, curr) => sum + (Number(curr.sales) || 0), 0);
    const inv = matching.reduce((sum, curr) => sum + (Number(curr.invoices) || 0), 0);
    return {
      time: slotLabels[idx],
      hour: slotH,
      sales: Math.round(s),
      invoices: inv,
    };
  });

  // Low stock items formatting
  const formattedLowStock = lowStockResult.map((pf, idx) => ({
    id: String(pf._id || idx + 1),
    product: pf.product_id?.name || "Product",
    sku: pf.product_id?.workspaceProductCode || "SKU",
    batch: pf.itemCode || `LOT-${idx + 1}`,
    stock: Number(pf.total_qty_available || 0),
    reorderAt: 10,
  }));

  // Near expiry items formatting (<= 30 days) & expired
  const nearExpiryList = [];
  for (const b of allBatchesResult) {
    const exp = parseExpiryDate(b.expiryDate);
    if (exp) {
      const diffMs = exp.getTime() - now.getTime();
      const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (daysLeft <= 30) {
        nearExpiryList.push({
          id: String(b._id),
          product: b.product?.name || "Medicine",
          batch: b.batchNo || "BATCH",
          expiry: b.expiryDate || "N/A",
          daysLeft: Math.max(0, daysLeft),
          isExpired: daysLeft <= 0,
          stock: Number(b.batchQty || 0),
        });
      }
    }
  }
  nearExpiryList.sort((a, b) => a.daysLeft - b.daysLeft);
  const formattedNearExpiry = nearExpiryList.slice(0, 5);

  // Today's purchase receipts formatting
  const formattedPurchases = recentPurchases.map((pb, idx) => ({
    id: String(pb._id || idx + 1),
    supplier: pb.supplierId?.businessName || pb.supplierId?.name || "Distributor",
    invoiceNo: pb.purchaseBillNo || pb.supplierInvoiceNo || `PB-${idx + 1}`,
    items: Array.isArray(pb.items) ? pb.items.length : 0,
    amount: Number(pb.grandTotal || 0),
    status: pb.status === "CONFIRMED" ? "Received" : pb.status === "DRAFT" ? "Draft" : pb.status || "Received",
    date: dateFormatted,
  }));

  // Today's recent sales formatting
  const formattedRecentSales = todayInvoices.map((inv, idx) => {
    const invDate = new Date(inv.date || inv.createdAt);
    const timeStr = !isNaN(invDate.getTime())
      ? new Date(invDate.getTime() + IST_OFFSET_MS).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "UTC",
        })
      : "N/A";
    return {
      id: String(inv._id || idx + 1),
      time: timeStr,
      invoiceNo: inv.invoiceNo || `INV-${idx + 1}`,
      customer: inv.customerId?.name || "Walk-in Customer",
      items: Array.isArray(inv.items) ? inv.items.length : 1,
      amount: Number(inv.grandTotal || 0),
      payment: inv.paymentMethod || "Cash",
    };
  });

  // Inter-branch transfers formatting
  const formattedTransfers = transferOrders.map((to, idx) => ({
    id: String(to._id || idx + 1),
    fromTo: `${to.sourceBranchId?.name || to.sourceBranchId?.branchName || "Branch"} → ${to.destinationBranchId?.name || to.destinationBranchId?.branchName || "Branch"}`,
    items: Array.isArray(to.items) ? to.items.length : 0,
    status:
      to.status === "IN_TRANSIT"
        ? "In Transit"
        : to.status === "COMPLETED"
        ? "Completed"
        : to.status === "PENDING"
        ? "Pending"
        : to.status === "CANCELLED"
        ? "Cancelled"
        : to.status,
  }));

  // Shift & Cash Drawer Details
  const isDayOpen = String(activeBusinessDay?.status || "").toLowerCase() === "open";
  const isShiftLive = String(activeShift?.status || "").toLowerCase() === "open";
  const cashierName =
    activeShift?.openedBy?.fullName ||
    (activeShift?.openedBy?.firstName
      ? `${activeShift.openedBy.firstName} ${activeShift.openedBy.lastName || ""}`.trim()
      : null);

  const shiftOpenedAt = activeShift?.openedAt || activeShift?.createdAt;
  const shiftTimeFormatted = shiftOpenedAt
    ? `${new Date(new Date(shiftOpenedAt).getTime() + IST_OFFSET_MS).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      })} - Active`
    : "Not Started";

  const liveDrawerCash = branchCashDoc?.currentBalance ?? (activeShift?.cashSalesTotal ?? 0);

  return {
    branchInfo: {
      branchId: branchDoc?._id || branchObjectId,
      branchName: branchDoc?.name || branchDoc?.branchName || "Main Branch",
      branchCode: branchDoc?.branchCode || "BR-001",
      businessDayStatus: isDayOpen ? "OPEN" : "CLOSED",
      businessDate: activeBusinessDay?.businessDate || now,
      shiftName: activeShift?.shiftName || (isShiftLive ? `Shift #${activeShift.shiftNo || 1}` : "No Active Shift"),
      shiftTime: shiftTimeFormatted,
      cashierName: cashierName || "Unassigned",
      counterName: "Counter 1",
      isShiftActive: isShiftLive,
      isDayOpen,
    },
    kpis: {
      todaysSales,
      todaysSalesGrowth: salesGrowth,
      totalInvoices,
      totalInvoicesGrowth,
      newCustomers,
      newCustomersGrowth: 0,
      avgBillValue,
      avgBillValueGrowth: 0,
      itemsSold,
      itemsSoldGrowth: 0,
    },
    salesTrend: {
      timeframe: "Today",
      totalSales: todaysSales,
      totalInvoices,
      hourlyData,
    },
    paymentModeBreakdown: {
      totalSales: todaysSales,
      totalSalesFormatted: `₹ ${todaysSales.toLocaleString("en-IN")}`,
      breakdown: paymentBreakdownList,
    },
    currentShift: {
      isLive: isShiftLive,
      shiftId: activeShift?._id?.toString() || null,
      shiftNo: activeShift?.shiftNo || null,
      shiftName: activeShift?.shiftName || (isShiftLive ? `Shift #${activeShift.shiftNo || 1}` : "No Active Shift"),
      shiftTime: shiftTimeFormatted,
      cashier: cashierName || "None",
      counter: "Counter 1",
      salesAmount: activeShift?.salesTotal || todaysSales,
      invoices: activeShift?.totalInvoices || totalInvoices,
      cashInDrawer: liveDrawerCash,
      openedAt: activeShift?.openedAt || null,
    },
    lowStockItems: formattedLowStock,
    nearExpiryItems: formattedNearExpiry,
    todaysPurchases: formattedPurchases,
    recentSales: formattedRecentSales,
    interBranchTransfers: formattedTransfers,
  };
};

/**
 * Calculate IST-aligned timeframe boundaries and prior comparison period
 */
const calculateTimeframeBoundaries = (timeframe = "THIS_MONTH", customStart = null, customEnd = null) => {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const nowIST = new Date(now.getTime() + IST_OFFSET_MS);

  const y = nowIST.getUTCFullYear();
  const m = nowIST.getUTCMonth(); // 0-11
  const d = nowIST.getUTCDate();

  const tf = String(timeframe || "THIS_MONTH").trim().toUpperCase().replace(/\s+/g, "_");

  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const fmtDate = (dt) => {
    const ist = new Date(dt.getTime() + IST_OFFSET_MS);
    const day = String(ist.getUTCDate()).padStart(2, "0");
    const mon = MONTH_NAMES[ist.getUTCMonth()];
    const yr = ist.getUTCFullYear();
    return `${day} ${mon} ${yr}`;
  };

  let start;
  let end;
  let prevStart;
  let prevEnd;
  let dateRangeFormatted;

  if (customStart && customEnd) {
    start = new Date(customStart);
    if (String(customStart).length <= 10) start.setHours(0, 0, 0, 0);
    end = new Date(customEnd);
    if (String(customEnd).length <= 10) end.setHours(23, 59, 59, 999);
    const span = Math.max(1000, end.getTime() - start.getTime());
    prevEnd = new Date(start.getTime() - 1);
    prevStart = new Date(prevEnd.getTime() - span);
    dateRangeFormatted = `${fmtDate(start)} - ${fmtDate(end)}`;
  } else if (tf === "TODAY") {
    start = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - IST_OFFSET_MS);
    end = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - IST_OFFSET_MS);
    prevStart = new Date(Date.UTC(y, m, d - 1, 0, 0, 0, 0) - IST_OFFSET_MS);
    prevEnd = new Date(Date.UTC(y, m, d - 1, 23, 59, 59, 999) - IST_OFFSET_MS);
    dateRangeFormatted = fmtDate(start);
  } else if (tf === "THIS_QUARTER") {
    const qStartMonth = Math.floor(m / 3) * 3;
    start = new Date(Date.UTC(y, qStartMonth, 1, 0, 0, 0, 0) - IST_OFFSET_MS);
    end = new Date(Date.UTC(y, qStartMonth + 3, 0, 23, 59, 59, 999) - IST_OFFSET_MS);
    prevStart = new Date(Date.UTC(y, qStartMonth - 3, 1, 0, 0, 0, 0) - IST_OFFSET_MS);
    prevEnd = new Date(Date.UTC(y, qStartMonth, 0, 23, 59, 59, 999) - IST_OFFSET_MS);
    dateRangeFormatted = `${fmtDate(start)} - ${fmtDate(end)}`;
  } else if (tf === "THIS_YEAR") {
    start = new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0) - IST_OFFSET_MS);
    end = new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999) - IST_OFFSET_MS);
    prevStart = new Date(Date.UTC(y - 1, 0, 1, 0, 0, 0, 0) - IST_OFFSET_MS);
    prevEnd = new Date(Date.UTC(y - 1, 11, 31, 23, 59, 59, 999) - IST_OFFSET_MS);
    dateRangeFormatted = `${fmtDate(start)} - ${fmtDate(end)}`;
  } else {
    // Default THIS_MONTH
    start = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0) - IST_OFFSET_MS);
    end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999) - IST_OFFSET_MS);
    prevStart = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0) - IST_OFFSET_MS);
    prevEnd = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999) - IST_OFFSET_MS);
    dateRangeFormatted = `${fmtDate(start)} - ${fmtDate(end)}`;
  }

  return { start, end, prevStart, prevEnd, dateRangeFormatted };
};

const calculateWorkspaceTimeframe = calculateTimeframeBoundaries;

/**
 * Get Company Level Dashboard Data with Real MongoDB Aggregations
 * Strictly Company Scope:
 * - Corporate Bank Accounts & Treasury
 * - Branches registered under this company
 * - Customer Receivables & Supplier Payables
 * - Sales & Purchase aggregations and 6-Month Trends
 * - Branch Performance Leaderboard
 * - Sales by Category Donut & Top Selling Products
 * - GST Summary (GSTR-1, GSTR-2 ITC, GSTR-3B Net Payable)
 * - Inventory Stock Deficits & Expiry Alerts across company branches
 * - Recent Chronological Streams (Purchases, Sales, Transfers)
 */
const getCompanyDashboardData = async ({
  workspaceId,
  companyId,
  timeframe = "THIS_MONTH",
  startDate = null,
  endDate = null,
}) => {
  const wsObjectId = new mongoose.Types.ObjectId(workspaceId);
  const compObjectId = new mongoose.Types.ObjectId(companyId);

  const isActiveStatus = (status) => String(status || "").trim().toLowerCase() === "active";

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const fmtDate = (dt) => {
    if (!dt) return "";
    const ist = new Date(new Date(dt).getTime() + IST_OFFSET_MS);
    const day = String(ist.getUTCDate()).padStart(2, "0");
    const mon = MONTH_NAMES[ist.getUTCMonth()];
    const yr = ist.getUTCFullYear();
    return `${day} ${mon} ${yr}`;
  };

  const calcGrowth = (curr, prev) => {
    if (!prev || prev === 0) return curr > 0 ? 100 : 0;
    const pct = ((curr - prev) / prev) * 100;
    return Math.round(pct * 10) / 10;
  };

  // 1. Calculate IST Timeframe Boundaries
  const { start, end, prevStart, prevEnd, dateRangeFormatted } = calculateTimeframeBoundaries(
    timeframe,
    startDate,
    endDate
  );

  const toDateStr = (dt) => {
    const ist = new Date(new Date(dt).getTime() + IST_OFFSET_MS);
    return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
  };
  const startDateStr = toDateStr(start);
  const endDateStr = toDateStr(end);
  const prevStartDateStr = toDateStr(prevStart);
  const prevEndDateStr = toDateStr(prevEnd);

  const now = new Date();
  const nowIST = new Date(now.getTime() + IST_OFFSET_MS);
  const sixMonthsAgoStart = new Date(
    Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth() - 5, 1, 0, 0, 0, 0) - IST_OFFSET_MS
  );

  // 2. Parallel Core Entity Aggregations
  const [
    companyDoc,
    branches,
    salesCurrentAgg,
    salesPriorAgg,
    purchasesCurrentAgg,
    purchasesPriorAgg,
    sales6MonthsAgg,
    purchases6MonthsAgg,
    branchSalesCurrentAgg,
    branchSalesPriorAgg,
    bankAccounts,
    customerReceivablesAgg,
    supplierPayablesAgg,
    gstSummaryAgg,
    topProductsAgg,
    categorySalesAgg,
    recentPurchasesRaw,
    recentSalesRaw,
  ] = await Promise.all([
    // Company doc
    Company.findOne({ _id: compObjectId, workspaceId: wsObjectId, isDeleted: false }).lean(),

    // Branches for this company
    Branch.find({ companyId: compObjectId, workspaceId: wsObjectId, isDeleted: false })
      .select("name branchCode address phone email manager branchHead status createdAt")
      .sort({ createdAt: -1 })
      .lean(),

    // Sales in current timeframe (date field is indexed)
    SalesInvoice.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          isDeleted: false,
          $or: [
            { date: { $gte: start, $lte: end } },
            { createdAt: { $gte: start, $lte: end } },
          ],
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: "$grandTotal" },
          totalInvoices: { $sum: 1 },
          totalTax: { $sum: "$tax" },
        },
      },
    ]),

    // Sales in prior comparison period
    SalesInvoice.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          isDeleted: false,
          $or: [
            { date: { $gte: prevStart, $lte: prevEnd } },
            { createdAt: { $gte: prevStart, $lte: prevEnd } },
          ],
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: "$grandTotal" },
        },
      },
    ]),

    // Purchases in current timeframe (createdAt field is indexed)
    PurchaseBill.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          isDeleted: false,
          $or: [
            { createdAt: { $gte: start, $lte: end } },
            { invoiceDate: { $gte: startDateStr, $lte: endDateStr } },
          ],
        },
      },
      {
        $group: {
          _id: null,
          totalPurchases: { $sum: "$grandTotal" },
          totalGst: { $sum: "$totalGst" },
          amountDue: { $sum: "$amountDue" },
        },
      },
    ]),

    // Purchases in prior comparison period
    PurchaseBill.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          isDeleted: false,
          $or: [
            { createdAt: { $gte: prevStart, $lte: prevEnd } },
            { invoiceDate: { $gte: prevStartDateStr, $lte: prevEndDateStr } },
          ],
        },
      },
      {
        $group: {
          _id: null,
          totalPurchases: { $sum: "$grandTotal" },
        },
      },
    ]),

    // 6 Months Sales by month (IST)
    SalesInvoice.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          isDeleted: false,
          $or: [
            { date: { $gte: sixMonthsAgoStart } },
            { createdAt: { $gte: sixMonthsAgoStart } },
          ],
        },
      },
      {
        $group: {
          _id: {
            year: { $year: { date: { $ifNull: ["$date", "$createdAt"] }, timezone: "+05:30" } },
            month: { $month: { date: { $ifNull: ["$date", "$createdAt"] }, timezone: "+05:30" } },
          },
          sales: { $sum: "$grandTotal" },
        },
      },
    ]),

    // 6 Months Purchases by month (IST)
    PurchaseBill.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          isDeleted: false,
          $or: [
            { createdAt: { $gte: sixMonthsAgoStart } },
            { invoiceDate: { $gte: `${nowIST.getUTCFullYear() - 1}-01-01` } },
          ],
        },
      },
      {
        $group: {
          _id: {
            year: { $year: { date: "$createdAt", timezone: "+05:30" } },
            month: { $month: { date: "$createdAt", timezone: "+05:30" } },
          },
          purchases: { $sum: "$grandTotal" },
        },
      },
    ]),

    // Branch Performance in current period
    SalesInvoice.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          isDeleted: false,
          $or: [
            { date: { $gte: start, $lte: end } },
            { createdAt: { $gte: start, $lte: end } },
          ],
        },
      },
      {
        $group: {
          _id: "$branchId",
          sales: { $sum: "$grandTotal" },
          invoicesCount: { $sum: 1 },
        },
      },
    ]),

    // Branch Performance in prior period
    SalesInvoice.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          isDeleted: false,
          $or: [
            { date: { $gte: prevStart, $lte: prevEnd } },
            { createdAt: { $gte: prevStart, $lte: prevEnd } },
          ],
        },
      },
      {
        $group: {
          _id: "$branchId",
          sales: { $sum: "$grandTotal" },
        },
      },
    ]),

    // Corporate Bank Accounts
    BankAccount.find({
      companyId: compObjectId,
      workspaceId: wsObjectId,
      isDeleted: false,
    })
      .populate("ledgerAccountId", "name code openingBalance openingBalanceType")
      .populate("bankMasterId", "bankName logo")
      .lean(),

    // Customer Receivables (Total credit outstanding)
    Customer.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          isDeleted: false,
        },
      },
      {
        $group: {
          _id: null,
          totalReceivables: { $sum: "$creditOutstanding" },
        },
      },
    ]),

    // Supplier Payables (Total pending due bills)
    PurchaseBill.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          isDeleted: false,
          status: { $ne: "CANCELLED" },
        },
      },
      {
        $group: {
          _id: null,
          totalPayables: { $sum: "$amountDue" },
        },
      },
    ]),

    // GST Ledger Summary for Company
    GstLedger.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          voucherDate: { $gte: start, $lte: end },
        },
      },
      {
        $group: {
          _id: "$gstType",
          cgst: { $sum: "$cgst" },
          sgst: { $sum: "$sgst" },
          igst: { $sum: "$igst" },
          totalGst: { $sum: { $add: ["$cgst", "$sgst", "$igst"] } },
        },
      },
    ]),

    // Top Selling Products (grouped from invoice items)
    SalesInvoice.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          isDeleted: false,
          $or: [
            { date: { $gte: start, $lte: end } },
            { createdAt: { $gte: start, $lte: end } },
          ],
        },
      },
      { $unwind: "$items" },
      {
        $group: {
          _id: { $ifNull: ["$items.productId", "$items.name"] },
          name: { $first: "$items.name" },
          category: {
            $first: {
              $ifNull: [
                "$items.category",
                { $ifNull: ["$items.productForm", "Allopathic"] },
              ],
            },
          },
          unitsSold: { $sum: { $ifNull: ["$items.qty", 1] } },
          amount: {
            $sum: {
              $multiply: [
                { $ifNull: ["$items.qty", 1] },
                { $ifNull: ["$items.rate", { $ifNull: ["$items.price", 0] }] },
              ],
            },
          },
        },
      },
      { $sort: { amount: -1 } },
      { $limit: 5 },
    ]),

    // Sales by Product Category
    SalesInvoice.aggregate([
      {
        $match: {
          companyId: compObjectId,
          workspaceId: wsObjectId,
          isDeleted: false,
          $or: [
            { date: { $gte: start, $lte: end } },
            { createdAt: { $gte: start, $lte: end } },
          ],
        },
      },
      { $unwind: "$items" },
      {
        $group: {
          _id: {
            $ifNull: [
              "$items.category",
              { $ifNull: ["$items.productForm", "Allopathic"] },
            ],
          },
          amount: {
            $sum: {
              $multiply: [
                { $ifNull: ["$items.qty", 1] },
                { $ifNull: ["$items.rate", { $ifNull: ["$items.price", 0] }] },
              ],
            },
          },
        },
      },
      { $sort: { amount: -1 } },
      { $limit: 6 },
    ]),

    // Recent Purchases
    PurchaseBill.find({
      companyId: compObjectId,
      workspaceId: wsObjectId,
      isDeleted: false,
    })
      .populate("supplierId", "businessName name")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),

    // Recent Sales
    SalesInvoice.find({
      companyId: compObjectId,
      workspaceId: wsObjectId,
      isDeleted: false,
    })
      .populate("branchId", "name branchCode")
      .sort({ createdAt: -1, date: -1 })
      .limit(5)
      .lean(),
  ]);

  const branchIds = branches.map((b) => b._id);
  const activeBranches = branches.filter((b) => isActiveStatus(b.status));

  // 3. Dependent Parallel Batch: Bank Balances, Branch Stock Alerts, Transfers
  const ledgerAccountIds = bankAccounts
    .map((b) => b.ledgerAccountId?._id || b.ledgerAccountId)
    .filter(Boolean);

  const [
    accountBalances,
    stockDeficitAgg,
    activeBatches,
    transfersRaw,
  ] = await Promise.all([
    // Live AccountBalances for corporate bank ledger accounts
    ledgerAccountIds.length > 0
      ? AccountBalance.find({
          companyId: compObjectId,
          accountId: { $in: ledgerAccountIds },
        }).lean()
      : [],

    // Inventory Alerts from ProductFacility across company branches
    branchIds.length > 0
      ? ProductFacility.aggregate([
          {
            $match: {
              workspaceId: wsObjectId,
              facility_id: { $in: branchIds },
              isDeleted: false,
            },
          },
          {
            $group: {
              _id: null,
              outOfStock: {
                $sum: {
                  $cond: [{ $lte: ["$total_qty_available", 0] }, 1, 0],
                },
              },
              lowStock: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gt: ["$total_qty_available", 0] },
                        { $lte: ["$total_qty_available", 10] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ])
      : [],

    // Batches across company branches for near-expiry and expired
    branchIds.length > 0
      ? Batch.find({
          workspaceId: wsObjectId,
          branch_id: { $in: branchIds },
          isDeleted: false,
          batchQty: { $gt: 0 },
        })
          .select("expiryDate batchQty")
          .lean()
      : [],

    // Inter-Branch Transfers between this company's branches
    branchIds.length > 0
      ? TransferOrder.find({
          workspaceId: wsObjectId,
          $or: [
            { sourceBranchId: { $in: branchIds } },
            { destinationBranchId: { $in: branchIds } },
          ],
        })
          .populate("sourceBranchId", "name branchCode")
          .populate("destinationBranchId", "name branchCode")
          .sort({ createdAt: -1 })
          .limit(5)
          .lean()
      : [],
  ]);

  // 4. Calculate Corporate Bank Balances
  const balanceMap = new Map();
  accountBalances.forEach((ab) => {
    const accId = String(ab.accountId?._id || ab.accountId || "");
    const bal = Number(ab.balance || 0);
    const type = String(ab.balanceType || "dr").toLowerCase();
    balanceMap.set(accId, type === "dr" ? bal : -bal);
  });

  let totalBankBalance = 0;
  const corporateBankAccounts = bankAccounts.map((b) => {
    const accId = String(b.ledgerAccountId?._id || b.ledgerAccountId || "");
    let bal = 0;
    if (balanceMap.has(accId)) {
      bal = balanceMap.get(accId);
    } else if (b.ledgerAccountId && typeof b.ledgerAccountId === "object") {
      const opBal = Number(b.ledgerAccountId.openingBalance || 0);
      const opType = String(b.ledgerAccountId.openingBalanceType || "dr").toLowerCase();
      bal = opType === "dr" ? opBal : -opBal;
    }
    totalBankBalance += bal;

    return {
      id: String(b._id),
      bankName: b.bankMasterId?.bankName || b.accountName || "Bank",
      accountHolderName: b.accountHolderName,
      accountNumber: b.accountNumber,
      accountType: b.accountType || "CURRENT",
      ifscCode: b.ifscCode,
      branchName: b.branchName,
      isPrimary: Boolean(b.isPrimary),
      balance: bal,
    };
  });

  // 5. Primary KPI Metrics & Real Growth %
  const totalSales = Number(salesCurrentAgg[0]?.totalSales || 0);
  const totalSalesInvoices = Number(salesCurrentAgg[0]?.totalInvoices || 0);
  const priorSales = Number(salesPriorAgg[0]?.totalSales || 0);
  const totalSalesGrowth = calcGrowth(totalSales, priorSales);

  const totalPurchases = Number(purchasesCurrentAgg[0]?.totalPurchases || 0);
  const priorPurchases = Number(purchasesPriorAgg[0]?.totalPurchases || 0);
  const totalPurchasesGrowth = calcGrowth(totalPurchases, priorPurchases);

  // Verifiable Gross Realization: Sales - Purchases for the period
  const grossProfit = totalSales - totalPurchases;
  const priorGrossProfit = priorSales - priorPurchases;
  const grossProfitGrowth = calcGrowth(grossProfit, priorGrossProfit);

  const outstandingReceivables = Number(customerReceivablesAgg[0]?.totalReceivables || 0);
  const outstandingPayables = Number(supplierPayablesAgg[0]?.totalPayables || 0);

  // 6. 6-Month Historical Sales vs Purchases Trend
  const sales6MonthMap = new Map();
  sales6MonthsAgg.forEach((s) => {
    sales6MonthMap.set(`${s._id.year}-${s._id.month}`, Number(s.sales || 0));
  });

  const purchases6MonthMap = new Map();
  purchases6MonthsAgg.forEach((p) => {
    purchases6MonthMap.set(`${p._id.year}-${p._id.month}`, Number(p.purchases || 0));
  });

  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1; // 1-12
    const key = `${y}-${m}`;
    months.push({
      month: MONTH_NAMES[d.getUTCMonth()],
      year: y,
      sales: sales6MonthMap.get(key) || 0,
      purchases: purchases6MonthMap.get(key) || 0,
    });
  }

  // 7. Branch Performance Leaderboard
  const branchSalesMap = new Map();
  const branchCountMap = new Map();
  branchSalesCurrentAgg.forEach((b) => {
    const bId = String(b._id || "");
    branchSalesMap.set(bId, Number(b.sales || 0));
    branchCountMap.set(bId, Number(b.invoicesCount || 0));
  });

  const branchPriorSalesMap = new Map();
  branchSalesPriorAgg.forEach((b) => {
    const bId = String(b._id || "");
    branchPriorSalesMap.set(bId, Number(b.sales || 0));
  });

  const branchPerformance = branches
    .map((b) => {
      const bId = String(b._id);
      const bSales = branchSalesMap.get(bId) || 0;
      const bPrior = branchPriorSalesMap.get(bId) || 0;
      const bInvoices = branchCountMap.get(bId) || 0;
      const bGrowth = calcGrowth(bSales, bPrior);
      // Realization estimate (approx 25% gross markup margin)
      const bProfit = Math.round(bSales * 0.25);

      return {
        id: bId,
        name: b.name,
        code: b.branchCode || "BR",
        sales: bSales,
        profit: bProfit,
        growth: bGrowth,
        invoicesCount: bInvoices,
        status: isActiveStatus(b.status) ? "Active" : String(b.status || "Inactive"),
        manager: b.manager?.name || b.branchHead?.name || "Branch In-Charge",
      };
    })
    .sort((a, b) => b.sales - a.sales);

  // 8. Sales by Product Category
  const categoryPalette = ["#10b981", "#0ea5e9", "#f59e0b", "#ec4899", "#8b5cf6", "#94a3b8"];
  const totalCatAmount = categorySalesAgg.reduce((sum, c) => sum + Number(c.amount || 0), 0);
  const categories = categorySalesAgg.map((cat, idx) => {
    const amt = Number(cat.amount || 0);
    const pct = totalCatAmount > 0 ? Number(((amt / totalCatAmount) * 100).toFixed(1)) : 0;
    return {
      name: String(cat._id || "Other Medicines"),
      percentage: pct,
      amount: amt,
      color: categoryPalette[idx % categoryPalette.length],
    };
  });

  const salesByCategory = {
    totalSales,
    totalSalesFormatted: `₹ ${Number(totalSales).toLocaleString("en-IN")}`,
    categories,
  };

  // 9. Top Selling Products
  const topSellingProducts = topProductsAgg.map((p, idx) => ({
    id: String(p._id || idx + 1),
    name: p.name || "Medicine SKU",
    category: p.category || "General Rx",
    unitsSold: Number(p.unitsSold || 0),
    amount: Number(p.amount || 0),
  }));

  // 10. GST Summary (GSTR-1, GSTR-2, GSTR-3B)
  let outputGst = 0;
  let itc = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;

  if (gstSummaryAgg.length > 0) {
    gstSummaryAgg.forEach((g) => {
      if (g._id === "GSTR-1") {
        outputGst += Number(g.totalGst || 0);
        cgst += Number(g.cgst || 0);
        sgst += Number(g.sgst || 0);
        igst += Number(g.igst || 0);
      } else if (g._id === "GSTR-2") {
        itc += Number(g.totalGst || 0);
      }
    });
  } else {
    // Fallback to taxes recorded on SalesInvoices and PurchaseBills
    outputGst = Number(salesCurrentAgg[0]?.totalTax || 0);
    itc = Number(purchasesCurrentAgg[0]?.totalGst || 0);
    cgst = Math.round(outputGst * 0.5);
    sgst = Math.round(outputGst * 0.5);
    igst = 0;
  }

  const netGstPayable = Math.max(0, outputGst - itc);
  const maxGstBreakdown = Math.max(cgst, sgst, igst, 1);

  const gstSummary = {
    outputGst,
    itc,
    netGstPayable,
    breakdown: [
      {
        label: "CGST",
        amount: cgst,
        color: "bg-emerald-500",
        barHeightPct: Math.round((cgst / maxGstBreakdown) * 100),
      },
      {
        label: "SGST",
        amount: sgst,
        color: "bg-blue-500",
        barHeightPct: Math.round((sgst / maxGstBreakdown) * 100),
      },
      {
        label: "IGST",
        amount: igst,
        color: "bg-purple-500",
        barHeightPct: Math.round((igst / maxGstBreakdown) * 100),
      },
    ],
  };

  // 11. Inventory Shortages & Expiry Alerts across company branches
  const outOfStockCount = Number(stockDeficitAgg[0]?.outOfStock || 0);
  const lowStockCount = Number(stockDeficitAgg[0]?.lowStock || 0);

  const thirtyDaysAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  let nearExpiryCount = 0;
  let expiredCount = 0;

  activeBatches.forEach((batch) => {
    const expDate = parseExpiryDate(batch.expiryDate);
    if (!expDate) return;
    if (expDate < now) {
      expiredCount++;
    } else if (expDate <= thirtyDaysAhead) {
      nearExpiryCount++;
    }
  });

  const inventoryAlerts = {
    outOfStock: outOfStockCount,
    lowStock: lowStockCount,
    nearExpiry: nearExpiryCount,
    expired: expiredCount,
  };

  // 12. Recent Activity Streams
  const recentPurchases = recentPurchasesRaw.map((pb) => ({
    id: String(pb._id),
    date: fmtDate(pb.createdAt),
    supplier: pb.supplierId?.businessName || pb.supplierId?.name || "Distributor",
    invoiceNo: pb.purchaseBillNo || pb.supplierInvoiceNo || "PB",
    items: Array.isArray(pb.items) ? pb.items.length : 0,
    amount: Number(pb.grandTotal || 0),
    status: pb.status === "CONFIRMED" ? "Received" : pb.status === "DRAFT" ? "Draft" : pb.status || "Received",
  }));

  const recentSales = recentSalesRaw.map((inv) => ({
    id: String(inv._id),
    date: fmtDate(inv.date || inv.createdAt),
    branch: inv.branchId?.name || "Main Counter",
    invoiceNo: inv.invoiceNo || "INV",
    amount: Number(inv.grandTotal || 0),
    payment: inv.paymentMethod || "Cash",
  }));

  const interBranchTransfers = transfersRaw.map((t) => ({
    id: String(t._id),
    date: fmtDate(t.createdAt),
    fromTo: `${t.sourceBranchId?.name || "Branch"} → ${t.destinationBranchId?.name || "Branch"}`,
    items: Array.isArray(t.items) ? t.items.length : 0,
    status:
      t.status === "IN_TRANSIT"
        ? "In Transit"
        : t.status === "COMPLETED"
        ? "Completed"
        : t.status === "PENDING"
        ? "Pending"
        : t.status === "CANCELLED"
        ? "Cancelled"
        : t.status,
  }));

  return {
    companyInfo: {
      companyId: String(companyDoc?._id || compObjectId),
      companyName: companyDoc?.name || "Company",
      legalName: companyDoc?.legalName || companyDoc?.name || "Company",
      gstin: companyDoc?.gstin || "N/A",
      pan: companyDoc?.pan || "N/A",
      activeBranchesCount: activeBranches.length,
      totalBranchesCount: branches.length,
      dateRangeFormatted,
    },
    kpis: {
      totalSales,
      totalSalesGrowth,
      totalSalesInvoices,
      totalPurchases,
      totalPurchasesGrowth,
      grossProfit,
      grossProfitGrowth,
      outstandingReceivables,
      outstandingReceivablesGrowth: 0,
      outstandingPayables,
      outstandingPayablesGrowth: 0,
      bankBalance: totalBankBalance,
      bankBalanceGrowth: 0,
    },
    salesVsPurchasesTrend: {
      timeframe: "Last 6 Months",
      months,
    },
    branchPerformance,
    salesByCategory,
    topSellingProducts,
    gstSummary,
    inventoryAlerts,
    recentPurchases,
    recentSales,
    interBranchTransfers,
    corporateBankAccounts,
  };
};

/**
 * Get Workspace Level Dashboard Data with Real MongoDB Aggregations
 * Strictly Workspace Scope:
 * - Legal Registered Companies Directory
 * - Physical Branch Network
 * - Team Members & Access Control
 * - Roles & Permissions Master
 * - Corporate Bank Accounts with real live accumulated balances
 * - Subscription & Quota Limits
 * - Workspace Setup & Compliance Health
 */
const getWorkspaceDashboardData = async ({
  workspaceId,
  timeframe = "THIS_MONTH",
  startDate = null,
  endDate = null,
}) => {
  const wsObjectId = new mongoose.Types.ObjectId(workspaceId);
  const now = new Date();
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const isActiveStatus = (status) => String(status || "").trim().toLowerCase() === "active";

  const fmtDate = (dt) => {
    if (!dt) return "";
    const ist = new Date(new Date(dt).getTime() + IST_OFFSET_MS);
    const day = String(ist.getUTCDate()).padStart(2, "0");
    const mon = MONTH_NAMES[ist.getUTCMonth()];
    const yr = ist.getUTCFullYear();
    return `${day} ${mon} ${yr}`;
  };

  // 1. Fetch Core Workspace Document
  const workspaceDoc = await Workspace.findById(wsObjectId)
    .select("name code createdAt status")
    .lean();

  // 2. Fetch All Registered Companies
  const companies = await Company.find({
    workspaceId: wsObjectId,
    isDeleted: false,
  })
    .select("name companyCode legalName gstin pan email phone address licenses status createdAt")
    .sort({ createdAt: -1 })
    .lean();

  // 3. Fetch All Physical Branches Mapped to Companies
  const branches = await Branch.find({
    workspaceId: wsObjectId,
    isDeleted: false,
  })
    .populate("companyId", "name companyCode")
    .select("name branchCode companyId address phone email status branchHead manager createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const branchCountByCompany = new Map();
  branches.forEach((br) => {
    const cId = String(br.companyId?._id || br.companyId || "");
    branchCountByCompany.set(cId, (branchCountByCompany.get(cId) || 0) + 1);
  });

  const formattedCompanies = companies.map((c) => ({
    id: String(c._id),
    name: c.name,
    code: c.companyCode || "CO",
    legalName: c.legalName || c.name,
    gstin: c.gstin || "N/A",
    pan: c.pan || "N/A",
    email: c.email || null,
    phone: c.phone?.mobile || c.phone?.landline || null,
    city: c.address?.city || null,
    state: c.address?.state || null,
    retailLicense: c.licenses?.retailLicenseNumber || null,
    wholesaleLicense: c.licenses?.wholesaleLicenseNumber || null,
    fssaiNumber: c.licenses?.fssaiNumber || null,
    status: isActiveStatus(c.status) ? "ACTIVE" : String(c.status || "INACTIVE").toUpperCase(),
    branchCount: branchCountByCompany.get(String(c._id)) || 0,
    createdAt: c.createdAt,
    createdAtFormatted: fmtDate(c.createdAt),
  }));

  const formattedBranches = branches.map((b) => ({
    id: String(b._id),
    name: b.name,
    code: b.branchCode || "BR",
    companyId: String(b.companyId?._id || b.companyId || ""),
    companyName: b.companyId?.name || "Company",
    companyCode: b.companyId?.companyCode || "CO",
    city: b.address?.city || "Local",
    state: b.address?.state || null,
    phone: b.phone?.mobile || null,
    manager: b.manager?.name || b.branchHead?.name || "Branch In-Charge",
    status: isActiveStatus(b.status) ? "ACTIVE" : String(b.status || "INACTIVE").toUpperCase(),
    createdAt: b.createdAt,
    createdAtFormatted: fmtDate(b.createdAt),
  }));

  // 4. Fetch Workspace Members & Role Distribution
  const members = await WorkspaceMember.find({
    workspaceId: wsObjectId,
    status: { $ne: "Removed" },
  })
    .populate("userId", "name email phone isEmailVerified lastLoginAt")
    .populate("roleId", "name code isSystem")
    .sort({ isOwner: -1, createdAt: -1 })
    .lean();

  const roleMemberCounts = new Map();
  const formattedMembers = members.map((m) => {
    const roleName = m.roleId?.name || (m.isOwner ? "Workspace Owner" : "Member");
    const roleCode = m.roleId?.code || (m.isOwner ? "owner" : "member");
    const roleIdKey = String(m.roleId?._id || roleCode);
    roleMemberCounts.set(roleIdKey, (roleMemberCounts.get(roleIdKey) || 0) + 1);

    return {
      id: String(m._id),
      userId: String(m.userId?._id || ""),
      name: m.userId?.name || "Staff Member",
      email: m.userId?.email || "N/A",
      phone: m.userId?.phone || null,
      roleName,
      roleCode,
      isOwner: Boolean(m.isOwner),
      status: isActiveStatus(m.status) ? "Active" : String(m.status || "Inactive"),
      lastActiveAt: m.lastActiveAt || m.userId?.lastLoginAt || m.createdAt,
      lastActiveFormatted: fmtDate(m.lastActiveAt || m.userId?.lastLoginAt || m.createdAt),
      createdAt: m.createdAt,
    };
  });

  // 5. Fetch Roles & Permissions
  const roles = await Role.find({
    workspaceId: wsObjectId,
    isDeleted: false,
  })
    .select("name code description permissions isSystem status createdAt")
    .sort({ isSystem: -1, name: 1 })
    .lean();

  const formattedRoles = roles.map((r) => {
    const memberCount = roleMemberCounts.get(String(r._id)) || roleMemberCounts.get(r.code) || 0;
    return {
      id: String(r._id),
      name: r.name,
      code: r.code,
      description: r.description || "System configured role",
      isSystem: Boolean(r.isSystem),
      permissionsCount: Array.isArray(r.permissions) ? r.permissions.length : 0,
      memberCount,
      status: isActiveStatus(r.status) ? "ACTIVE" : String(r.status || "INACTIVE").toUpperCase(),
      createdAt: r.createdAt,
    };
  });

  // 6. Active Counts with Case-Insensitive Matching
  const activeCompCount = companies.filter((c) => isActiveStatus(c.status)).length;
  const activeBranchCount = branches.filter((b) => isActiveStatus(b.status)).length;
  const activeStaffCount = members.filter((m) => isActiveStatus(m.status)).length;

  // 7. Subscription Quotas & Limits
  const activeSub = await Subscription.findOne({
    workspaceId: wsObjectId,
    status: { $in: ["ACTIVE", "TRIAL", "GRACE_PERIOD"] },
  })
    .populate("planId")
    .sort({ createdAt: -1 })
    .lean();

  const planLimits = activeSub?.planId?.limits || {};
  const maxCompanies = planLimits.maxCompanies || Math.max(companies.length, 3);
  const maxBranches = planLimits.maxBranches || Math.max(branches.length, 10);
  const maxStaff = planLimits.maxUsers || Math.max(members.length, 20);

  const daysLeft = activeSub?.expiresAt
    ? Math.max(0, Math.ceil((new Date(activeSub.expiresAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
    : 365;

  const subscriptionUsage = {
    planName: activeSub?.currentPlanSnapshot?.name || activeSub?.planId?.name || "Enterprise Plan",
    status: activeSub?.status || "Active",
    tier: activeSub?.planId?.tier || "PRO",
    validTill: activeSub?.expiresAt ? fmtDate(activeSub.expiresAt) : "Continuous",
    daysLeft,
    companies: {
      used: companies.length,
      active: activeCompCount,
      max: maxCompanies,
      pct: Math.min(100, Math.round((companies.length / maxCompanies) * 100)),
    },
    branches: {
      used: branches.length,
      active: activeBranchCount,
      max: maxBranches,
      pct: Math.min(100, Math.round((branches.length / maxBranches) * 100)),
    },
    staffSeats: {
      used: members.length,
      active: activeStaffCount,
      max: maxStaff,
      pct: Math.min(100, Math.round((members.length / maxStaff) * 100)),
    },
  };

  // 8. Workspace Setup & Compliance Status
  const compliance = {
    isSetupComplete: Boolean(workspaceDoc?.name && activeCompCount > 0 && activeBranchCount > 0),
    healthScore: Math.round(
      ((activeCompCount > 0 ? 30 : 0) +
       (activeBranchCount > 0 ? 30 : 0) +
       (activeStaffCount > 0 ? 20 : 0) +
       (roles.length > 0 ? 20 : 0))
    ),
    organizationProfile: Boolean(workspaceDoc?.name),
    hasActiveCompany: activeCompCount > 0,
    hasActiveBranch: activeBranchCount > 0,
    hasStaffAssigned: activeStaffCount > 0,
    hasRolesConfigured: roles.length > 0,
  };

  // 9. Primary Workspace KPIs (Strictly Workspace-Level, Bank Accounts Belong to Company Dashboard)
  const kpis = {
    totalCompanies: companies.length,
    activeCompanies: activeCompCount,
    maxCompanies,
    totalBranches: branches.length,
    activeBranches: activeBranchCount,
    maxBranches,
    totalStaff: members.length,
    activeStaff: activeStaffCount,
    maxStaff,
    totalRoles: roles.length,
    planName: subscriptionUsage.planName,
    planTier: subscriptionUsage.tier,
    validTill: subscriptionUsage.validTill,
    daysLeft,
    status: workspaceDoc?.status || "Active",
  };

  return {
    workspaceInfo: {
      id: String(workspaceDoc?._id || wsObjectId),
      name: workspaceDoc?.name || "Healthcare Pharmacy Workspace",
      code: workspaceDoc?.code || "WS",
      createdAt: workspaceDoc?.createdAt,
      createdAtFormatted: fmtDate(workspaceDoc?.createdAt),
    },
    kpis,
    companies: formattedCompanies,
    branches: formattedBranches,
    members: formattedMembers,
    roles: formattedRoles,
    subscriptionUsage,
    compliance,
  };
};

export {
  getDashboardOverview,
  getCompanyDashboardData,
  getWorkspaceDashboardData,
};

export default {
  getDashboardOverview,
  getBranchDashboardData,
  getCompanyDashboardData,
  getWorkspaceDashboardData,
};
