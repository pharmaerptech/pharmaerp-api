import mongoose from "mongoose";
import GstLedger from "../models/gstLedger.model.js";
import calculateGstr1Summary, { deduceGstrGroup, isCreditNoteEntry } from "../utils/gstr1SummaryCalculator.js";
import { calculateGstr3bSummary } from "../utils/gstr3bSummaryCalculator.js";

const createGstLedgerEntry = async (payload, options = {}) => {
  const [entry] = await GstLedger.create([payload], {
    session: options.session || null,
  });
  return entry;
};

const deleteGstLedgerEntriesByVoucherId = async (voucherId, options = {}) => {
  if (!mongoose.Types.ObjectId.isValid(voucherId)) {
    return null;
  }

  return GstLedger.deleteMany(
    { voucherId },
    {
      session: options.session || null,
    }
  );
};

const getGstLedgerEntries = async (
  workspaceId,
  companyId,
  gstType,
  filters = {},
  options = {}
) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    !mongoose.Types.ObjectId.isValid(companyId)
  ) {
    return { entries: [], total: 0, page: 1, limit: 20 };
  }

  const query = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    companyId: new mongoose.Types.ObjectId(companyId),
    gstType,
  };

  if (filters.startDate || filters.endDate) {
    query.voucherDate = {};
    if (filters.startDate) {
      query.voucherDate.$gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      query.voucherDate.$lte = new Date(filters.endDate);
    }
  }

  // Filter by specific branch (if "all" or omitted, queries company-wide)
  if (filters.branchId && filters.branchId !== "all" && mongoose.Types.ObjectId.isValid(filters.branchId)) {
    const targetBranchId = new mongoose.Types.ObjectId(filters.branchId);

    // Find any vouchers for this branch to match legacy entries that don't have branchId stored directly yet
    let voucherIdsForBranch = [];
    try {
      const db = mongoose.connection.db;
      if (db) {
        if (gstType === "GSTR-1") {
          const invoices = await db.collection("invoices").find({
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            companyId: new mongoose.Types.ObjectId(companyId),
            branchId: targetBranchId,
          }).project({ _id: 1 }).toArray();
          voucherIdsForBranch = invoices.map((inv) => inv._id);
        } else if (gstType === "GSTR-2") {
          const purchaseBills = await db.collection("purchasebills").find({
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            companyId: new mongoose.Types.ObjectId(companyId),
            branchId: targetBranchId,
          }).project({ _id: 1 }).toArray();
          voucherIdsForBranch = purchaseBills.map((pb) => pb._id);
        }
      }
    } catch (e) {
      console.error("Error looking up vouchers for branch in gstLedger:", e);
    }

    if (voucherIdsForBranch.length > 0) {
      query.$or = [
        { branchId: targetBranchId },
        { voucherId: { $in: voucherIdsForBranch } },
      ];
    } else {
      query.branchId = targetBranchId;
    }
  }

  // Optional: Filter by specific party if needed
  if (filters.partyId && mongoose.Types.ObjectId.isValid(filters.partyId)) {
    query.partyId = new mongoose.Types.ObjectId(filters.partyId);
  }

  if (filters.search && typeof filters.search === "string" && filters.search.trim()) {
    const searchRegex = new RegExp(filters.search.trim(), "i");
    const searchCondition = [{ voucherNumber: searchRegex }, { narration: searchRegex }];
    if (query.$or) {
      query.$and = [
        { $or: query.$or },
        { $or: searchCondition },
      ];
      delete query.$or;
    } else {
      query.$or = searchCondition;
    }
  }

  const sort = options.sort || { voucherDate: -1, createdAt: -1 };

  const calculateEntriesStats = (entriesList, count) => {
    return entriesList.reduce(
      (acc, curr) => {
        const isCredit = isCreditNoteEntry(curr);
        const sign = isCredit ? -1 : 1;
        const taxable = Number(curr.taxableAmount || 0);
        const cgst = Number(curr.cgst || 0);
        const sgst = Number(curr.sgst || 0);
        const igst = Number(curr.igst || 0);
        const totalAmt = Number(curr.totalAmount || 0);
        const gst = cgst + sgst + igst;

        acc.totalTaxable = Math.round((acc.totalTaxable + taxable * sign) * 100) / 100;
        acc.totalCgst = Math.round((acc.totalCgst + cgst * sign) * 100) / 100;
        acc.totalSgst = Math.round((acc.totalSgst + sgst * sign) * 100) / 100;
        acc.totalIgst = Math.round((acc.totalIgst + igst * sign) * 100) / 100;
        acc.totalGst = Math.round((acc.totalGst + gst * sign) * 100) / 100;
        acc.totalAmount = Math.round((acc.totalAmount + totalAmt * sign) * 100) / 100;

        if (isCredit) {
          acc.creditTaxable = Math.round((acc.creditTaxable + taxable) * 100) / 100;
          acc.creditCgst = Math.round((acc.creditCgst + cgst) * 100) / 100;
          acc.creditSgst = Math.round((acc.creditSgst + sgst) * 100) / 100;
          acc.creditIgst = Math.round((acc.creditIgst + igst) * 100) / 100;
          acc.creditGst = Math.round((acc.creditGst + gst) * 100) / 100;
          acc.creditAmount = Math.round((acc.creditAmount + totalAmt) * 100) / 100;
          acc.creditTotalAmount = acc.creditAmount;
          acc.creditCount += 1;
          acc.creditNoteCount += 1;
        } else {
          acc.grossTaxable = Math.round((acc.grossTaxable + taxable) * 100) / 100;
          acc.grossCgst = Math.round((acc.grossCgst + cgst) * 100) / 100;
          acc.grossSgst = Math.round((acc.grossSgst + sgst) * 100) / 100;
          acc.grossIgst = Math.round((acc.grossIgst + igst) * 100) / 100;
          acc.grossGst = Math.round((acc.grossGst + gst) * 100) / 100;
          acc.grossAmount = Math.round((acc.grossAmount + totalAmt) * 100) / 100;
          acc.grossTotalAmount = acc.grossAmount;
          acc.invoiceCount += 1;
        }

        return acc;
      },
      {
        totalTaxable: 0,
        totalCgst: 0,
        totalSgst: 0,
        totalIgst: 0,
        totalGst: 0,
        totalAmount: 0,
        grossTaxable: 0,
        grossCgst: 0,
        grossSgst: 0,
        grossIgst: 0,
        grossGst: 0,
        grossAmount: 0,
        grossTotalAmount: 0,
        creditTaxable: 0,
        creditCgst: 0,
        creditSgst: 0,
        creditIgst: 0,
        creditGst: 0,
        creditAmount: 0,
        creditTotalAmount: 0,
        invoiceCount: 0,
        creditCount: 0,
        creditNoteCount: 0,
        count: count !== undefined ? count : entriesList.length,
      }
    );
  };

  if (options.all === true) {
    const entries = await GstLedger.find(query)
      .populate({ path: "branchId", select: "name code", strictPopulate: false })
      .sort(sort)
      .session(options.session || null);
    const stats = calculateEntriesStats(entries, entries.length);
    return { entries, total: entries.length, stats };
  }

  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 10));
  const skip = (page - 1) * limit;

  const creditNoteRegexCond = {
    $or: [
      { $regexMatch: { input: { $ifNull: ["$groupDescription", ""] }, regex: /credit note|cdn/i } },
      { $regexMatch: { input: { $ifNull: ["$narration", ""] }, regex: /credit note|sales return/i } },
      { $regexMatch: { input: { $ifNull: ["$voucherNumber", ""] }, regex: /^(ret-|cn-)/i } },
    ],
  };

  const [entries, total, aggStats] = await Promise.all([
    GstLedger.find(query)
      .populate({ path: "branchId", select: "name code", strictPopulate: false })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .session(options.session || null),
    GstLedger.countDocuments(query).session(options.session || null),
    GstLedger.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalTaxable: {
            $sum: {
              $cond: [creditNoteRegexCond, { $multiply: ["$taxableAmount", -1] }, "$taxableAmount"],
            },
          },
          totalCgst: {
            $sum: {
              $cond: [creditNoteRegexCond, { $multiply: ["$cgst", -1] }, "$cgst"],
            },
          },
          totalSgst: {
            $sum: {
              $cond: [creditNoteRegexCond, { $multiply: ["$sgst", -1] }, "$sgst"],
            },
          },
          totalIgst: {
            $sum: {
              $cond: [creditNoteRegexCond, { $multiply: ["$igst", -1] }, "$igst"],
            },
          },
          totalAmount: {
            $sum: {
              $cond: [creditNoteRegexCond, { $multiply: ["$totalAmount", -1] }, "$totalAmount"],
            },
          },
          grossTaxable: {
            $sum: {
              $cond: [creditNoteRegexCond, 0, "$taxableAmount"],
            },
          },
          grossCgst: {
            $sum: {
              $cond: [creditNoteRegexCond, 0, "$cgst"],
            },
          },
          grossSgst: {
            $sum: {
              $cond: [creditNoteRegexCond, 0, "$sgst"],
            },
          },
          grossIgst: {
            $sum: {
              $cond: [creditNoteRegexCond, 0, "$igst"],
            },
          },
          grossAmount: {
            $sum: {
              $cond: [creditNoteRegexCond, 0, "$totalAmount"],
            },
          },
          invoiceCount: {
            $sum: {
              $cond: [creditNoteRegexCond, 0, 1],
            },
          },
          creditTaxable: {
            $sum: {
              $cond: [creditNoteRegexCond, "$taxableAmount", 0],
            },
          },
          creditCgst: {
            $sum: {
              $cond: [creditNoteRegexCond, "$cgst", 0],
            },
          },
          creditSgst: {
            $sum: {
              $cond: [creditNoteRegexCond, "$sgst", 0],
            },
          },
          creditIgst: {
            $sum: {
              $cond: [creditNoteRegexCond, "$igst", 0],
            },
          },
          creditAmount: {
            $sum: {
              $cond: [creditNoteRegexCond, "$totalAmount", 0],
            },
          },
          creditCount: {
            $sum: {
              $cond: [creditNoteRegexCond, 1, 0],
            },
          },
          count: { $sum: 1 },
        },
      },
    ])
      .session(options.session || null)
      .catch(() => []),
  ]);

  const rawStat = (aggStats && aggStats[0]) || {};
  const cgst = Number(rawStat.totalCgst || 0);
  const sgst = Number(rawStat.totalSgst || 0);
  const igst = Number(rawStat.totalIgst || 0);
  const grossCgst = Number(rawStat.grossCgst || 0);
  const grossSgst = Number(rawStat.grossSgst || 0);
  const grossIgst = Number(rawStat.grossIgst || 0);
  const creditCgst = Number(rawStat.creditCgst || 0);
  const creditSgst = Number(rawStat.creditSgst || 0);
  const creditIgst = Number(rawStat.creditIgst || 0);
  const creditCount = Number(rawStat.creditCount || 0);
  const invoiceCount = Number(rawStat.invoiceCount || 0);

  const stats = {
    totalTaxable: Math.round(Number(rawStat.totalTaxable || 0) * 100) / 100,
    totalCgst: Math.round(cgst * 100) / 100,
    totalSgst: Math.round(sgst * 100) / 100,
    totalIgst: Math.round(igst * 100) / 100,
    totalGst: Math.round((cgst + sgst + igst) * 100) / 100,
    totalAmount: Math.round(Number(rawStat.totalAmount || 0) * 100) / 100,
    grossTaxable: Math.round(Number(rawStat.grossTaxable || 0) * 100) / 100,
    grossCgst: Math.round(grossCgst * 100) / 100,
    grossSgst: Math.round(grossSgst * 100) / 100,
    grossIgst: Math.round(grossIgst * 100) / 100,
    grossGst: Math.round((grossCgst + grossSgst + grossIgst) * 100) / 100,
    grossAmount: Math.round(Number(rawStat.grossAmount || 0) * 100) / 100,
    grossTotalAmount: Math.round(Number(rawStat.grossAmount || 0) * 100) / 100,
    creditTaxable: Math.round(Number(rawStat.creditTaxable || 0) * 100) / 100,
    creditCgst: Math.round(creditCgst * 100) / 100,
    creditSgst: Math.round(creditSgst * 100) / 100,
    creditIgst: Math.round(creditIgst * 100) / 100,
    creditGst: Math.round((creditCgst + creditSgst + creditIgst) * 100) / 100,
    creditAmount: Math.round(Number(rawStat.creditAmount || 0) * 100) / 100,
    creditTotalAmount: Math.round(Number(rawStat.creditAmount || 0) * 100) / 100,
    invoiceCount,
    creditCount,
    creditNoteCount: creditCount,
    count: total,
  };

  // Ensure entries have groupDescription populated and backfilled
  entries.forEach((entry) => {
    if (!entry.groupDescription) {
      entry.groupDescription = deduceGstrGroup(entry);
      GstLedger.updateOne(
        { _id: entry._id, $or: [{ groupDescription: null }, { groupDescription: { $exists: false } }, { groupDescription: "" }] },
        { $set: { groupDescription: entry.groupDescription } }
      ).exec().catch(() => {});
    }
  });

  // Opportunistic background backfill for any unassigned legacy records
  if (query.workspaceId && query.companyId) {
    GstLedger.find({
      workspaceId: query.workspaceId,
      companyId: query.companyId,
      $or: [{ groupDescription: null }, { groupDescription: { $exists: false } }, { groupDescription: "" }],
    })
      .limit(100)
      .then((docs) => {
        if (docs && docs.length > 0) {
          docs.forEach((doc) => {
            const group = deduceGstrGroup(doc);
            GstLedger.updateOne({ _id: doc._id }, { $set: { groupDescription: group } }).exec().catch(() => {});
          });
        }
      })
      .catch(() => {});
  }

  return { entries, total, stats, page, limit };
};

