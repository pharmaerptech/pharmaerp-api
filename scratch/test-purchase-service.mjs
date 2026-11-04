import mongoose from "mongoose";
import PurchaseBill from "../src/modules/catalog/purchase-bills/models/purchaseBill.model.js";
import Supplier from "../src/modules/parties/suppliers/models/supplier.model.js";
import User from "../src/modules/core/users/models/user.model.js";

const getDateRange = (startDate, endDate) => {
  let start;
  let end;
  if (startDate) {
    start = new Date(startDate);
    if (String(startDate).length <= 10) start.setHours(0, 0, 0, 0);
  } else {
    start = new Date();
    start.setDate(start.getDate() - 90); // default last 90 days for testing
    start.setHours(0, 0, 0, 0);
  }
  if (endDate) {
    end = new Date(endDate);
    if (String(endDate).length <= 10) end.setHours(23, 59, 59, 999);
  } else {
    end = new Date();
    end.setHours(23, 59, 59, 999);
  }
  return { start, end };
};

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function run() {
  await mongoose.connect("mongodb+srv://dev:dev%401234@erp-cluster.tqgbpyi.mongodb.net/erp?retryWrites=true&w=majority");
  console.log("Connected to MongoDB");

  const workspaceId = new mongoose.Types.ObjectId("6ab77b681fba63d384f9542d");
  const companyId = new mongoose.Types.ObjectId("6ab7830e1fba63d384f95439");
  const { start, end } = getDateRange("2026-09-01", "2026-11-05");

  const filter = {
    workspaceId,
    companyId,
    createdAt: { $gte: start, $lte: end },
    isDeleted: false,
    status: { $ne: "CANCELLED" }
  };

  // 1. Purchase Summary
  const summaryAgg = await PurchaseBill.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        totalPurchases: { $sum: "$grandTotal" },
        totalBills: { $sum: 1 },
        taxableAmount: { $sum: "$taxableSubtotal" },
        totalGst: { $sum: "$totalGst" },
        amountPaid: { $sum: "$amountPaid" },
        amountDue: { $sum: "$amountDue" },
      }
    }
  ]);
  console.log("Summary Agg:", summaryAgg[0]);

  // 2. Trend Agg
  const trendAgg = await PurchaseBill.aggregate([
    { $match: filter },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$createdAt",
            timezone: "+05:30",
          },
        },
        metric1: { $sum: "$grandTotal" },
        metric2: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  console.log("Trend Agg points count:", trendAgg.length);
  if (trendAgg.length > 0) console.log("First trend point:", trendAgg[0]);

  // 3. Purchase Detail ($unwind items)
  const detailAgg = await PurchaseBill.aggregate([
    { $match: filter },
    { $unwind: "$items" },
    {
      $facet: {
        stats: [
          {
            $group: {
              _id: null,
              totalLineItems: { $sum: 1 },
              totalQty: { $sum: { $add: ["$items.qty", { $ifNull: ["$items.freeQty", 0] }] } },
              totalTaxable: { $sum: "$items.amount" },
              totalInwardCost: { $sum: "$items.amount" },
            }
          }
        ],
        rows: [
          { $limit: 3 },
          {
            $project: {
              date: { $ifNull: ["$invoiceDate", "$createdAt"] },
              billNo: "$purchaseBillNo",
              supplierId: "$supplierId",
              name: "$items.name",
              batch: "$items.batch",
              qty: "$items.qty",
              rate: "$items.rate",
              amount: "$items.amount"
            }
          }
        ]
      }
    }
  ]);
  console.log("Detail stats:", detailAgg[0].stats[0]);
  console.log("Detail sample rows:", detailAgg[0].rows);

  // 4. Supplier Purchase Grouping
  const supplierAgg = await PurchaseBill.aggregate([
    { $match: filter },
    {
      $group: {
        _id: "$supplierId",
        totalPurchases: { $sum: "$grandTotal" },
        taxableAmount: { $sum: "$taxableSubtotal" },
        gstAmount: { $sum: "$totalGst" },
        billsCount: { $sum: 1 },
        amountPaid: { $sum: "$amountPaid" },
        amountDue: { $sum: "$amountDue" },
        lastPurchaseDate: { $max: "$createdAt" }
      }
    },
    {
      $lookup: {
        from: "suppliers",
        localField: "_id",
        foreignField: "_id",
        as: "supplier"
      }
    },
    {
      $unwind: { path: "$supplier", preserveNullAndEmptyArrays: true }
    },
    { $limit: 3 }
  ]);
  console.log("Supplier Agg sample:", supplierAgg.map(s => ({
    name: s.supplier?.businessName,
    bills: s.billsCount,
    total: s.totalPurchases
  })));

  process.exit(0);
}

run().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});