const getGstr1Summary = async (workspaceId, companyId, filters = {}, options = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    !mongoose.Types.ObjectId.isValid(companyId)
  ) {
    return { groups: [], totalRow: {}, localSummary: {}, centralSummary: {} };
  }

  const query = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    companyId: new mongoose.Types.ObjectId(companyId),
    gstType: "GSTR-1",
  };

  if (filters.startDate || filters.endDate) {
    query.voucherDate = {};
    if (filters.startDate) {
      query.voucherDate.$gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      query.voucherDate.$lte = new Date(filters.endDate);
    }
  }

  if (filters.branchId && filters.branchId !== "all" && mongoose.Types.ObjectId.isValid(filters.branchId)) {
    const targetBranchId = new mongoose.Types.ObjectId(filters.branchId);
    let voucherIdsForBranch = [];
    try {
      const db = mongoose.connection.db;
      if (db) {
        const invoices = await db.collection("invoices").find({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          companyId: new mongoose.Types.ObjectId(companyId),
          branchId: targetBranchId,
        }).project({ _id: 1 }).toArray();
        voucherIdsForBranch = invoices.map((inv) => inv._id);
      }
    } catch (e) {
      console.error("Error looking up vouchers for branch in getGstr1Summary:", e);
    }

    if (voucherIdsForBranch.length > 0) {
      query.$or = [
        { branchId: targetBranchId },
        { voucherId: { $in: voucherIdsForBranch } },
      ];
    } else {
      query.branchId = targetBranchId;
    }
  }

  if (filters.search && typeof filters.search === "string" && filters.search.trim()) {
    const searchRegex = new RegExp(filters.search.trim(), "i");
    const searchCondition = [{ voucherNumber: searchRegex }, { narration: searchRegex }];
    if (query.$or) {
      query.$and = [
        { $or: query.$or },
        { $or: searchCondition },
      ];
      delete query.$or;
    } else {
      query.$or = searchCondition;
    }
  }

  const entries = await GstLedger.find(query)
    .populate({ path: "partyId", select: "name gstNumber" })
    .lean();

  entries.forEach((entry) => {
    if (!entry.groupDescription) {
      entry.groupDescription = deduceGstrGroup(entry);
      GstLedger.updateOne(
        { _id: entry._id, $or: [{ groupDescription: null }, { groupDescription: { $exists: false } }, { groupDescription: "" }] },
        { $set: { groupDescription: entry.groupDescription } }
      ).exec().catch(() => {});
    }
  });

  return calculateGstr1Summary(entries, {
    companyGstin: options.companyGstin || "",
    b2cLargeThreshold: 250000,
  });
};

const getGstr3bSummary = async (workspaceId, companyId, filters = {}, options = {}) => {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    !mongoose.Types.ObjectId.isValid(companyId)
  ) {
    return calculateGstr3bSummary([], []);
  }

  const baseQuery = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    companyId: new mongoose.Types.ObjectId(companyId),
  };

  if (filters.startDate || filters.endDate) {
    baseQuery.voucherDate = {};
    if (filters.startDate) {
      baseQuery.voucherDate.$gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      baseQuery.voucherDate.$lte = new Date(filters.endDate);
    }
  }

  if (filters.branchId && filters.branchId !== "all" && mongoose.Types.ObjectId.isValid(filters.branchId)) {
    const targetBranchId = new mongoose.Types.ObjectId(filters.branchId);
    let voucherIdsForBranch = [];
    try {
      const db = mongoose.connection.db;
      if (db) {
        const invoices = await db.collection("invoices").find({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          companyId: new mongoose.Types.ObjectId(companyId),
          branchId: targetBranchId,
        }).project({ _id: 1 }).toArray();
        voucherIdsForBranch = invoices.map((inv) => inv._id);
      }
    } catch (e) {
      console.error("Error looking up vouchers for branch in getGstr3bSummary:", e);
    }

    if (voucherIdsForBranch.length > 0) {
      baseQuery.$or = [
        { branchId: targetBranchId },
        { voucherId: { $in: voucherIdsForBranch } },
      ];
    } else {
      baseQuery.branchId = targetBranchId;
    }
  }

  const [gstr1Entries, gstr2Entries] = await Promise.all([
    GstLedger.find({ ...baseQuery, gstType: "GSTR-1" })
      .populate({ path: "partyId", select: "name gstNumber" })
      .lean(),
    GstLedger.find({ ...baseQuery, gstType: "GSTR-2" })
      .populate({ path: "partyId", select: "name gstNumber" })
      .lean(),
  ]);

  return calculateGstr3bSummary(gstr1Entries, gstr2Entries, options);
};

export default {
  createGstLedgerEntry,
  deleteGstLedgerEntriesByVoucherId,
  getGstLedgerEntries,
  getGstr1Summary,
  getGstr3bSummary,
};
