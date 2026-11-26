import mongoose from "mongoose";
import ApiError from "../../../../utils/ApiError.js";
import purchaseReturnRepository from "../repositories/purchaseReturn.repository.js";
import PurchaseReturn from "../models/purchaseReturn.model.js";
import purchaseBillRepository from "../../purchase-bills/repositories/purchaseBill.repository.js";
import PurchaseBill from "../../purchase-bills/models/purchaseBill.model.js";
import Batch from "../../products/models/batch.model.js";
import ProductFacility from "../../products/models/productFacility.model.js";
import WorkspaceProduct from "../../products/models/workspaceProduct.model.js";
import Supplier from "../../../parties/suppliers/models/supplier.model.js";
import Customer from "../../../parties/customers/models/customer.model.js";
import Company from "../../../organization/companies/models/company.model.js";
import Branch from "../../../organization/branches/models/branch.model.js";
import SalesInvoice from "../../../sales/invoices/models/invoice.model.js";
import branchRepository from "../../../organization/branches/repositories/branch.repository.js";
import gstLedgerRepository from "../../../finance/gst-ledger/repositories/gstLedger.repository.js";
import financialPeriodRepository from "../../../finance/financial-periods/repositories/financialPeriod.repository.js";
import journalVoucherService from "../../../finance/journal-vouchers/services/journalVoucher.service.js";
import journalPostingService from "../../../finance/journal-vouchers/services/journalPosting.service.js";
import JournalVoucher from "../../../finance/journal-vouchers/models/journalVoucher.model.js";
import Ledger from "../../../finance/ledger/models/ledger.model.js";
import { ensureSupplierLedgerAccount } from "../../../parties/suppliers/services/supplier.service.js";
import Account from "../../../finance/chart-of-accounts/models/account.model.js";
import CreditNote from "../../../sales/credit-notes/models/creditNote.model.js";
import { CREDIT_NOTE_SOURCE, CREDIT_NOTE_STATUS } from "../../../sales/credit-notes/constants/creditNote.constant.js";
import { VOUCHER_TYPE } from "../../../finance/journal-vouchers/constants/voucherType.constant.js";
import { VOUCHER_STATUS } from "../../../finance/journal-vouchers/constants/voucherStatus.constant.js";
import {
  PURCHASE_RETURN_STATUS,
  RETURN_MOTIVE,
  SETTLEMENT_TYPE,
  SETTLEMENT_STATUS,
} from "../constants/purchaseReturn.constant.js";

/**
 * Format expiry MM/YY
 */
const formatExpiry = (val) => {
  if (!val) return "";
  let str = String(val).trim();
  if (/^\d{2}\/\d{2}$/.test(str)) return str;
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const mm = String(parsed.getMonth() + 1).padStart(2, "0");
    const yy = String(parsed.getFullYear()).slice(-2);
    return `${mm}/${yy}`;
  }
  return str;
};

const escapeRegex = (str) =>
  String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stripBatchTags = (batchNo) =>
  String(batchNo || "")
    .replace(/\s*\[(EXPIRED|BROKEN|SCRAP|IN|INCOMING|FRESH_RETURN)\]/gi, "")
    .trim();

/**
 * Dynamically resolves whether a chosen Supplier corresponds to an active Company
 * within the same workspace (an inter-company supplier relationship).
 *
 * Checks:
 * 1. Normalized GSTIN matching (supplier.gstNumber === company.gstin/gstNumber)
 * 2. Exact or normalized business name / legal name matching
 * 3. Returns { company, branch } if matched, or null if external vendor
 */
export const resolveInterCompanyDestination = async ({
  workspaceId,
  currentCompanyId,
  supplier,
  supplierId = null,
}) => {
  if (!workspaceId || !currentCompanyId) return null;
  const currentCompanyObjId = new mongoose.Types.ObjectId(currentCompanyId);
  const workspaceObjId = new mongoose.Types.ObjectId(workspaceId);

  let targetSupplier = supplier;
  if (!targetSupplier && supplierId && mongoose.Types.ObjectId.isValid(supplierId)) {
    targetSupplier = await Supplier.findOne({
      _id: supplierId,
      workspaceId: workspaceObjId,
      isDeleted: false,
    }).lean();
  }

  if (!targetSupplier) return null;

  const workspaceCompanies = await Company.find({
    workspaceId: workspaceObjId,
    _id: { $ne: currentCompanyObjId },
    isDeleted: false,
  })
    .select("_id name legalName gstin gstNumber code address phone")
    .lean();

  if (!workspaceCompanies || workspaceCompanies.length === 0) return null;

  const suppGst = (targetSupplier.gstNumber || "").trim().toUpperCase();
  const suppName = (
    targetSupplier.businessName ||
    targetSupplier.name ||
    ""
  ).trim().toLowerCase();

  const normalizeName = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

  const suppNorm = normalizeName(suppName);

  let matchedCompany = null;
  for (const comp of workspaceCompanies) {
    const compGst = (comp.gstin || comp.gstNumber || "").trim().toUpperCase();
    if (suppGst && compGst && suppGst === compGst) {
      matchedCompany = comp;
      break;
    }

    const compName = (comp.name || "").trim().toLowerCase();
    const compLegal = (comp.legalName || "").trim().toLowerCase();
    if (suppName) {
      if (compName && suppName === compName) {
        matchedCompany = comp;
        break;
      }
      if (compLegal && suppName === compLegal) {
        matchedCompany = comp;
        break;
      }
      const cNorm = normalizeName(compName);
      const cLegalNorm = normalizeName(compLegal);
      if (suppNorm && (suppNorm === cNorm || suppNorm === cLegalNorm)) {
        matchedCompany = comp;
        break;
      }
    }
  }

  if (!matchedCompany) return null;

  let matchedBranch = null;
  try {
    const branches = await Branch.find({
      workspaceId: workspaceObjId,
      companyId: matchedCompany._id,
      isDeleted: false,
    })
      .select("_id name branchCode isDefault address phone")
      .lean();

    matchedBranch =
      branches.find((b) => b.isDefault) || branches[0] || null;
  } catch {
    // non-blocking
  }

  return {
    company: matchedCompany,
    branch: matchedBranch,
  };
};

/**
 * Resolve the original PurchaseBill belonging to `destCompanyId` (e.g. Agam's purchase from Aristo)
 * when an inter-company returned consignment arrives from another company (e.g. Pahuch).
 *
 * Resolution chain:
 * 1. Trace Pahuch's PurchaseBill number (supplierInvoiceNo / purchaseBillNo) against
 *    destCompanyId's SalesInvoice (invoiceNo) to find the exact sold batch in destCompanyId,
 *    then follow that batch's purchaseBillId (verified companyId === destCompanyId).
 * 2. Look up destCompanyId's own non-incoming Batch for (productId, cleanBatchNo) with a
 *    valid destCompanyId PurchaseBill.
 * 3. Look up destCompanyId's PurchaseBill strictly scoped to companyId === destCompanyId
 *    matching (productId + cleanBatchNo), then fallback to productId only.
 */
export const resolveOriginalPurchaseBillForDestination = async ({
  workspaceId,
  destCompanyId,
  destBranchId = null,
  productId,
  batchNo = "",
  sourcePurchaseBillId = null,
  candidateInvoiceNos = [],
  sourceConsignmentId = null,
  session = null,
}) => {
  if (!workspaceId || !destCompanyId || !productId) return null;

  const cleanBatch = stripBatchTags(batchNo);
  const destCompanyObjId = new mongoose.Types.ObjectId(destCompanyId);
  const workspaceObjId = new mongoose.Types.ObjectId(workspaceId);
  const productObjId = new mongoose.Types.ObjectId(productId);
  const sessionOpt = session || null;

  const invoiceNoSet = new Set();
  for (const num of candidateInvoiceNos || []) {
    const trimmed = String(num || "").trim();
    if (trimmed) invoiceNoSet.add(trimmed);
  }

  // Gather candidate invoice numbers from sourcePurchaseBillId if provided
  if (sourcePurchaseBillId && mongoose.Types.ObjectId.isValid(sourcePurchaseBillId)) {
    try {
      const srcBill = await PurchaseBill.findById(sourcePurchaseBillId)
        .select("companyId supplierId purchaseBillNo supplierInvoiceNo invoiceDate items")
        .populate("supplierId", "businessName name gstNumber mobile phone email address")
        .session(sessionOpt)
        .lean();

      if (srcBill) {
        // Intra-company transfer: if the source purchase bill already belongs to destCompanyId, use it directly
        if (String(srcBill.companyId) === String(destCompanyObjId)) {
          return srcBill;
        }
        if (srcBill.supplierInvoiceNo) {
          invoiceNoSet.add(String(srcBill.supplierInvoiceNo).trim());
        }
        if (srcBill.purchaseBillNo) {
          invoiceNoSet.add(String(srcBill.purchaseBillNo).trim());
        }
      }
    } catch {
      // non-blocking
    }
  }

  // Gather candidate invoice numbers from sourceConsignmentId if still empty
  if (invoiceNoSet.size === 0 && sourceConsignmentId && mongoose.Types.ObjectId.isValid(sourceConsignmentId)) {
    try {
      const consignment = await PurchaseReturn.findById(sourceConsignmentId)
        .select("items")
        .session(sessionOpt)
        .lean();

      if (consignment?.items?.length) {
        const matchedItem =
          consignment.items.find(
            (i) =>
              String(i.productId) === String(productObjId) &&
              cleanBatch &&
              stripBatchTags(i.batchNo).toLowerCase() === cleanBatch.toLowerCase()
          ) ||
          consignment.items.find((i) => String(i.productId) === String(productObjId));

        if (matchedItem?.purchaseBillNo) {
          invoiceNoSet.add(String(matchedItem.purchaseBillNo).trim());
        }
        if (matchedItem?.purchaseBillId && mongoose.Types.ObjectId.isValid(matchedItem.purchaseBillId)) {
          const itemSrcBill = await PurchaseBill.findById(matchedItem.purchaseBillId)
            .select("companyId purchaseBillNo supplierInvoiceNo")
            .session(sessionOpt)
            .lean();
          if (itemSrcBill) {
            if (itemSrcBill.supplierInvoiceNo) {
              invoiceNoSet.add(String(itemSrcBill.supplierInvoiceNo).trim());
            }
            if (itemSrcBill.purchaseBillNo) {
              invoiceNoSet.add(String(itemSrcBill.purchaseBillNo).trim());
            }
          }
        }
      }
    } catch {
      // non-blocking
    }
  }

  let resolvedBatchNoForCompany = cleanBatch;

  // ── TIER 1: Trace Sale Bill in destCompanyId (Agam) using Pahuch's Purchase Bill number ──
  if (invoiceNoSet.size > 0) {
    try {
      const invoiceRegexes = Array.from(invoiceNoSet).map(
        (n) => new RegExp(`^${escapeRegex(n)}$`, "i")
      );
      const saleBill = await SalesInvoice.findOne({
        workspaceId: workspaceObjId,
        companyId: destCompanyObjId,
        invoiceNo: { $in: invoiceRegexes },
        isDeleted: { $ne: true },
      })
        .select("invoiceNo branchId items")
        .session(sessionOpt)
        .lean();

      if (saleBill && Array.isArray(saleBill.items)) {
        const soldItem =
          saleBill.items.find((si) => {
            const siProd = String(si.productId || si.product || si._id || si.id || "");
            const siBatch = stripBatchTags(si.batch || si.batchNo || "").toLowerCase();
            return (
              siProd === String(productObjId) &&
              cleanBatch &&
              siBatch === cleanBatch.toLowerCase()
            );
          }) ||
          saleBill.items.find((si) => {
            const siProd = String(si.productId || si.product || si._id || si.id || "");
            return siProd === String(productObjId);
          });

        if (soldItem) {
          const soldCleanBatch = stripBatchTags(soldItem.batch || soldItem.batchNo || "");
          if (soldCleanBatch) {
            resolvedBatchNoForCompany = soldCleanBatch;
          }

          if (soldItem.batchId && mongoose.Types.ObjectId.isValid(soldItem.batchId)) {
            const soldOriginBatch = await Batch.findById(soldItem.batchId)
              .select("purchaseBillId batchNo originalBatchNo")
              .session(sessionOpt)
              .lean();

            if (soldOriginBatch?.purchaseBillId) {
              const originBill = await PurchaseBill.findOne({
                _id: soldOriginBatch.purchaseBillId,
                companyId: destCompanyObjId,
                isDeleted: false,
              })
                .populate("supplierId", "businessName name gstNumber mobile phone email address")
                .select("companyId supplierId purchaseBillNo supplierInvoiceNo invoiceDate items")
                .session(sessionOpt)
                .lean();

              if (originBill?.supplierId) {
                return originBill;
              }
            }
          }
        }
      }
    } catch {
      // non-blocking
    }
  }

  // ── TIER 2: Check destCompanyId's own non-incoming Batch for this product + clean batchNo ──
  if (resolvedBatchNoForCompany) {
    try {
      const destBranches = destBranchId && mongoose.Types.ObjectId.isValid(destBranchId)
        ? [new mongoose.Types.ObjectId(destBranchId)]
        : (
            await Branch.find({ companyId: destCompanyObjId, isDeleted: false })
              .select("_id")
              .session(sessionOpt)
              .lean()
          ).map((b) => b._id);

      if (destBranches.length > 0) {
        const batchRegex = new RegExp(`^${escapeRegex(resolvedBatchNoForCompany)}$`, "i");
        const localBatch = await Batch.findOne({
          workspaceId: workspaceObjId,
          branch_id: { $in: destBranches },
          product: productObjId,
          isIncoming: { $ne: true },
          purchaseBillId: { $ne: null },
          $or: [{ batchNo: batchRegex }, { originalBatchNo: batchRegex }],
        })
          .select("purchaseBillId")
          .session(sessionOpt)
          .lean();

        if (localBatch?.purchaseBillId) {
          const localBill = await PurchaseBill.findOne({
            _id: localBatch.purchaseBillId,
            companyId: destCompanyObjId,
            isDeleted: false,
          })
            .populate("supplierId", "businessName name gstNumber mobile phone email address")
            .select("companyId supplierId purchaseBillNo supplierInvoiceNo invoiceDate items")
            .session(sessionOpt)
            .lean();

          if (localBill?.supplierId) {
            return localBill;
          }
        }
      }
    } catch {
      // non-blocking
    }
  }

  // ── TIER 3: Strictly company-scoped PurchaseBill lookup in destCompanyId (batch match -> product match) ──
  if (resolvedBatchNoForCompany) {
    const batchRegex = new RegExp(`^${escapeRegex(resolvedBatchNoForCompany)}$`, "i");
    const exactBill = await PurchaseBill.findOne({
      workspaceId: workspaceObjId,
      companyId: destCompanyObjId,
      isDeleted: false,
      items: {
        $elemMatch: {
          productId: productObjId,
          batch: batchRegex,
        },
      },
    })
      .populate("supplierId", "businessName name gstNumber mobile phone email address")
      .sort({ invoiceDate: -1, createdAt: -1 })
      .select("companyId supplierId purchaseBillNo supplierInvoiceNo invoiceDate items")
      .session(sessionOpt)
      .lean();

    if (exactBill?.supplierId) {
      return exactBill;
    }
  }

  // Final fallback: latest PurchaseBill for this product strictly within destCompanyId
  const productBill = await PurchaseBill.findOne({
    workspaceId: workspaceObjId,
    companyId: destCompanyObjId,
    isDeleted: false,
    "items.productId": productObjId,
  })
    .populate("supplierId", "businessName name gstNumber mobile phone email address")
    .sort({ invoiceDate: -1, createdAt: -1 })
    .select("companyId supplierId purchaseBillNo supplierInvoiceNo invoiceDate items")
    .session(sessionOpt)
    .lean();

  return productBill || null;
};

/**
 * Resolve the upstream / original "Sub Supplier" (e.g. Aristo) when the current company (e.g. Pahuch)
 * purchased the item from an inter-company supplier (e.g. Agam) or when the batch originated
 * through an inter-company transfer or central warehouse.
 */
export const resolveSubSupplierFromPurchaseBill = async ({
  workspaceId,
  currentCompanyId,
  productId,
  batchNo = "",
  purchaseBill = null,
  batchDoc = null,
  mainSupplier = null,
}) => {
  if (!workspaceId || !currentCompanyId || !productId) return null;

  try {
    const workspaceObjId = new mongoose.Types.ObjectId(workspaceId);
    const currentCompanyObjId = new mongoose.Types.ObjectId(currentCompanyId);
    const productObjId = new mongoose.Types.ObjectId(productId);
    const cleanBatch = stripBatchTags(
      batchNo || batchDoc?.originalBatchNo || batchDoc?.batchNo || ""
    );
    const batchRegex = cleanBatch
      ? new RegExp(`^${escapeRegex(cleanBatch)}$`, "i")
      : null;

    const resolvedMainSupplier =
      mainSupplier || purchaseBill?.supplierId || null;

    // Fetch workspace companies to identify internal company names/IDs/GSTINs
    let workspaceCompanies = [];
    try {
      if (
        mongoose.connection.readyState !== 0 ||
        typeof Company.find?.mockReturnValue === "function"
      ) {
        workspaceCompanies =
          (await Company.find({
            workspaceId: workspaceObjId,
            isDeleted: { $ne: true },
          })
            .select("_id name legalName gstNumber")
            .lean()) || [];
      }
    } catch {
      workspaceCompanies = [];
    }

    const internalCompanyNames = new Set();
    const internalCompanyIds = new Set([String(currentCompanyObjId)]);
    const internalCompanyGsts = new Set();

    (workspaceCompanies || []).forEach((c) => {
      if (c._id) internalCompanyIds.add(String(c._id));
      if (c.name) internalCompanyNames.add(c.name.trim().toLowerCase());
      if (c.legalName) internalCompanyNames.add(c.legalName.trim().toLowerCase());
      if (c.gstNumber) internalCompanyGsts.add(c.gstNumber.trim().toUpperCase());
    });

    const isInternalCompany = (cand) => {
      if (!cand) return false;
      const cId = cand._id
        ? String(cand._id)
        : typeof cand === "string" && mongoose.Types.ObjectId.isValid(cand)
        ? String(cand)
        : null;
      if (cId && internalCompanyIds.has(cId)) return true;

      const cName = (
        cand.businessName ||
        cand.name ||
        (typeof cand === "string" ? cand : "")
      )
        .trim()
        .toLowerCase();
      if (cName && internalCompanyNames.has(cName)) return true;

      const cGst = (cand.gstNumber || "").trim().toUpperCase();
      if (cGst && internalCompanyGsts.has(cGst)) return true;

      return false;
    };

    // If the batch has a direct purchase bill belonging to currentCompanyId, and its supplier is an external vendor:
    // That vendor IS the primary/respective supplier (e.g. Galaxy or Basant in Agam). There is NO sub-supplier!
    const pbCompanyId =
      purchaseBill?.companyId?._id || purchaseBill?.companyId || null;
    const isDirectBillOfCurrentCompany =
      pbCompanyId && String(pbCompanyId) === String(currentCompanyObjId);

    const directSupplier = purchaseBill?.supplierId || null;
    if (
      isDirectBillOfCurrentCompany &&
      directSupplier &&
      typeof directSupplier === "object" &&
      !isInternalCompany(directSupplier)
    ) {
      return null;
    }

    const isDifferentSupplier = (candidateDoc) => {
      if (!candidateDoc || typeof candidateDoc !== "object") return false;
      // An internal workspace company (like Agam or Pahuch) can NEVER be a sub-supplier
      if (isInternalCompany(candidateDoc)) return false;

      const candName = (
        candidateDoc.businessName ||
        candidateDoc.name ||
        ""
      )
        .trim()
        .toLowerCase();
      if (!candName) return false;

      const mainName = (
        resolvedMainSupplier?.businessName ||
        resolvedMainSupplier?.name ||
        (typeof resolvedMainSupplier === "string" ? resolvedMainSupplier : "")
      )
        .trim()
        .toLowerCase();

      const mainId = resolvedMainSupplier?._id
        ? String(resolvedMainSupplier._id)
        : typeof resolvedMainSupplier === "string" &&
          mongoose.Types.ObjectId.isValid(resolvedMainSupplier)
        ? String(resolvedMainSupplier)
        : null;
      const candId = candidateDoc._id ? String(candidateDoc._id) : null;

      if (mainId && candId && mainId === candId) return false;
      if (mainName && candName === mainName) return false;

      return true;
    };

    // ── TIER 1: Match upstream SalesInvoice via purchaseBill supplierInvoiceNo / purchaseBillNo ──
    if (purchaseBill) {
      const invoiceNoSet = new Set();
      if (purchaseBill.supplierInvoiceNo) {
        invoiceNoSet.add(String(purchaseBill.supplierInvoiceNo).trim());
      }
      if (purchaseBill.purchaseBillNo) {
        invoiceNoSet.add(String(purchaseBill.purchaseBillNo).trim());
      }

      if (invoiceNoSet.size > 0) {
        const invoiceRegexes = Array.from(invoiceNoSet).map(
          (n) => new RegExp(`^${escapeRegex(n)}$`, "i")
        );

        const upstreamSaleBill = await SalesInvoice.findOne({
          workspaceId: workspaceObjId,
          companyId: { $ne: currentCompanyObjId },
          invoiceNo: { $in: invoiceRegexes },
          isDeleted: { $ne: true },
        })
          .select("companyId branchId invoiceNo items")
          .lean();

        if (upstreamSaleBill?.companyId) {
          const upstreamBill = await resolveOriginalPurchaseBillForDestination({
            workspaceId,
            destCompanyId: upstreamSaleBill.companyId,
            destBranchId: upstreamSaleBill.branchId || null,
            productId,
            batchNo: cleanBatch,
            candidateInvoiceNos: [upstreamSaleBill.invoiceNo],
          });

          const subDoc = upstreamBill?.supplierId || null;
          if (subDoc && isDifferentSupplier(subDoc)) {
            return {
              subSupplier: subDoc,
              subSupplierId: subDoc._id ? String(subDoc._id) : null,
              subSupplierName: (subDoc.businessName || subDoc.name || "").trim(),
              subSupplierGst: subDoc.gstNumber || "",
            };
          }
        }
      }
    }

    // ── TIER 2: Match Batch provenance in another company in workspace (e.g. Agam) ──
    if (cleanBatch) {
      const otherBranches = await Branch.find({
        workspaceId: workspaceObjId,
        companyId: { $ne: currentCompanyObjId },
        isDeleted: false,
      })
        .select("_id companyId")
        .lean();

      if (otherBranches.length > 0) {
        const otherBranchIds = otherBranches.map((b) => b._id);
        const upstreamBatch = await Batch.findOne({
          workspaceId: workspaceObjId,
          branch_id: { $in: otherBranchIds },
          product: productObjId,
          isIncoming: { $ne: true },
          purchaseBillId: { $ne: null },
          $or: [{ batchNo: batchRegex }, { originalBatchNo: batchRegex }],
        })
          .select("purchaseBillId branch_id")
          .lean();

        if (upstreamBatch?.purchaseBillId) {
          const upstreamBill = await PurchaseBill.findOne({
            _id: upstreamBatch.purchaseBillId,
            isDeleted: false,
          })
            .populate(
              "supplierId",
              "businessName name gstNumber mobile phone email address"
            )
            .select("companyId supplierId purchaseBillNo supplierInvoiceNo invoiceDate items")
            .lean();

          const subDoc = upstreamBill?.supplierId || null;
          if (subDoc && isDifferentSupplier(subDoc)) {
            return {
              subSupplier: subDoc,
              subSupplierId: subDoc._id ? String(subDoc._id) : null,
              subSupplierName: (subDoc.businessName || subDoc.name || "").trim(),
              subSupplierGst: subDoc.gstNumber || "",
            };
          }
        }
      }
    }

    // ── TIER 3: Match PurchaseBill directly in another company in workspace by productId + batch ──
    if (cleanBatch) {
      const directBillWithBatch = await PurchaseBill.findOne({
        workspaceId: workspaceObjId,
        companyId: { $ne: currentCompanyObjId },
        isDeleted: false,
        items: {
          $elemMatch: {
            productId: productObjId,
            batch: batchRegex,
          },
        },
      })
        .populate(
          "supplierId",
          "businessName name gstNumber mobile phone email address"
        )
        .sort({ invoiceDate: -1, createdAt: -1 })
        .select("companyId supplierId purchaseBillNo supplierInvoiceNo invoiceDate items")
        .lean();

      const subDoc = directBillWithBatch?.supplierId || null;
      if (subDoc && isDifferentSupplier(subDoc)) {
        return {
          subSupplier: subDoc,
          subSupplierId: subDoc._id ? String(subDoc._id) : null,
          subSupplierName: (subDoc.businessName || subDoc.name || "").trim(),
          subSupplierGst: subDoc.gstNumber || "",
        };
      }
    }

    // ── TIER 4: Match latest PurchaseBill for this product in another company in workspace ──
    const latestOtherBill = await PurchaseBill.findOne({
      workspaceId: workspaceObjId,
      companyId: { $ne: currentCompanyObjId },
      isDeleted: false,
      "items.productId": productObjId,
    })
      .populate(
        "supplierId",
        "businessName name gstNumber mobile phone email address"
      )
      .sort({ invoiceDate: -1, createdAt: -1 })
      .select("companyId supplierId purchaseBillNo supplierInvoiceNo invoiceDate items")
      .lean();

    const subDoc = latestOtherBill?.supplierId || null;
    if (subDoc && isDifferentSupplier(subDoc)) {
      return {
        subSupplier: subDoc,
        subSupplierId: subDoc._id ? String(subDoc._id) : null,
        subSupplierName: (subDoc.businessName || subDoc.name || "").trim(),
        subSupplierGst: subDoc.gstNumber || "",
      };
    }

    return null;
  } catch {
    return null;
  }
};

/**
 * Search and resolve batches in branch with FIFO purchase rate lookup
 */
const getEligibleBatchesForReturn = async (
  workspaceId,
  companyId,
  branchId,
  options = {}
) => {
  const { supplierId, search, sourceBin = "ALL", limit = 50 } = options;

  let resolvedBranchId = branchId;
  if (!resolvedBranchId) {
    const defaultBranch = await branchRepository.getDefaultBranch(workspaceId);
    resolvedBranchId = defaultBranch?._id || null;
  }

  // 1. Build Batch query
  const batchQuery = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
  };

  if (resolvedBranchId) {
    batchQuery.branch_id = new mongoose.Types.ObjectId(resolvedBranchId);
  }

  if (sourceBin === "SCRAP" || sourceBin === "EXPIRED" || sourceBin === "BROKEN" || sourceBin === "FRESH") {
    batchQuery.scrapQty = { $gt: 0 };
    if (sourceBin === "EXPIRED") batchQuery.expiredQty = { $gt: 0 };
    if (sourceBin === "BROKEN") batchQuery.brokenQty = { $gt: 0 };
  } else if (sourceBin === "SELLABLE") {
    batchQuery.batchQty = { $gt: 0 };
  } else {
    // ALL: either sellable or scrap stock > 0
    batchQuery.$or = [{ batchQty: { $gt: 0 } }, { scrapQty: { $gt: 0 } }];
  }

  if (search) {
    const escapedSearch = escapeRegex(search.trim());
    const cleanSearch = escapeRegex(stripBatchTags(search.trim()));
    batchQuery.$and = batchQuery.$and || [];
    batchQuery.$and.push({
      $or: [
        { batchNo: { $regex: escapedSearch, $options: "i" } },
        { originalBatchNo: { $regex: cleanSearch || escapedSearch, $options: "i" } },
      ],
    });
  }

  const batches = await Batch.find(batchQuery)
    .populate({
      path: "product",
      select: "name itemCode pack hsn hsnTaxpercent mrp pts ptr",
    })
    .limit(Number(limit))
    .lean();

  // 2. Enrich with Purchase Bill Inflow history (strictly scoped to current companyId)
  const enrichedBatches = await Promise.all(
    batches.map(async (batch) => {
      const product = batch.product || {};
      const productId = product._id || batch.product;
      const cleanBatchNo = stripBatchTags(batch.originalBatchNo || batch.batchNo);
      const batchRegex = cleanBatchNo ? new RegExp(`^${escapeRegex(cleanBatchNo)}$`, "i") : null;

      let inflowBill = null;
      let inflowItem = null;

      // For incoming batches or batches whose purchaseBillId belongs to another company,
      // resolve through the inter-company Sale Bill -> original Purchase Bill chain first.
      if (!supplierId && companyId) {
        const resolvedBill = await resolveOriginalPurchaseBillForDestination({
          workspaceId,
          destCompanyId: companyId,
          destBranchId: resolvedBranchId,
          productId,
          batchNo: cleanBatchNo,
          sourcePurchaseBillId: batch.purchaseBillId || null,
          sourceConsignmentId: batch.sourceConsignmentId || null,
        });
        if (resolvedBill) {
          inflowBill = resolvedBill;
        }
      }

      if (!inflowBill) {
        // Find matching purchase bills strictly scoped to current companyId
        const billFilter = {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          isDeleted: false,
        };

        if (companyId) {
          billFilter.companyId = new mongoose.Types.ObjectId(companyId);
        }

        if (supplierId) {
          billFilter.supplierId = new mongoose.Types.ObjectId(supplierId);
        }

        if (batch.purchaseBillId) {
          billFilter.$or = [
            { _id: new mongoose.Types.ObjectId(batch.purchaseBillId) },
            ...(batchRegex
              ? [{ items: { $elemMatch: { productId, batch: batchRegex } } }]
              : []),
          ];
        } else if (batchRegex) {
          billFilter.items = { $elemMatch: { productId, batch: batchRegex } };
        } else {
          billFilter["items.productId"] = productId;
        }

        let matchingBills = await PurchaseBill.find(billFilter)
          .populate("supplierId", "businessName name gstNumber mobile phone email address")
          .sort({ invoiceDate: -1, createdAt: -1 })
          .limit(5)
          .lean();

        // Fallback: If no bill matched by batch number, find any purchase bill for this product in current company
        if (matchingBills.length === 0 && !supplierId) {
          const fallbackFilter = {
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            isDeleted: false,
            "items.productId": productId,
          };
          if (companyId) {
            fallbackFilter.companyId = new mongoose.Types.ObjectId(companyId);
          }
          const productBills = await PurchaseBill.find(fallbackFilter)
            .populate("supplierId", "businessName name gstNumber mobile phone email address")
            .sort({ invoiceDate: -1, createdAt: -1 })
            .limit(1)
            .lean();
          if (productBills.length > 0) {
            matchingBills = productBills;
          }
        }

        if (matchingBills.length > 0) {
          if (batch.purchaseBillId) {
            inflowBill = matchingBills.find(
              (b) => String(b._id) === String(batch.purchaseBillId)
            );
          }
          if (!inflowBill) {
            inflowBill = matchingBills[0];
          }
        }
      }

      if (inflowBill && Array.isArray(inflowBill.items)) {
        inflowItem =
          inflowBill.items.find(
            (i) =>
              String(i.productId) === String(productId) &&
              cleanBatchNo &&
              stripBatchTags(i.batch).toLowerCase() === cleanBatchNo.toLowerCase()
          ) ||
          inflowBill.items.find(
            (i) => String(i.productId) === String(productId)
          ) ||
          inflowBill.items[0];
      }

      const billedQty = Number(inflowItem?.qty || 0);
      const freeQty = Number(inflowItem?.freeQty || 0);
      const totalInflowQty = billedQty + freeQty;
      const taxableAmount = Number(inflowItem?.amount || 0);
      const effectiveRate =
        totalInflowQty > 0
          ? Number((taxableAmount / totalInflowQty).toFixed(2))
          : Number(batch.rate || product.pts || 0);

      const gstPct = Number(
        inflowItem?.gst || product.hsnTaxpercent || 0
      );

      // Compute already returned qty for this bill & batch
      let alreadyReturnedQty = 0;
      if (inflowBill) {
        const previousReturns = await purchaseReturnRepository.getReturnsForBill(
          inflowBill._id,
          workspaceId
        );
        for (const pr of previousReturns) {
          for (const item of pr.items || []) {
            if (
              String(item.batchId) === String(batch._id) ||
              (String(item.productId) === String(productId) &&
                item.batchNo === batch.batchNo)
            ) {
              alreadyReturnedQty += Number(item.returnQty || 0);
            }
          }
        }
      }

      const unreturnedBillQuota =
        totalInflowQty > 0 ? Math.max(0, totalInflowQty - alreadyReturnedQty) : 999999;

      const availableShelfStock = Math.max(
        0,
        (batch.batchQty || 0) - (batch.totalReservedBatchQty || 0)
      );
      const availableScrapStock = batch.scrapQty || 0;
      const expiredStock = batch.expiredQty || 0;
      const brokenStock = batch.brokenQty || 0;

      let subSupplierMeta = null;
      if (inflowBill && companyId) {
        subSupplierMeta = await resolveSubSupplierFromPurchaseBill({
          workspaceId,
          currentCompanyId: companyId,
          productId,
          batchNo: cleanBatchNo,
          purchaseBill: inflowBill,
        });
      }

      return {
        batchId: batch._id,
        productId,
        productName: product.name || "Unknown Product",
        itemCode: product.itemCode || "",
        pack: product.pack || "",
        batchNo: batch.originalBatchNo || stripBatchTags(batch.batchNo),
        rawBatchNo: batch.batchNo,
        originalBatchNo: batch.originalBatchNo || stripBatchTags(batch.batchNo),
        expiry: batch.expiryDate || "",
        mrp: batch.mrp || product.mrp || 0,
        rate: effectiveRate,
        gstPct,
        availableShelfStock,
        availableScrapStock,
        expiredStock,
        brokenStock,
        unreturnedBillQuota,
        supplier: inflowBill?.supplierId || null,
        supplierId: inflowBill?.supplierId?._id || null,
        supplierName: inflowBill?.supplierId?.businessName || inflowBill?.supplierId?.name || "",
        subSupplier: subSupplierMeta?.subSupplier || null,
        subSupplierId: subSupplierMeta?.subSupplierId || null,
        subSupplierName: subSupplierMeta?.subSupplierName || "",
        subSupplierGst: subSupplierMeta?.subSupplierGst || "",
        purchaseBillId: inflowBill?._id || null,
        purchaseBillNo: inflowBill?.purchaseBillNo || "",
        purchaseBillDate: inflowBill?.invoiceDate || "",
      };
    })
  );

  return enrichedBatches;
};

/**
 * Materialize or sync with CreditNote collection so it appears on /sales/credit-notes
 */
export const syncCreditNoteDocument = async (returnDoc, creditNoteNoToSet) => {
  if (!returnDoc || !creditNoteNoToSet) return null;
  const supp = returnDoc.supplierId || {};
  const workspaceId = returnDoc.workspaceId?._id || returnDoc.workspaceId;
  const companyId = returnDoc.companyId?._id || returnDoc.companyId;
  const branchId = returnDoc.branchId?._id || returnDoc.branchId || null;
  const supplierId = supp._id || returnDoc.supplierId?._id || returnDoc.supplierId || returnDoc.shippingDetails?.destinationSupplierId?._id || returnDoc.shippingDetails?.destinationSupplierId || null;

  return CreditNote.findOneAndUpdate(
    {
      workspaceId,
      companyId,
      sourceReturnId: returnDoc._id,
      source: CREDIT_NOTE_SOURCE.PURCHASE_RETURN,
    },
    {
      $set: {
        workspaceId,
        companyId,
        branchId,
        creditNoteNo: creditNoteNoToSet,
        partyType: "SUPPLIER",
        customerId: null,
        supplierId,
        supplierName: supp.businessName || supp.name || "Supplier",
        supplierPhone: supp.mobile || supp.phone || null,
        supplierGst: supp.gstNumber || null,
        billingMode: "B2B",
        source: CREDIT_NOTE_SOURCE.PURCHASE_RETURN,
        sourceReturnModel: "PurchaseReturn",
        sourceReturnId: returnDoc._id,
        sourceReturnNo: returnDoc.debitNoteNo || returnDoc.returnNo,
        subtotal: returnDoc.taxableSubtotal || 0,
        discount: 0,
        tax: returnDoc.totalGst || 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        roundOff: returnDoc.roundOff || 0,
        totalAmount: returnDoc.grandTotal || 0,
        redeemedAmount: 0,
        balanceAmount: returnDoc.grandTotal || 0,
        status: CREDIT_NOTE_STATUS.ACTIVE,
        issueDate: returnDoc.creditNoteDate || returnDoc.returnDate || new Date(),
        items: (returnDoc.items || []).map((it) => ({
          productId: it.productId,
          productName: it.productName,
          pack: it.pack,
          batchNo: it.batchNo,
          batchNumber: it.batchNo,
          batch: it.batchNo,
          expiry: it.expiry || "",
          expiryDate: it.expiry || "",
          qty: it.returnQty,
          quantity: it.returnQty,
          rate: it.rate,
          unitPrice: it.rate,
          taxableAmount: it.taxableAmount,
          gstPct: it.gstPct,
          gstRate: it.gstPct,
          totalAmount: it.totalAmount,
          total: it.totalAmount,
        })),
        notes: `Purchase Return Credit Note for #${returnDoc.debitNoteNo || returnDoc.returnNo}`,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

/**
 * Create a new Purchase Return & issue Debit Note (Atomic Transaction)
 */
const createPurchaseReturn = async (
  workspaceId,
  companyId,
  branchId,
  userId,
  payload
) => {
  const {
    supplierId,
    returnDate,
    returnMotive = RETURN_MOTIVE.SELLABLE,
    settlementType = SETTLEMENT_TYPE.DEBIT_NOTE,
    items,
    adjustedPurchaseBillId = null,
    reason = "",
    remarks = "",
  } = payload;

  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "Purchase return must contain at least one item");
  }

  const isInterBranch =
    Boolean(payload.isInterBranch) ||
    Boolean(payload.sourceBranchId && !supplierId);

  if (!supplierId && !isInterBranch) {
    throw new ApiError(400, "Supplier is required");
  }

  if (isInterBranch && !supplierId && !payload.sourceBranchId) {
    throw new ApiError(400, "Source branch is required for inter-branch credit note");
  }

  // 1. Resolve Branch
  let resolvedBranchId = branchId;
  let branchCode = "BR01";
  if (!resolvedBranchId) {
    try {
      const activeBranches = await branchRepository.getCompanyBranches(companyId);
      if (Array.isArray(activeBranches) && activeBranches.length > 0) {
        resolvedBranchId = activeBranches[0]._id;
        branchCode = activeBranches[0].branchCode || branchCode;
      }
    } catch (bErr) {}
  } else {
    try {
      const branchDoc = await branchRepository.findBranchById(resolvedBranchId);
      if (branchDoc && branchDoc.branchCode) {
        branchCode = branchDoc.branchCode;
      }
    } catch (bErr) {}
  }

  if (!resolvedBranchId) {
    throw new ApiError(400, "Active branch facility is required");
  }

  // 2. Fetch Supplier & Company for GST & Financial Ledger details
  let supplier = null;
  let company = null;

  if (supplierId) {
    [supplier, company] = await Promise.all([
      Supplier.findOne({ _id: supplierId, workspaceId }),
      Company.findOne({ _id: companyId, workspaceId }),
    ]);
    if (!supplier && !isInterBranch) {
      throw new ApiError(404, "Supplier not found");
    }
  } else {
    company = await Company.findOne({ _id: companyId, workspaceId });
  }

  const companyGstin = (company?.gstin || "").trim().toUpperCase();
  const supplierGstin = (supplier?.gstNumber || "").trim().toUpperCase();
  const isIgst =
    !isInterBranch &&
    companyGstin &&
    supplierGstin &&
    companyGstin.substring(0, 2) !== supplierGstin.substring(0, 2);

  // 2b. Auto-detect Inter-Company Supplier Relationship
  let interCompanyDest = null;
  if (supplierId && supplier) {
    interCompanyDest = await resolveInterCompanyDestination({
      workspaceId,
      currentCompanyId: companyId,
      supplier,
      supplierId,
    });
  }

  const isInterCompany = Boolean(payload.isInterCompany) || Boolean(interCompanyDest);

  // 3. Process line items & calculate taxes
  let taxableSubtotal = 0;
  let totalGst = 0;
  const slabMap = new Map();

  const processedItems = [];

  for (const item of items) {
    const {
      productId,
      productName,
      pack,
      batchId,
      batchNo,
      expiry,
      purchaseBillId,
      purchaseBillNo,
      purchaseBillDate,
      sourceBin = "SELLABLE",
      returnQty,
      rate,
      discountPct = 0,
      gstPct = 0,
    } = item;

    const qty = Number(returnQty);
    if (isNaN(qty) || qty <= 0) {
      throw new ApiError(400, `Invalid return quantity for batch ${batchNo}`);
    }

    const itemRate = Number(rate || 0);
    const disc = Number(discountPct || 0);
    const lineGross = qty * itemRate;
    const lineDiscount = lineGross * (disc / 100);
    const lineTaxable = Number((lineGross - lineDiscount).toFixed(2));

    const taxRate = Number(gstPct || 0);
    const lineTax = Number(((lineTaxable * taxRate) / 100).toFixed(2));
    const halfTax = Number((lineTax / 2).toFixed(2));

    const cgstAmt = isIgst ? 0 : halfTax;
    const sgstAmt = isIgst ? 0 : Number((lineTax - halfTax).toFixed(2));
    const igstAmt = isIgst ? lineTax : 0;
    const lineTotal = Number((lineTaxable + lineTax).toFixed(2));

    taxableSubtotal += lineTaxable;
    totalGst += lineTax;

    // Aggregate slab
    if (!slabMap.has(taxRate)) {
      slabMap.set(taxRate, {
        gstPct: taxRate,
        taxable: 0,
        cgstAmt: 0,
        sgstAmt: 0,
        igstAmt: 0,
        totalTax: 0,
      });
    }
    const slab = slabMap.get(taxRate);
    slab.taxable += lineTaxable;
    slab.cgstAmt += cgstAmt;
    slab.sgstAmt += sgstAmt;
    slab.igstAmt += igstAmt;
    slab.totalTax += lineTax;

    processedItems.push({
      productId,
      productName: productName || "",
      pack: pack || "",
      batchId,
      batchNo: stripBatchTags(batchNo || ""),
      expiry: formatExpiry(expiry),
      purchaseBillId: purchaseBillId || null,
      purchaseBillNo: purchaseBillNo || "",
      purchaseBillDate: purchaseBillDate || "",
      sourceBin,
      isIncoming: Boolean(item.isIncoming),
      sourceBranchId: item.sourceBranchId || null,
      sourceTransferOrderNo: item.sourceTransferOrderNo || "",
      sourceTransferOrderId: item.sourceTransferOrderId || null,
      subSupplierId: item.subSupplierId || null,
      subSupplierName: item.subSupplierName || "",
      subSupplierGst: item.subSupplierGst || "",
      returnQty: qty,
      rate: itemRate,
      discountPct: disc,
      taxableAmount: lineTaxable,
      gstPct: taxRate,
      cgstAmt,
      sgstAmt,
      igstAmt,
      totalGst: lineTax,
      totalAmount: lineTotal,
    });
  }

  taxableSubtotal = Number(taxableSubtotal.toFixed(2));
  totalGst = Number(totalGst.toFixed(2));
  const rawGrandTotal = taxableSubtotal + totalGst;
  const grandTotal = Math.round(rawGrandTotal);
  const roundOff = Number((grandTotal - rawGrandTotal).toFixed(2));

  const gstSlabs = Array.from(slabMap.values()).map((s) => ({
    gstPct: s.gstPct,
    taxable: Number(s.taxable.toFixed(2)),
    cgstAmt: Number(s.cgstAmt.toFixed(2)),
    sgstAmt: Number(s.sgstAmt.toFixed(2)),
    igstAmt: Number(s.igstAmt.toFixed(2)),
    totalTax: Number(s.totalTax.toFixed(2)),
  }));

  // 4. Generate Numbers
  const isCreditNote = settlementType === SETTLEMENT_TYPE.CREDIT_NOTE;
  let returnNo = "";
  let debitNoteNo = "";
  let creditNoteNo = "";

  if (payload.creditNoteNo || payload.customCreditNoteNo) {
    creditNoteNo = String(payload.creditNoteNo || payload.customCreditNoteNo).trim();
  }

  if (isCreditNote) {
    const [retNum, cnNum] = await Promise.all([
      purchaseReturnRepository.generateNextReturnNo(
        companyId,
        workspaceId,
        branchCode
      ),
      creditNoteNo
        ? Promise.resolve(creditNoteNo)
        : purchaseReturnRepository.generateNextCreditNoteNo(
            companyId,
            workspaceId,
            branchCode
          ),
    ]);
    returnNo = retNum;
    creditNoteNo = cnNum;
  } else {
    const [retNum, dnNum] = await Promise.all([
      purchaseReturnRepository.generateNextReturnNo(
        companyId,
        workspaceId,
        branchCode
      ),
      purchaseReturnRepository.generateNextDebitNoteNo(
        companyId,
        workspaceId,
        branchCode
      ),
    ]);
    returnNo = retNum;
    debitNoteNo = dnNum;

    // For inter-company purchase return, pre-generate Credit Note number for destination company
    if (isInterCompany && !creditNoteNo && interCompanyDest?.company?._id) {
      try {
        const destBranchCode = interCompanyDest.branch?.branchCode || "BR01";
        creditNoteNo = await purchaseReturnRepository.generateNextCreditNoteNo(
          interCompanyDest.company._id,
          workspaceId,
          destBranchCode
        );
      } catch (cnErr) {
        creditNoteNo = `CN-${returnNo}`;
      }
    }
  }

  // 5. Determine Financial Period
  let period = await financialPeriodRepository.findPeriodByDate(
    companyId,
    workspaceId,
    returnDate ? new Date(returnDate) : new Date()
  );
  if (!period) {
    const periods = await financialPeriodRepository.getPeriods(
      workspaceId,
      companyId,
      { isCurrent: true, all: true }
    );
    period = periods.periods && periods.periods[0];
  }
  const financialPeriodId = period ? period._id : null;

  // 6. Begin ACID Transaction Session
  const session = await mongoose.startSession();
  session.startTransaction();

  let createdReturn = null;

  try {
    // A. Decrement Stock for each item
    for (const item of processedItems) {
      const batchDoc = await Batch.findById(item.batchId).session(session);
      if (!batchDoc) {
        throw new ApiError(404, `Batch ${item.batchNo} not found`);
      }

      if (item.sourceBin === "SELLABLE") {
        if (batchDoc.batchQty < item.returnQty) {
          // Self-healing fallback: If shelf stock is insufficient but this is a scrap batch with scrapQty available
          if ((batchDoc.scrapQty || 0) >= item.returnQty) {
            await Batch.updateOne(
              { _id: item.batchId },
              { $inc: { scrapQty: -item.returnQty } },
              { session }
            );
            await ProductFacility.updateOne(
              {
                workspaceId,
                facility_id: resolvedBranchId,
                product_id: item.productId,
              },
              { $inc: { scrapQty: -item.returnQty } },
              { session }
            );
          } else {
            throw new ApiError(
              400,
              `Insufficient shelf stock for batch ${item.batchNo}. Available: ${batchDoc.batchQty}, Requested: ${item.returnQty}`
            );
          }
        } else {
          await Batch.updateOne(
            { _id: item.batchId },
            { $inc: { batchQty: -item.returnQty } },
            { session }
          );

          await ProductFacility.updateOne(
            {
              workspaceId,
              facility_id: resolvedBranchId,
              product_id: item.productId,
            },
            {
              $inc: {
                total_qty_available: -item.returnQty,
                qoh: -item.returnQty,
                atp: -item.returnQty,
              },
            },
            { session }
          );
        }
      } else if (item.sourceBin === "SCRAP_FRESH") {
        const availableScrap = batchDoc.scrapQty || 0;
        if (availableScrap < item.returnQty) {
          // Self-healing fallback: If scrap stock is insufficient but shelf has available batchQty
          if ((batchDoc.batchQty || 0) >= item.returnQty) {
            await Batch.updateOne(
              { _id: item.batchId },
              { $inc: { batchQty: -item.returnQty } },
              { session }
            );
            await ProductFacility.updateOne(
              {
                workspaceId,
                facility_id: resolvedBranchId,
                product_id: item.productId,
              },
              {
                $inc: {
                  total_qty_available: -item.returnQty,
                  qoh: -item.returnQty,
                  atp: -item.returnQty,
                },
              },
              { session }
            );
          } else {
            throw new ApiError(
              400,
              `Insufficient scrap stock for batch ${item.batchNo}. Available: ${availableScrap}, Requested: ${item.returnQty}`
            );
          }
        } else {
          await Batch.updateOne(
            { _id: item.batchId },
            { $inc: { scrapQty: -item.returnQty } },
            { session }
          );

          await ProductFacility.updateOne(
            {
              workspaceId,
              facility_id: resolvedBranchId,
              product_id: item.productId,
            },
            { $inc: { scrapQty: -item.returnQty } },
            { session }
          );
        }
      } else if (item.sourceBin === "SCRAP_EXPIRED") {
        const availableScrap = Math.max(batchDoc.expiredQty || 0, batchDoc.scrapQty || 0);
        if (availableScrap < item.returnQty) {
          if ((batchDoc.batchQty || 0) >= item.returnQty) {
            await Batch.updateOne(
              { _id: item.batchId },
              { $inc: { batchQty: -item.returnQty } },
              { session }
            );
            await ProductFacility.updateOne(
              {
                workspaceId,
                facility_id: resolvedBranchId,
                product_id: item.productId,
              },
              {
                $inc: {
                  total_qty_available: -item.returnQty,
                  qoh: -item.returnQty,
                  atp: -item.returnQty,
                },
              },
              { session }
            );
          } else {
            throw new ApiError(
              400,
              `Insufficient expired scrap stock for batch ${item.batchNo}. Available: ${availableScrap}, Requested: ${item.returnQty}`
            );
          }
        } else {
          const expDec = Math.min(batchDoc.expiredQty || 0, item.returnQty);
          await Batch.updateOne(
            { _id: item.batchId },
            {
              $inc: {
                expiredQty: -expDec,
                scrapQty: -item.returnQty,
              },
            },
            { session }
          );

          await ProductFacility.updateOne(
            {
              workspaceId,
              facility_id: resolvedBranchId,
              product_id: item.productId,
            },
            {
              $inc: {
                expiredQty: -expDec,
                scrapQty: -item.returnQty,
              },
            },
            { session }
          );
        }
      } else if (item.sourceBin === "SCRAP_BROKEN") {
        const availableBroken = Math.max(batchDoc.brokenQty || 0, batchDoc.scrapQty || 0);
        if (availableBroken < item.returnQty) {
          if ((batchDoc.batchQty || 0) >= item.returnQty) {
            await Batch.updateOne(
              { _id: item.batchId },
              { $inc: { batchQty: -item.returnQty } },
              { session }
            );
            await ProductFacility.updateOne(
              {
                workspaceId,
                facility_id: resolvedBranchId,
                product_id: item.productId,
              },
              {
                $inc: {
                  total_qty_available: -item.returnQty,
                  qoh: -item.returnQty,
                  atp: -item.returnQty,
                },
              },
              { session }
            );
          } else {
            throw new ApiError(
              400,
              `Insufficient broken scrap stock for batch ${item.batchNo}. Available: ${availableBroken}, Requested: ${item.returnQty}`
            );
          }
        } else {
          const brkDec = Math.min(batchDoc.brokenQty || 0, item.returnQty);
          await Batch.updateOne(
            { _id: item.batchId },
            {
              $inc: {
                brokenQty: -brkDec,
                scrapQty: -item.returnQty,
              },
            },
            { session }
          );

          await ProductFacility.updateOne(
            {
              workspaceId,
              facility_id: resolvedBranchId,
              product_id: item.productId,
            },
            {
              $inc: {
                brokenQty: -brkDec,
                scrapQty: -item.returnQty,
              },
            },
            { session }
          );
        }
      }
    }

    // B. Save PurchaseReturn Document
    const returnData = {
      workspaceId,
      companyId,
      branchId: resolvedBranchId,
      supplierId: supplier?._id || null,
      sourceBranchId: payload.sourceBranchId || null,
      sourceTransferOrderId: payload.sourceTransferOrderId || null,
      isInterBranch,
      isInterCompany,
      returnNo,
      debitNoteNo,
      creditNoteNo,
      creditNoteDate: creditNoteNo ? (returnDate ? new Date(returnDate) : new Date()) : null,
      returnDate: returnDate ? new Date(returnDate) : new Date(),
      returnMotive,
      settlementType,
      settlementStatus: adjustedPurchaseBillId
        ? SETTLEMENT_STATUS.ADJUSTED_IN_BILL
        : SETTLEMENT_STATUS.PENDING,
      settledAmount: adjustedPurchaseBillId ? grandTotal : 0,
      adjustedPurchaseBillId: adjustedPurchaseBillId || null,
      items: processedItems,
      gstSlabs,
      taxableSubtotal,
      totalGst,
      roundOff,
      grandTotal,
      status: PURCHASE_RETURN_STATUS.CONFIRMED,
      financialPeriodId,
      reason,
      remarks,
      createdBy: userId,
      shippingDetails: {
        destinationType: isInterCompany ? "COMPANY_BRANCH" : (payload.shippingDetails?.destinationType || "COMPANY_BRANCH"),
        destinationCompanyId: isInterCompany
          ? (interCompanyDest?.company?._id || payload.shippingDetails?.destinationCompanyId || null)
          : (payload.shippingDetails?.destinationCompanyId || null),
        destinationBranchId: isInterCompany
          ? (payload.shippingDetails?.destinationBranchId || interCompanyDest?.branch?._id || null)
          : (payload.shippingDetails?.destinationBranchId || null),
        destinationSupplierId: isInterCompany ? null : (payload.shippingDetails?.destinationSupplierId || null),
        courierName: payload.shippingDetails?.courierName || "",
        trackingNo: payload.shippingDetails?.trackingNo || "",
        boxCount: payload.shippingDetails?.boxCount || 1,
        packageNotes: payload.shippingDetails?.packageNotes || "",
        transitStatus: isInterCompany ? "IN_TRANSIT" : (payload.shippingDetails?.transitStatus || "NOT_DISPATCHED"),
        dispatchedAt: isInterCompany ? new Date() : (payload.shippingDetails?.dispatchedAt || null),
        dispatchedBy: isInterCompany ? userId : (payload.shippingDetails?.dispatchedBy || null),
        ...(payload.shippingDetails || {}),
      },
    };

    createdReturn = await purchaseReturnRepository.createPurchaseReturn(
      returnData,
      { session }
    );

    // C. Adjust against Purchase Bill if specified
    if (adjustedPurchaseBillId) {
      const billToAdjust = await PurchaseBill.findById(
        adjustedPurchaseBillId
      ).session(session);
      if (billToAdjust) {
        const newDue = Math.max(0, (billToAdjust.amountDue || 0) - grandTotal);
        await PurchaseBill.updateOne(
          { _id: adjustedPurchaseBillId },
          { $set: { amountDue: newDue } },
          { session }
        );
      }
    }

    await session.commitTransaction();
  } catch (txError) {
    await session.abortTransaction();
    throw txError;
  } finally {
    session.endSession();
  }

  // 7. Post Journal Voucher (Outside transaction to preserve ledger independent isolation)
  try {
    const { cogsAccount, taxAccount } = await ensurePurchaseAccounts(workspaceId, companyId, userId);

    let supplierAccountId = null;
    if (!isInterBranch && supplier) {
      try {
        supplierAccountId = await ensureSupplierLedgerAccount(
          supplier,
          companyId,
          workspaceId,
          userId
        );
      } catch (e) {
        console.warn("Failed to auto-resolve supplier ledger account on return creation:", e?.message);
      }
    }

    const refDocNo = creditNoteNo || debitNoteNo || returnNo;
    const isCN = Boolean(creditNoteNo || isCreditNote);

    if (!isInterBranch && supplierAccountId && cogsAccount) {
      const lines = [
        {
          accountId: supplierAccountId.toString(),
          debit: grandTotal,
          credit: 0,
          narration: isCN
            ? `Credit Note #${refDocNo} to ${supplier.businessName || supplier.name || "Supplier"}`
            : `Debit Note #${refDocNo} to ${supplier.businessName || supplier.name || "Supplier"}`,
        },
        {
          accountId: cogsAccount._id.toString(),
          debit: 0,
          credit: taxableSubtotal,
          narration: `Purchase Return reversal for #${refDocNo}`,
        },
      ];

      if (taxAccount && totalGst > 0) {
        lines.push({
          accountId: taxAccount._id.toString(),
          debit: 0,
          credit: totalGst,
          narration: `ITC Reversal for #${refDocNo}`,
        });
      }

      // Small rounding adjustment
      const totDebit = lines.reduce((acc, l) => acc + l.debit, 0);
      const totCredit = lines.reduce((acc, l) => acc + l.credit, 0);
      if (Math.abs(totDebit - totCredit) > 0.0001) {
        lines[1].credit += totDebit - totCredit;
      }

      const jv = await journalVoucherService.createJournalVoucher(
        workspaceId,
        companyId,
        resolvedUserId,
        {
          lines,
          voucherDate: createdReturn.returnDate,
          voucherType: VOUCHER_TYPE.PURCHASE_RETURN,
          referenceNumber: refDocNo,
          narration: isCN
            ? `Purchase Return Credit Note: ${refDocNo} (${returnNo})`
            : `Purchase Return / Debit Note: ${refDocNo} (${returnNo})`,
          status: VOUCHER_STATUS.POSTED,
        }
      );

      if (jv && jv._id) {
        try {
          await journalPostingService.postJournalVoucher(
            jv._id,
            companyId,
            workspaceId,
            resolvedUserId
          );
        } catch (postErr) {
          console.warn("Failed to post JV immediately upon purchase return creation:", postErr?.message);
        }

        await purchaseReturnRepository.updatePurchaseReturn(
          createdReturn._id,
          companyId,
          workspaceId,
          { journalVoucherId: jv._id }
        );
      }
    }

    // Materialize Credit Note collection document if creditNoteNo is present
    if (creditNoteNo) {
      try {
        await syncCreditNoteDocument(createdReturn, creditNoteNo);
      } catch (cnErr) {
        console.warn("Failed to sync CreditNote collection on return creation:", cnErr?.message);
      }
    }
  } catch (jvErr) {
    console.error(
      "Failed to auto-create journal voucher for purchase return:",
      jvErr
    );
  }

  // 8. Post GSTR-2 Debit Note Entry in GstLedger
  try {
    const halfGst = totalGst / 2;
    const refDocNo = creditNoteNo || debitNoteNo || returnNo;
    const isCN = Boolean(creditNoteNo || isCreditNote);
    await gstLedgerRepository.createGstLedgerEntry({
      workspaceId,
      companyId,
      branchId: resolvedBranchId,
      partyId: supplierId,
      voucherId: createdReturn._id,
      voucherNumber: refDocNo,
      voucherDate: createdReturn.returnDate,
      gstType: "GSTR-2",
      groupDescription: isCN ? "CDNR - Credit Note" : "CDNR - Debit Note",
      taxableAmount: -taxableSubtotal,
      cgst: isIgst ? 0 : -halfGst,
      sgst: isIgst ? 0 : -halfGst,
      igst: isIgst ? -totalGst : 0,
      totalAmount: -grandTotal,
      narration: `Purchase Return ${isCN ? "Credit Note #" : "Debit Note #"}${refDocNo} to ${supplier?.businessName || supplier?.name || "Supplier"}`,
    });
  } catch (gstErr) {
    console.error("Failed to log GSTR-2 entry for purchase return:", gstErr);
  }

  return createdReturn;
};

/**
 * Get paginated list of purchase returns with filters
 */
const getPurchaseReturns = async (
  workspaceId,
  companyId,
  branchId,
  filters = {},
  pagination = {}
) => {
  let query;

  if (filters.direction === "incoming") {
    // Queries intra-company purchase return boxes routed between branches of the active company.
    // Inter-company returns (from other companies) are excluded here because from the recipient supplier's perspective,
    // they are classified under Sales Returns.
    query = {
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      companyId: new mongoose.Types.ObjectId(companyId),
      isInterCompany: { $ne: true },
      isDeleted: false,
      "shippingDetails.transitStatus": { $in: ["IN_TRANSIT", "RECEIVED"] },
    };

    if (branchId && branchId !== "all") {
      query["shippingDetails.destinationBranchId"] = new mongoose.Types.ObjectId(branchId);
    } else if (companyId) {
      query["shippingDetails.destinationCompanyId"] = new mongoose.Types.ObjectId(companyId);
    }
  } else {
    query = {
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      companyId: new mongoose.Types.ObjectId(companyId),
      isDeleted: false,
    };

    if (branchId && branchId !== "all") {
      query.branchId = new mongoose.Types.ObjectId(branchId);
    }
  }

  if (filters.supplierId) {
    query.supplierId = new mongoose.Types.ObjectId(filters.supplierId);
  }

  if (filters.returnMotive && filters.returnMotive !== "all") {
    query.returnMotive = filters.returnMotive;
  }

  if (filters.status && filters.status !== "all") {
    query.status = filters.status;
  }

  if (filters.startDate || filters.endDate) {
    query.returnDate = {};
    if (filters.startDate) {
      query.returnDate.$gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      const eod = new Date(filters.endDate);
      eod.setHours(23, 59, 59, 999);
      query.returnDate.$lte = eod;
    }
  }

  if (filters.search) {
    const searchRegex = { $regex: filters.search.trim(), $options: "i" };
    query.$or = [
      { returnNo: searchRegex },
      { debitNoteNo: searchRegex },
      { creditNoteNo: searchRegex },
      { reason: searchRegex },
    ];
  }

  return purchaseReturnRepository.findPurchaseReturns(query, pagination);
};

/**
 * Get purchase return details by ID
 */
const getPurchaseReturnById = async (returnId, companyId, workspaceId) => {
  const returnDoc = await purchaseReturnRepository.findPurchaseReturnById(
    returnId,
    companyId,
    workspaceId
  );

  if (!returnDoc) {
    throw new ApiError(404, "Purchase return record not found");
  }

  // Enrich any items missing subSupplierName for historical/saved returns
  try {
    const items = returnDoc.items || [];
    const itemsMissingSub = items.filter(
      (i) => !i.subSupplierName && i.productId
    );
    if (itemsMissingSub.length > 0) {
      const originCompanyId =
        returnDoc.companyId?._id || returnDoc.companyId || companyId;
      const pbIds = [
        ...new Set(
          itemsMissingSub
            .map((i) => i.purchaseBillId)
            .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
            .map((id) => String(id))
        ),
      ];
      const pbMap = new Map();
      if (pbIds.length > 0) {
        const bills = await PurchaseBill.find({ _id: { $in: pbIds } })
          .populate("supplierId", "businessName name gstNumber")
          .select("companyId supplierId purchaseBillNo supplierInvoiceNo")
          .lean();
        bills.forEach((b) => pbMap.set(String(b._id), b));
      }

      let hasEnrichedAny = false;
      await Promise.all(
        itemsMissingSub.map(async (item) => {
          const pb =
            (item.purchaseBillId && pbMap.get(String(item.purchaseBillId))) ||
            (item.purchaseBillNo
              ? {
                  companyId: originCompanyId,
                  supplierId: returnDoc.supplierId,
                  purchaseBillNo: item.purchaseBillNo,
                  supplierInvoiceNo: item.purchaseBillNo,
                }
              : null);
          const subMeta = await resolveSubSupplierFromPurchaseBill({
            workspaceId,
            currentCompanyId: originCompanyId,
            productId: item.productId?._id || item.productId,
            batchNo: item.batchNo,
            purchaseBill: pb,
            mainSupplier: returnDoc.supplierId,
          });
          if (subMeta?.subSupplierName) {
            item.subSupplierId = subMeta.subSupplierId || null;
            item.subSupplierName = subMeta.subSupplierName;
            item.subSupplierGst = subMeta.subSupplierGst || "";
            hasEnrichedAny = true;
          }
        })
      );

      if (hasEnrichedAny && returnDoc._id) {
        await purchaseReturnRepository.updatePurchaseReturn(returnDoc._id, {
          items: returnDoc.items,
        });
      }
    }
  } catch {
    // Non-blocking enrichment
  }

  return returnDoc;
};

/**
 * Cancel a Purchase Return and restock items
 */
const cancelPurchaseReturn = async (
  returnId,
  companyId,
  workspaceId,
  userId,
  reason = ""
) => {
  const returnDoc = await purchaseReturnRepository.findPurchaseReturnById(
    returnId,
    companyId,
    workspaceId
  );

  if (!returnDoc) {
    throw new ApiError(404, "Purchase return record not found");
  }

  if (returnDoc.status === PURCHASE_RETURN_STATUS.CANCELLED) {
    throw new ApiError(400, "Purchase return is already cancelled");
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Restock items back to original bin
    for (const item of returnDoc.items || []) {
      if (item.sourceBin === "SELLABLE") {
        await Batch.updateOne(
          { _id: item.batchId },
          { $inc: { batchQty: item.returnQty } },
          { session }
        );
        await ProductFacility.updateOne(
          {
            workspaceId,
            facility_id: returnDoc.branchId,
            product_id: item.productId,
          },
          {
            $inc: {
              total_qty_available: item.returnQty,
              qoh: item.returnQty,
              atp: item.returnQty,
            },
          },
          { session }
        );
      } else if (item.sourceBin === "SCRAP_EXPIRED") {
        await Batch.updateOne(
          { _id: item.batchId },
          {
            $inc: {
              expiredQty: item.returnQty,
              scrapQty: item.returnQty,
            },
          },
          { session }
        );
        await ProductFacility.updateOne(
          {
            workspaceId,
            facility_id: returnDoc.branchId,
            product_id: item.productId,
          },
          {
            $inc: {
              expiredQty: item.returnQty,
              scrapQty: item.returnQty,
            },
          },
          { session }
        );
      } else if (item.sourceBin === "SCRAP_FRESH") {
        await Batch.updateOne(
          { _id: item.batchId },
          {
            $inc: {
              scrapQty: item.returnQty,
            },
          },
          { session }
        );
        await ProductFacility.updateOne(
          {
            workspaceId,
            facility_id: returnDoc.branchId,
            product_id: item.productId,
          },
          {
            $inc: {
              scrapQty: item.returnQty,
            },
          },
          { session }
        );
      } else if (item.sourceBin === "SCRAP_BROKEN") {
        await Batch.updateOne(
          { _id: item.batchId },
          {
            $inc: {
              brokenQty: item.returnQty,
              scrapQty: item.returnQty,
            },
          },
          { session }
        );
        await ProductFacility.updateOne(
          {
            workspaceId,
            facility_id: returnDoc.branchId,
            product_id: item.productId,
          },
          {
            $inc: {
              brokenQty: item.returnQty,
              scrapQty: item.returnQty,
            },
          },
          { session }
        );
      }
    }

    // Mark return cancelled
    await purchaseReturnRepository.updatePurchaseReturn(
      returnId,
      companyId,
      workspaceId,
      {
        status: PURCHASE_RETURN_STATUS.CANCELLED,
        remarks: reason
          ? `${returnDoc.remarks || ""} | Cancelled: ${reason}`
          : returnDoc.remarks,
      },
      session
    );

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  // Delete GSTR-2 entry
  try {
    await gstLedgerRepository.deleteGstLedgerEntriesByVoucherId(returnId);
  } catch (gstErr) {
    console.error("Failed to delete GSTR-2 entry on return cancellation:", gstErr);
  }

  return { message: "Purchase return cancelled and stock restored successfully" };
};

/**
 * Dispatch / Ship Purchase Return Box to Destination Hub, Other Company Branch, or Direct to Supplier
 */
const dispatchReturnBox = async (
  returnId,
  companyId,
  workspaceId,
  userId,
  dispatchData = {}
) => {
  const {
    destinationType = "COMPANY_BRANCH",
    destinationCompanyId,
    destinationBranchId,
    destinationSupplierId,
    courierName = "",
    trackingNo = "",
    boxCount = 1,
    packageNotes = "",
    creditNoteNo: customCreditNoteNo,
  } = dispatchData;

  const isSupplierDispatch = destinationType === "SUPPLIER";

  if (!isSupplierDispatch && !destinationBranchId) {
    throw new ApiError(400, "Destination branch is required for consignment shipping");
  }

  const returnDoc = await purchaseReturnRepository.findPurchaseReturnById(
    returnId,
    companyId,
    workspaceId
  );

  if (!returnDoc) {
    throw new ApiError(404, "Purchase return record not found");
  }

  let resolvedSupplierId = null;
  if (isSupplierDispatch) {
    resolvedSupplierId =
      destinationSupplierId ||
      returnDoc.supplierId?._id ||
      returnDoc.supplierId ||
      null;
    if (!resolvedSupplierId) {
      throw new ApiError(400, "Target supplier is required for direct supplier dispatch");
    }
  }

  // Generate or assign Credit Note for the supplier upon consignment dispatch
  let creditNoteNoToSet = returnDoc.creditNoteNo;
  let creditNoteDateToSet = returnDoc.creditNoteDate;

  if (customCreditNoteNo && String(customCreditNoteNo).trim()) {
    creditNoteNoToSet = String(customCreditNoteNo).trim();
    if (!creditNoteDateToSet) creditNoteDateToSet = new Date();
  } else if (!creditNoteNoToSet) {
    let branchCode = "BR01";
    const originBranchId = returnDoc.branchId?._id || returnDoc.branchId;
    if (originBranchId) {
      const bDoc = await Branch.findById(originBranchId).select("branchCode").lean();
      if (bDoc?.branchCode) branchCode = bDoc.branchCode;
    }
    creditNoteNoToSet = await purchaseReturnRepository.generateNextCreditNoteNo(
      companyId,
      workspaceId,
      branchCode
    );
    creditNoteDateToSet = new Date();
  }

  const isDestDifferentCompany =
    destinationCompanyId &&
    String(destinationCompanyId) !== String(returnDoc.companyId?._id || returnDoc.companyId);

  const shippingUpdate = {
    creditNoteNo: creditNoteNoToSet,
    creditNoteDate: creditNoteDateToSet,
    ...(isDestDifferentCompany || returnDoc.isInterCompany ? { isInterCompany: true } : {}),
    "shippingDetails.destinationType": isSupplierDispatch ? "SUPPLIER" : "COMPANY_BRANCH",
    "shippingDetails.destinationCompanyId": isSupplierDispatch
      ? null
      : destinationCompanyId
      ? new mongoose.Types.ObjectId(destinationCompanyId)
      : null,
    "shippingDetails.destinationBranchId": isSupplierDispatch
      ? null
      : new mongoose.Types.ObjectId(destinationBranchId),
    "shippingDetails.destinationSupplierId": isSupplierDispatch
      ? new mongoose.Types.ObjectId(resolvedSupplierId)
      : null,
    "shippingDetails.courierName": String(courierName || "").trim(),
    "shippingDetails.trackingNo": String(trackingNo || "").trim(),
    "shippingDetails.boxCount": Number(boxCount) || 1,
    "shippingDetails.packageNotes": packageNotes || "",
    "shippingDetails.transitStatus": "IN_TRANSIT",
    "shippingDetails.dispatchedAt": new Date(),
    "shippingDetails.dispatchedBy": new mongoose.Types.ObjectId(userId),
  };

  const updated = await PurchaseReturn.findOneAndUpdate(
    {
      _id: returnDoc._id,
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
    },
    { $set: shippingUpdate },
    { new: true }
  )
    .populate("companyId", "name legalName")
    .populate("shippingDetails.destinationCompanyId", "name legalName")
    .populate("shippingDetails.destinationBranchId", "name branchCode address phone")
    .populate("shippingDetails.destinationSupplierId", "businessName name gstNumber mobile phone address")
    .populate("supplierId", "businessName name gstNumber mobile phone address")
    .lean();

  // Materialize or sync with CreditNote collection so it appears on /sales/credit-notes
  try {
    await syncCreditNoteDocument(updated, creditNoteNoToSet);
  } catch (cnSyncErr) {
    console.error("Failed to sync CreditNote document on dispatch:", cnSyncErr);
  }

  // Ensure Supplier Ledger is updated and synchronized with Credit Note
  try {
    await syncPurchaseReturnLedger(updated, creditNoteNoToSet, userId);
  } catch (ledgerSyncErr) {
    console.error("Failed to sync supplier ledger on return dispatch:", ledgerSyncErr);
  }

  return updated;
};

/**
 * Ensure COGS/Purchase account and Tax/GST account exist with valid AccountGroup
 */
export const ensurePurchaseAccounts = async (workspaceId, companyId, userId = null) => {
  const Account = mongoose.model("Account");
  const AccountGroup = mongoose.model("AccountGroup");

  let cogsAccount =
    (await Account.findOne({
      workspaceId,
      companyId,
      accountCode: "COGS",
    })) ||
    (await Account.findOne({
      workspaceId,
      companyId,
      accountCategory: "PURCHASE",
    })) ||
    (await Account.findOne({
      workspaceId,
      companyId,
      accountNature: "EXPENSE",
    }));

  if (!cogsAccount) {
    let expenseGroup =
      (await AccountGroup.findOne({
        workspaceId,
        companyId,
        groupCode: { $in: ["COGS_GROUP", "OPERATING_EXPENSES", "DIRECT_EXPENSES"] },
      })) ||
      (await AccountGroup.findOne({
        workspaceId,
        companyId,
        nature: "EXPENSE",
      }));

    if (!expenseGroup) {
      expenseGroup = await AccountGroup.create({
        workspaceId,
        companyId,
        groupName: "Direct Expenses",
        groupCode: "DIRECT_EXPENSES",
        nature: "EXPENSE",
        isSystemGroup: true,
        createdBy: userId,
      });
    }

    cogsAccount = await Account.create({
      workspaceId,
      companyId,
      accountCode: "PURCHASE",
      accountName: "Purchase Account",
      accountGroupId: expenseGroup._id,
      accountNature: "EXPENSE",
      accountCategory: "PURCHASE",
      status: "active",
      isSystemAccount: true,
      createdBy: userId,
    });
  }

  let taxAccount =
    (await Account.findOne({
      workspaceId,
      companyId,
      accountCode: "TAX-PAYABLE",
    })) ||
    (await Account.findOne({
      workspaceId,
      companyId,
      accountCategory: "GST",
    })) ||
    (await Account.findOne({
      workspaceId,
      companyId,
      $or: [{ accountName: /GST/i }, { accountName: /Tax/i }],
    }));

  if (!taxAccount) {
    let dutiesGroup =
      (await AccountGroup.findOne({
        workspaceId,
        companyId,
        groupCode: { $in: ["DUTIES_AND_TAXES", "CURRENT_LIABILITIES"] },
      })) ||
      (await AccountGroup.findOne({
        workspaceId,
        companyId,
        $or: [
          { groupName: /Duties/i },
          { groupName: /Tax/i },
          { nature: "LIABILITY" },
          { nature: "ASSET" },
        ],
      }));

    if (!dutiesGroup) {
      dutiesGroup = await AccountGroup.create({
        workspaceId,
        companyId,
        groupName: "Duties & Taxes",
        groupCode: "DUTIES_AND_TAXES",
        nature: "LIABILITY",
        isSystemGroup: true,
        createdBy: userId,
      });
    }

    taxAccount = await Account.create({
      workspaceId,
      companyId,
      accountCode: "GST-INPUT",
      accountName: "Input GST Tax Account",
      accountGroupId: dutiesGroup._id,
      accountNature: "ASSET",
      accountCategory: "GST",
      status: "active",
      isSystemAccount: true,
      createdBy: userId,
    });
  }

  return { cogsAccount, taxAccount };
};

/**
 * Synchronize or create Journal Voucher and General Ledger entries for a Purchase Return on Dispatch/Confirmation
 */
export const syncPurchaseReturnLedger = async (
  returnDoc,
  creditNoteNo = null,
  userId = null
) => {
  if (!returnDoc) return null;
  const workspaceId = returnDoc.workspaceId?._id || returnDoc.workspaceId;
  const companyId = returnDoc.companyId?._id || returnDoc.companyId;
  const resolvedUserId = userId?._id || userId || returnDoc.createdBy?._id || returnDoc.createdBy || null;
  const rawSupplierId = returnDoc.supplierId?._id || returnDoc.supplierId || returnDoc.shippingDetails?.destinationSupplierId?._id || returnDoc.shippingDetails?.destinationSupplierId;
  const hasSupplier = Boolean(rawSupplierId);
  const isInterBranch = Boolean(returnDoc.isInterBranch && !hasSupplier);
  if (isInterBranch) return null;

  const grandTotal = returnDoc.grandTotal || 0;
  const taxableSubtotal = returnDoc.taxableSubtotal || 0;
  const totalGst = returnDoc.totalGst || 0;
  const debitNoteNo = returnDoc.debitNoteNo || returnDoc.returnNo;
  const activeCreditNoteNo = creditNoteNo || returnDoc.creditNoteNo || debitNoteNo;

  // 1. If a Journal Voucher already exists, verify its ledger entries
  if (returnDoc.journalVoucherId) {
    try {
      const existingLedgerCount = await Ledger.countDocuments({ voucherId: returnDoc.journalVoucherId });
      const updatedNarration = `Purchase Return Credit Note: ${activeCreditNoteNo} (DN: ${debitNoteNo})`;
      await JournalVoucher.findByIdAndUpdate(returnDoc.journalVoucherId, {
        $set: {
          referenceNumber: activeCreditNoteNo,
          narration: updatedNarration,
          status: VOUCHER_STATUS.POSTED,
        },
      });

      if (existingLedgerCount > 0) {
        await Ledger.updateMany(
          { voucherId: returnDoc.journalVoucherId },
          {
            $set: {
              narration: updatedNarration,
            },
          }
        );
        return returnDoc.journalVoucherId;
      } else {
        // Journal Voucher was in draft or had no ledger entries; post it now!
        await journalPostingService.postJournalVoucher(
          returnDoc.journalVoucherId,
          companyId,
          workspaceId,
          resolvedUserId
        );
        return returnDoc.journalVoucherId;
      }
    } catch (err) {
      console.warn("Failed to update/post existing JV for purchase return, proceeding to recreate:", err?.message);
    }
  }

  // 2. If no Journal Voucher exists yet, create and post one now
  try {
    let supplier = null;
    if (rawSupplierId) {
      supplier = await Supplier.findById(rawSupplierId);
    }

    if (!supplier) return null;

    const supplierAccountId = await ensureSupplierLedgerAccount(
      supplier,
      companyId,
      workspaceId,
      resolvedUserId
    );

    const { cogsAccount, taxAccount } = await ensurePurchaseAccounts(
      workspaceId,
      companyId,
      resolvedUserId
    );

    if (supplierAccountId && cogsAccount) {
      const narrationText = `Debit Note #${debitNoteNo} / Credit Note #${activeCreditNoteNo} to ${supplier.businessName || supplier.name || "Supplier"}`;
      const lines = [
        {
          accountId: supplierAccountId.toString(),
          debit: grandTotal,
          credit: 0,
          narration: narrationText,
        },
        {
          accountId: cogsAccount._id.toString(),
          debit: 0,
          credit: taxableSubtotal,
          narration: `Purchase Return reversal for CN #${activeCreditNoteNo} (DN #${debitNoteNo})`,
        },
      ];

      if (taxAccount && totalGst > 0) {
        lines.push({
          accountId: taxAccount._id.toString(),
          debit: 0,
          credit: totalGst,
          narration: `ITC Reversal for CN #${activeCreditNoteNo} (DN #${debitNoteNo})`,
        });
      }

      // Small rounding adjustment
      const totDebit = lines.reduce((acc, l) => acc + l.debit, 0);
      const totCredit = lines.reduce((acc, l) => acc + l.credit, 0);
      if (Math.abs(totDebit - totCredit) > 0.0001) {
        lines[1].credit += totDebit - totCredit;
      }

      const jv = await journalVoucherService.createJournalVoucher(
        workspaceId,
        companyId,
        resolvedUserId,
        {
          lines,
          voucherDate: returnDoc.creditNoteDate || returnDoc.returnDate || new Date(),
          voucherType: VOUCHER_TYPE.PURCHASE_RETURN,
          referenceNumber: activeCreditNoteNo,
          narration: `Purchase Return Credit Note: ${activeCreditNoteNo} (DN: ${debitNoteNo})`,
          status: VOUCHER_STATUS.POSTED,
        }
      );

      if (jv && jv._id) {
        try {
          await journalPostingService.postJournalVoucher(
            jv._id,
            companyId,
            workspaceId,
            resolvedUserId
          );
        } catch (postErr) {
          console.warn("Failed to post JV immediately upon purchase return dispatch:", postErr?.message);
        }

        await PurchaseReturn.findByIdAndUpdate(returnDoc._id, {
          $set: {
            journalVoucherId: jv._id,
            creditNoteNo: activeCreditNoteNo,
          },
        });
        return jv._id;
      }
    }
  } catch (jvErr) {
    console.error("Failed to post journal voucher on dispatch for purchase return:", jvErr);
  }

  return null;
};

/**
 * Synchronize or create Journal Voucher and General Ledger entries for an incoming Inter-Company Return
 * from the destination (seller) company's perspective (Customer Sales Return Credit Note).
 */
export const syncInterCompanyDestinationLedger = async (returnDoc, userId = null) => {
  if (!returnDoc) return null;
  const workspaceId = returnDoc.workspaceId?._id || returnDoc.workspaceId;
  const destCompanyId =
    returnDoc.shippingDetails?.destinationCompanyId?._id ||
    returnDoc.shippingDetails?.destinationCompanyId;
  const originCompanyId = returnDoc.companyId?._id || returnDoc.companyId;

  if (!destCompanyId || !originCompanyId || String(destCompanyId) === String(originCompanyId)) {
    return null;
  }

  const grandTotal = returnDoc.grandTotal || 0;
  const taxableSubtotal = returnDoc.taxableSubtotal || 0;
  const totalGst = returnDoc.totalGst || 0;
  const refDocNo = returnDoc.creditNoteNo || returnDoc.debitNoteNo || returnDoc.returnNo;

  try {
    const AccountGroup = mongoose.model("AccountGroup");

    // 1. Resolve Origin Company (Buyer that returned the goods)
    const originCompany = await Company.findById(originCompanyId)
      .select("name legalName gstin gstNumber code address")
      .lean();

    // 2. Resolve or create Customer in Destination Company
    const originGst = (originCompany?.gstin || originCompany?.gstNumber || "").trim().toUpperCase();
    const originName = (originCompany?.name || originCompany?.legalName || "").trim();

    let customer = null;
    if (originGst || originName) {
      customer = await Customer.findOne({
        workspaceId,
        companyId: destCompanyId,
        isDeleted: false,
        $or: [
          ...(originGst ? [{ gstNumber: originGst }] : []),
          ...(originName ? [{ name: { $regex: new RegExp(`^${escapeRegex(originName)}$`, "i") } }] : []),
        ],
      });
    }

    if (!customer && originName) {
      customer = await Customer.create({
        workspaceId,
        companyId: destCompanyId,
        name: originName,
        customerType: "wholesale",
        gstNumber: originGst || null,
        status: "Active",
      });
    }

    // 3. Resolve Customer Ledger Account in Destination Company
    let customerAccountId = customer?.ledgerAccountId || null;
    if (!customerAccountId && customer) {
      let debtorsGroup =
        (await AccountGroup.findOne({
          workspaceId,
          companyId: destCompanyId,
          groupCode: "SUNDRY_DEBTORS",
        })) ||
        (await AccountGroup.findOne({
          workspaceId,
          companyId: destCompanyId,
          groupName: /Debtors/i,
        }));

      if (!debtorsGroup) {
        debtorsGroup = await AccountGroup.create({
          workspaceId,
          companyId: destCompanyId,
          groupName: "Sundry Debtors",
          groupCode: "SUNDRY_DEBTORS",
          nature: "ASSET",
          isSystemGroup: true,
        });
      }

      const acc = await Account.create({
        workspaceId,
        companyId: destCompanyId,
        accountName: customer.name || originName,
        accountCode: `CUST-${(customer.customerCode || originCompany?.code || "IC").slice(0, 10)}`,
        accountGroupId: debtorsGroup._id,
        accountNature: "ASSET",
        accountCategory: "CUSTOMER",
        status: "active",
      });
      customerAccountId = acc._id;
      customer.ledgerAccountId = acc._id;
      await customer.save();
    }

    // 4. Resolve Sales Return Revenue Account & Tax Account in Destination Company
    let revenueAccount =
      (await Account.findOne({
        workspaceId,
        companyId: destCompanyId,
        accountCode: "SALES-RETURNS",
      })) ||
      (await Account.findOne({
        workspaceId,
        companyId: destCompanyId,
        accountCode: "SALES-ACCOUNT",
      })) ||
      (await Account.findOne({
        workspaceId,
        companyId: destCompanyId,
        accountCategory: "SALES",
      }));

    if (!revenueAccount) {
      let salesGroup =
        (await AccountGroup.findOne({
          workspaceId,
          companyId: destCompanyId,
          groupCode: "SALES_ACCOUNTS",
        })) ||
        (await AccountGroup.findOne({
          workspaceId,
          companyId: destCompanyId,
          groupName: /Sales/i,
        }));

      if (!salesGroup) {
        salesGroup = await AccountGroup.create({
          workspaceId,
          companyId: destCompanyId,
          groupName: "Sales Accounts",
          groupCode: "SALES_ACCOUNTS",
          nature: "INCOME",
          isSystemGroup: true,
        });
      }

      revenueAccount = await Account.create({
        workspaceId,
        companyId: destCompanyId,
        accountName: "Sales Return Account",
        accountCode: "SALES-RETURNS",
        accountGroupId: salesGroup._id,
        accountNature: "INCOME",
        accountCategory: "SALES",
        status: "active",
      });
    }

    let taxAccount =
      (await Account.findOne({
        workspaceId,
        companyId: destCompanyId,
        accountCode: "TAX-PAYABLE",
      })) ||
      (await Account.findOne({
        workspaceId,
        companyId: destCompanyId,
        accountCategory: "GST",
      }));

    if (customerAccountId && revenueAccount) {
      const lines = [
        {
          accountId: customerAccountId.toString(),
          debit: 0,
          credit: grandTotal,
          narration: `Sales Return Credit Note #${refDocNo} from ${originName}`,
        },
        {
          accountId: revenueAccount._id.toString(),
          debit: taxableSubtotal,
          credit: 0,
          narration: `Revenue deduction on return #${refDocNo}`,
        },
      ];

      if (taxAccount && totalGst > 0) {
        lines.push({
          accountId: taxAccount._id.toString(),
          debit: totalGst,
          credit: 0,
          narration: `Output GST Reversal for #${refDocNo}`,
        });
      }

      const totDebit = lines.reduce((acc, l) => acc + l.debit, 0);
      const totCredit = lines.reduce((acc, l) => acc + l.credit, 0);
      if (Math.abs(totDebit - totCredit) > 0.0001) {
        lines[1].debit += totCredit - totDebit;
      }

      const jv = await journalVoucherService.createJournalVoucher(
        workspaceId,
        destCompanyId,
        userId || returnDoc.createdBy,
        {
          lines,
          voucherDate: returnDoc.creditNoteDate || returnDoc.returnDate || new Date(),
          voucherType: VOUCHER_TYPE.SALES_RETURN || "CREDIT_NOTE",
          referenceNumber: refDocNo,
          narration: `Inter-Company Sales Return Credit Note #${refDocNo} from ${originName}`,
          status: VOUCHER_STATUS.POSTED,
        }
      );

      if (jv && jv._id) {
        try {
          await journalPostingService.postJournalVoucher(
            jv._id,
            destCompanyId,
            workspaceId,
            userId || returnDoc.createdBy
          );
        } catch {
          // non-blocking
        }
      }
    }
  } catch (jvErr) {
    console.warn("Failed to post destination company JV for inter-company sales return:", jvErr?.message);
  }
};

/**
 * Materialize scrap inventory batches in destination branch upon receiving a return consignment box.
 * Idempotent: checks and marks shippingDetails.inventoryMaterialized to prevent duplicate stock creation.
 */
export const materializeConsignmentBatches = async (returnDoc, session = null) => {
  if (!returnDoc) return;
  const destBranchId = returnDoc.shippingDetails?.destinationBranchId;
  if (!destBranchId) return;
  if (!returnDoc.items || returnDoc.items.length === 0) return;

  // Atomically claim materialization if session is not already managing it
  if (!session) {
    const claimed = await PurchaseReturn.findOneAndUpdate(
      {
        _id: returnDoc._id,
        "shippingDetails.inventoryMaterialized": { $ne: true },
      },
      {
        $set: { "shippingDetails.inventoryMaterialized": true },
      }
    );
    if (!claimed) {
      return; // Already materialized by another process
    }
  }

  const workspaceId = returnDoc.workspaceId;
  const branchId = returnDoc.branchId;

  let destCompanyId = returnDoc.shippingDetails?.destinationCompanyId || null;
  if (!destCompanyId && destBranchId) {
    try {
      const destBranchDoc = await Branch.findById(destBranchId)
        .select("companyId")
        .session(session || null)
        .lean();
      destCompanyId = destBranchDoc?.companyId || null;
    } catch {
      // ignore
    }
  }

  const isAlreadyIngestedToStore = Boolean(returnDoc.ingestionDetails?.ingestedToStore);

  for (const item of returnDoc.items) {
    const isBroken =
      item.sourceBin === "SCRAP_BROKEN" ||
      returnDoc.returnMotive === "BROKEN" ||
      (item.batchNo && item.batchNo.includes("[BROKEN]"));
    const isExpired =
      item.sourceBin === "SCRAP_EXPIRED" ||
      returnDoc.returnMotive === "EXPIRED" ||
      (item.batchNo && item.batchNo.includes("[EXPIRED]"));
    const isFresh = !isBroken && !isExpired;

    const cleanBatchNo = (item.batchNo || "")
      .replace(/\s*\[(EXPIRED|BROKEN|SCRAP|IN|INCOMING|FRESH_RETURN)\]/gi, "")
      .trim();

    // ────────────────────────────────────────────────────────────────────────
    // CASE A: Fresh item that has ALREADY been ingested into store inventory
    // ────────────────────────────────────────────────────────────────────────
    if (isFresh && isAlreadyIngestedToStore) {
      // Clean up any errant scrap batches created for this consignment in destBranchId
      const errantScrapBatches = await Batch.find({
        workspaceId,
        branch_id: destBranchId,
        product: item.productId,
        $or: [
          { sourceConsignmentId: returnDoc._id },
          { batchNo: `${cleanBatchNo} [FRESH_RETURN]` },
          { batchNo: `${cleanBatchNo} [SCRAP]` },
        ],
        scrapQty: { $gt: 0 },
      }).session(session || null);

      for (const eb of errantScrapBatches) {
        const deduct = Math.min(Number(eb.scrapQty) || 0, Number(item.returnQty));
        if (deduct > 0) {
          eb.scrapQty = Math.max(0, (Number(eb.scrapQty) || 0) - deduct);
          if (eb.scrapQty === 0 && (Number(eb.batchQty) || 0) === 0) {
            eb.isDeleted = true;
          }
          await eb.save({ session: session || undefined });

          await ProductFacility.updateOne(
            {
              workspaceId,
              facility_id: destBranchId,
              product_id: item.productId,
            },
            { $inc: { scrapQty: -deduct } },
            { session: session || undefined }
          );
        }
      }

      // DO NOT add to scrap bin or duplicate shelf inventory
      continue;
    }

    let sourceBatch = null;
    try {
      if (item.batchId) {
        sourceBatch = await Batch.findById(item.batchId).session(session || null);
      }
      if (!sourceBatch) {
        sourceBatch = await Batch.findOne({
          workspaceId,
          branch_id: branchId,
          product: item.productId,
          batchNo: item.batchNo,
        }).session(session || null);
      }
    } catch {
      // Non-blocking fallback
    }

    const originalBatchNo = sourceBatch?.originalBatchNo || cleanBatchNo;
    const resolvedExpiry = item.expiry || sourceBatch?.expiryDate || "";

    // Resolve the destination company's OWN original PurchaseBill (e.g. Agam's bill from Aristo)
    // Never copy a foreign company's purchaseBillId (e.g. Pahuch's bill from Agam) onto destBatch!
    let resolvedDestPurchaseBillId = null;
    const isSameCompany =
      destCompanyId &&
      returnDoc.companyId &&
      String(destCompanyId) === String(returnDoc.companyId);

    if (isSameCompany) {
      resolvedDestPurchaseBillId = sourceBatch?.purchaseBillId || item.purchaseBillId || null;
    } else if (destCompanyId) {
      const resolvedBill = await resolveOriginalPurchaseBillForDestination({
        workspaceId,
        destCompanyId,
        destBranchId,
        productId: item.productId,
        batchNo: originalBatchNo,
        sourcePurchaseBillId: sourceBatch?.purchaseBillId || item.purchaseBillId || null,
        candidateInvoiceNos: item.purchaseBillNo ? [item.purchaseBillNo] : [],
        sourceConsignmentId: returnDoc._id,
        session,
      });
      resolvedDestPurchaseBillId = resolvedBill?._id || null;
    }

    // ────────────────────────────────────────────────────────────────────────
    // CASE B: Fresh return item (SELLABLE) arriving in consignment box
    // Ingest directly into destination branch's ACTIVE SHELF INVENTORY (Stock Matrix)
    // ────────────────────────────────────────────────────────────────────────
    if (isFresh) {
      let destBatch = await Batch.findOne({
        workspaceId,
        branch_id: destBranchId,
        product: item.productId,
        batchNo: cleanBatchNo,
        scrapType: { $in: ["NONE", null] },
      }).session(session || null);

      if (destBatch) {
        destBatch.batchQty = Number(destBatch.batchQty || 0) + Number(item.returnQty);
        destBatch.isDeleted = false;
        destBatch.originalBatchNo = originalBatchNo;
        destBatch.isIncoming = true;
        destBatch.sourceBranchId = branchId;
        destBatch.sourceCompanyId = returnDoc.companyId;
        destBatch.sourceConsignmentId = returnDoc._id;
        destBatch.sourceTransferOrderNo = returnDoc.debitNoteNo || returnDoc.returnNo;
        if (!destBatch.expiryDate && resolvedExpiry) {
          destBatch.expiryDate = resolvedExpiry;
        }
        if (resolvedDestPurchaseBillId) {
          destBatch.purchaseBillId = resolvedDestPurchaseBillId;
        }
        await destBatch.save({ session: session || undefined });
      } else {
        destBatch = new Batch({
          workspaceId,
          branch_id: destBranchId,
          product: item.productId,
          batchNo: cleanBatchNo,
          originalBatchNo,
          scrapType: "NONE",
          batchQty: Number(item.returnQty),
          scrapQty: 0,
          brokenQty: 0,
          expiredQty: 0,
          isIncoming: true,
          sourceBranchId: branchId,
          sourceCompanyId: returnDoc.companyId,
          sourceConsignmentId: returnDoc._id,
          sourceTransferOrderNo: returnDoc.debitNoteNo || returnDoc.returnNo,
          purchaseBillId: resolvedDestPurchaseBillId,
          mrp: sourceBatch?.mrp || sourceBatch?.MRP || item.mrp || 0,
          MRP: sourceBatch?.MRP || sourceBatch?.mrp || item.mrp || 0,
          ptr: sourceBatch?.ptr || item.rate || 0,
          pts: sourceBatch?.pts || 0,
          rate: sourceBatch?.rate || item.rate || 0,
          finalRateA: sourceBatch?.finalRateA || item.rate || 0,
          finalRateB: sourceBatch?.finalRateB || 0,
          finalRateC: sourceBatch?.finalRateC || 0,
          rateA: sourceBatch?.rateA || item.rate || 0,
          rateB: sourceBatch?.rateB || 0,
          rateC: sourceBatch?.rateC || 0,
          rateD: sourceBatch?.rateD || 0,
          rateE: sourceBatch?.rateE || 0,
          rateAPercentage: sourceBatch?.rateAPercentage || 0,
          expiryDate: resolvedExpiry,
        });
        await destBatch.save({ session: session || undefined });
      }

      let destFacility = await ProductFacility.findOne({
        workspaceId,
        facility_id: destBranchId,
        product_id: item.productId,
      }).session(session || null);

      if (destFacility) {
        destFacility.total_qty_available =
          Number(destFacility.total_qty_available || 0) + Number(item.returnQty);
        destFacility.qoh = Number(destFacility.qoh || 0) + Number(item.returnQty);
        destFacility.atp = Number(destFacility.atp || 0) + Number(item.returnQty);
        await destFacility.save({ session: session || undefined });
      } else {
        destFacility = new ProductFacility({
          workspaceId,
          facility_id: destBranchId,
          product_id: item.productId,
          total_qty_available: Number(item.returnQty),
          qoh: Number(item.returnQty),
          atp: Number(item.returnQty),
          scrapQty: 0,
          brokenQty: 0,
          expiredQty: 0,
        });
        await destFacility.save({ session: session || undefined });
      }

      // Done with fresh item: sellable stock incremented in Stock Matrix, scrap bin NOT touched!
      continue;
    }

    // ────────────────────────────────────────────────────────────────────────
    // CASE C: Broken or Expired item arriving in consignment box
    // Quarantined into destination branch's SCRAP BIN
    // ────────────────────────────────────────────────────────────────────────
    const resolvedScrapType = isBroken ? "BROKEN" : "EXPIRED";
    const targetBatchNo = `${cleanBatchNo} [${resolvedScrapType}]`;

    let destBatch = await Batch.findOne({
      workspaceId,
      branch_id: destBranchId,
      product: item.productId,
      batchNo: targetBatchNo,
    }).session(session || null);

    if (destBatch) {
      destBatch.scrapQty = Number(destBatch.scrapQty || 0) + Number(item.returnQty);
      if (resolvedScrapType === "BROKEN") {
        destBatch.brokenQty = Number(destBatch.brokenQty || 0) + Number(item.returnQty);
      } else {
        destBatch.expiredQty = Number(destBatch.expiredQty || 0) + Number(item.returnQty);
      }
      destBatch.scrapType = resolvedScrapType;
      destBatch.originalBatchNo = originalBatchNo;
      destBatch.isIncoming = true;
      destBatch.sourceBranchId = branchId;
      destBatch.sourceCompanyId = returnDoc.companyId;
      destBatch.sourceConsignmentId = returnDoc._id;
      destBatch.sourceTransferOrderNo = returnDoc.debitNoteNo || returnDoc.returnNo;
      if (!destBatch.expiryDate && resolvedExpiry) {
        destBatch.expiryDate = resolvedExpiry;
      }
      if (resolvedDestPurchaseBillId) {
        destBatch.purchaseBillId = resolvedDestPurchaseBillId;
      }
      await destBatch.save({ session: session || undefined });
    } else {
      destBatch = new Batch({
        workspaceId,
        branch_id: destBranchId,
        product: item.productId,
        batchNo: targetBatchNo,
        originalBatchNo,
        scrapType: resolvedScrapType,
        batchQty: 0,
        scrapQty: Number(item.returnQty),
        brokenQty: resolvedScrapType === "BROKEN" ? Number(item.returnQty) : 0,
        expiredQty: resolvedScrapType === "EXPIRED" ? Number(item.returnQty) : 0,
        isIncoming: true,
        sourceBranchId: branchId,
        sourceCompanyId: returnDoc.companyId,
        sourceConsignmentId: returnDoc._id,
        sourceTransferOrderNo: returnDoc.debitNoteNo || returnDoc.returnNo,
        purchaseBillId: resolvedDestPurchaseBillId,
        mrp: sourceBatch?.mrp || sourceBatch?.MRP || item.mrp || 0,
        MRP: sourceBatch?.MRP || sourceBatch?.mrp || item.mrp || 0,
        ptr: sourceBatch?.ptr || item.rate || 0,
        pts: sourceBatch?.pts || 0,
        rate: sourceBatch?.rate || item.rate || 0,
        finalRateA: sourceBatch?.finalRateA || item.rate || 0,
        finalRateB: sourceBatch?.finalRateB || 0,
        finalRateC: sourceBatch?.finalRateC || 0,
        rateA: sourceBatch?.rateA || item.rate || 0,
        rateB: sourceBatch?.rateB || 0,
        rateC: sourceBatch?.rateC || 0,
        rateD: sourceBatch?.rateD || 0,
        rateE: sourceBatch?.rateE || 0,
        rateAPercentage: sourceBatch?.rateAPercentage || 0,
        expiryDate: resolvedExpiry,
      });
      await destBatch.save({ session: session || undefined });
    }

    let destFacility = await ProductFacility.findOne({
      workspaceId,
      facility_id: destBranchId,
      product_id: item.productId,
    }).session(session || null);

    if (destFacility) {
      destFacility.scrapQty = Number(destFacility.scrapQty || 0) + Number(item.returnQty);
      if (resolvedScrapType === "BROKEN") {
        destFacility.brokenQty = Number(destFacility.brokenQty || 0) + Number(item.returnQty);
      } else {
        destFacility.expiredQty = Number(destFacility.expiredQty || 0) + Number(item.returnQty);
      }
      await destFacility.save({ session: session || undefined });
    } else {
      destFacility = new ProductFacility({
        workspaceId,
        facility_id: destBranchId,
        product_id: item.productId,
        total_qty_available: 0,
        qoh: 0,
        scrapQty: Number(item.returnQty),
        brokenQty: resolvedScrapType === "BROKEN" ? Number(item.returnQty) : 0,
        expiredQty: resolvedScrapType === "EXPIRED" ? Number(item.returnQty) : 0,
      });
      await destFacility.save({ session: session || undefined });
    }
  }

  if (session) {
    await PurchaseReturn.updateOne(
      { _id: returnDoc._id },
      { $set: { "shippingDetails.inventoryMaterialized": true } },
      { session }
    );
  }
};

/**
 * Mark Incoming Purchase Return Box as Received at Destination Branch
 */
const receiveReturnBox = async (
  returnId,
  companyId,
  branchId,
  workspaceId,
  userId
) => {
  const returnDoc = await PurchaseReturn.findOne({
    _id: returnId,
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
  });

  if (!returnDoc) {
    throw new ApiError(404, "Purchase return record not found");
  }

  if (returnDoc.shippingDetails?.transitStatus === "RECEIVED") {
    throw new ApiError(400, "This consignment box has already been marked as received");
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // 1. Materialize incoming scrap batches in destination branch
    await materializeConsignmentBatches(returnDoc, session);

    // 2. Mark transit status as RECEIVED and inventoryMaterialized as true
    const updated = await PurchaseReturn.findOneAndUpdate(
      {
        _id: returnDoc._id,
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
      },
      {
        $set: {
          "shippingDetails.transitStatus": "RECEIVED",
          "shippingDetails.receivedAt": new Date(),
          "shippingDetails.receivedBy": new mongoose.Types.ObjectId(userId),
          "shippingDetails.inventoryMaterialized": true,
        },
      },
      { new: true, session }
    )
      .populate("companyId", "name legalName")
      .populate("branchId", "name branchCode address")
      .populate("shippingDetails.destinationCompanyId", "name legalName")
      .populate("shippingDetails.destinationBranchId", "name branchCode address phone")
      .populate("shippingDetails.receivedBy", "name")
      .populate("supplierId", "businessName gstNumber")
      .lean();

    await session.commitTransaction();
    session.endSession();

    if (returnDoc.isInterCompany || returnDoc.shippingDetails?.destinationCompanyId) {
      syncInterCompanyDestinationLedger(returnDoc, userId).catch(() => {});
    }

    return updated;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

/**
 * Ingest Fresh General Return stock from a Debit Note directly into the active store's shelf inventory
 */
const ingestFreshStockToStore = async (
  returnId,
  companyId,
  targetBranchId,
  workspaceId,
  userId
) => {
  const returnDoc = await PurchaseReturn.findOne({
    _id: returnId,
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
  });

  if (!returnDoc) {
    throw new ApiError(404, "Debit Note / Purchase Return record not found");
  }

  if (returnDoc.ingestionDetails?.ingestedToStore) {
    throw new ApiError(400, "This Debit Note has already been ingested into store inventory");
  }

  const resolvedBranchId =
    targetBranchId ||
    returnDoc.shippingDetails?.destinationBranchId ||
    returnDoc.branchId;

  if (!resolvedBranchId) {
    throw new ApiError(400, "Target store facility is required for ingestion");
  }

  // Prevent ingesting back into the creation / origin branch if a destination facility exists
  if (
    returnDoc.shippingDetails?.destinationBranchId &&
    String(resolvedBranchId) === String(returnDoc.branchId)
  ) {
    throw new ApiError(
      400,
      "Fresh stock cannot be ingested back into the origin (creation) branch. Ingestion is only permitted at the destination receiving branch."
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const branchObjId = new mongoose.Types.ObjectId(resolvedBranchId);
    const workspaceObjId = new mongoose.Types.ObjectId(workspaceId);

    // Filter items eligible for fresh shelf ingestion:
    // Either return is SELLABLE motive, or item sourceBin is SCRAP_FRESH or SELLABLE, or not broken/expired
    const freshItems = (returnDoc.items || []).filter((item) => {
      const isBroken =
        item.sourceBin === "SCRAP_BROKEN" ||
        returnDoc.returnMotive === "BROKEN" ||
        (item.batchNo && item.batchNo.includes("[BROKEN]"));
      const isExpired =
        item.sourceBin === "SCRAP_EXPIRED" ||
        returnDoc.returnMotive === "EXPIRED" ||
        (item.batchNo && item.batchNo.includes("[EXPIRED]"));
      return !isBroken && !isExpired;
    });

    if (freshItems.length === 0) {
      throw new ApiError(
        400,
        "No fresh general items found in this Debit Note eligible for shelf inventory ingestion"
      );
    }

    for (const item of freshItems) {
      const cleanBatchNo = stripBatchTags(item.batchNo);
      const productObjId = new mongoose.Types.ObjectId(item.productId);
      const qtyToIngest = Number(item.returnQty) || 0;

      if (qtyToIngest <= 0) continue;

      // 1. Find or create sellable shelf batch in resolvedBranchId
      let shelfBatch = await Batch.findOne({
        workspaceId: workspaceObjId,
        branch_id: branchObjId,
        product: productObjId,
        batchNo: cleanBatchNo,
        scrapType: { $in: ["NONE", null] },
        isDeleted: false,
      }).session(session);

      if (!shelfBatch) {
        shelfBatch = await Batch.findOne({
          workspaceId: workspaceObjId,
          branch_id: branchObjId,
          product: productObjId,
          originalBatchNo: cleanBatchNo,
          scrapType: { $in: ["NONE", null] },
          isDeleted: false,
        }).session(session);
      }

      let sourceBatch = null;
      if (item.batchId) {
        sourceBatch = await Batch.findById(item.batchId).session(session);
      }

      if (shelfBatch) {
        shelfBatch.batchQty = (Number(shelfBatch.batchQty) || 0) + qtyToIngest;
        shelfBatch.isDeleted = false;
        if (!shelfBatch.expiryDate && item.expiry) {
          shelfBatch.expiryDate = item.expiry;
        }
        await shelfBatch.save({ session });
      } else {
        shelfBatch = new Batch({
          workspaceId: workspaceObjId,
          branch_id: branchObjId,
          product: productObjId,
          batchNo: cleanBatchNo,
          originalBatchNo: cleanBatchNo,
          scrapType: "NONE",
          batchQty: qtyToIngest,
          scrapQty: 0,
          brokenQty: 0,
          expiredQty: 0,
          isIncoming: false,
          purchaseBillId: sourceBatch?.purchaseBillId || item.purchaseBillId || null,
          mrp: sourceBatch?.mrp || sourceBatch?.MRP || item.mrp || 0,
          MRP: sourceBatch?.MRP || sourceBatch?.mrp || item.mrp || 0,
          ptr: sourceBatch?.ptr || item.rate || 0,
          pts: sourceBatch?.pts || 0,
          rate: sourceBatch?.rate || item.rate || 0,
          finalRateA: sourceBatch?.finalRateA || item.rate || 0,
          expiryDate: item.expiry || sourceBatch?.expiryDate || "",
        });
        await shelfBatch.save({ session });
      }

      // 2. Increment ProductFacility active shelf inventory
      let facility = await ProductFacility.findOne({
        workspaceId: workspaceObjId,
        facility_id: branchObjId,
        product_id: productObjId,
      }).session(session);

      if (facility) {
        facility.total_qty_available = (Number(facility.total_qty_available) || 0) + qtyToIngest;
        facility.qoh = (Number(facility.qoh) || 0) + qtyToIngest;
        facility.atp = (Number(facility.atp) || 0) + qtyToIngest;
        await facility.save({ session });
      } else {
        facility = new ProductFacility({
          workspaceId: workspaceObjId,
          facility_id: branchObjId,
          product_id: productObjId,
          total_qty_available: qtyToIngest,
          qoh: qtyToIngest,
          atp: qtyToIngest,
          scrapQty: 0,
        });
        await facility.save({ session });
      }

      // 3. Deduct scrap stock from any quarantine scrap bin batches (both origin and destination/consignment)
      if (sourceBatch && (sourceBatch.scrapQty || 0) >= qtyToIngest) {
        await Batch.updateOne(
          { _id: sourceBatch._id },
          { $inc: { scrapQty: -qtyToIngest } },
          { session }
        );
        await ProductFacility.updateOne(
          {
            workspaceId: workspaceObjId,
            facility_id: sourceBatch.branch_id || branchObjId,
            product_id: productObjId,
          },
          { $inc: { scrapQty: -qtyToIngest } },
          { session }
        );
      }

      // Also clean up any consignment scrap batches created in destination branch or current branch
      const consignmentScrapBatches = await Batch.find({
        workspaceId: workspaceObjId,
        product: productObjId,
        $or: [
          { sourceConsignmentId: returnDoc._id },
          { batchNo: `${cleanBatchNo} [FRESH_RETURN]` },
          { batchNo: `${cleanBatchNo} [SCRAP]` },
        ],
        scrapQty: { $gt: 0 },
      }).session(session);

      for (const sb of consignmentScrapBatches) {
        const deduct = Math.min(Number(sb.scrapQty) || 0, qtyToIngest);
        if (deduct > 0) {
          sb.scrapQty = Math.max(0, (Number(sb.scrapQty) || 0) - deduct);
          if (sb.scrapQty === 0 && (Number(sb.batchQty) || 0) === 0) {
            sb.isDeleted = true;
          }
          await sb.save({ session });

          await ProductFacility.updateOne(
            {
              workspaceId: workspaceObjId,
              facility_id: sb.branch_id,
              product_id: productObjId,
            },
            { $inc: { scrapQty: -deduct } },
            { session }
          );
        }
      }
    }

    // 4. Update PurchaseReturn ingestionDetails
    returnDoc.ingestionDetails = {
      ingestedToStore: true,
      ingestedAt: new Date(),
      ingestedBy: userId || null,
      ingestedBranchId: branchObjId,
    };
    await returnDoc.save({ session });

    await session.commitTransaction();
    session.endSession();

    const updated = await PurchaseReturn.findById(returnDoc._id)
      .populate("companyId", "name legalName")
      .populate("branchId", "name branchCode address")
      .populate("supplierId", "businessName gstNumber")
      .populate("ingestionDetails.ingestedBranchId", "name branchCode")
      .populate("ingestionDetails.ingestedBy", "name")
      .lean();

    return updated;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

/**
 * Quarantine Broken & Expired items from an Inter-Company Debit Note into the target facility's Scrap Bin
 */
const quarantineScrapToStore = async (
  returnId,
  companyId,
  targetBranchId,
  workspaceId,
  userId
) => {
  const returnDoc = await PurchaseReturn.findOne({
    _id: returnId,
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
  });

  if (!returnDoc) {
    throw new ApiError(404, "Debit Note / Purchase Return record not found");
  }

  if (returnDoc.scrapDetails?.quarantined) {
    throw new ApiError(400, "Damaged and expired items have already been quarantined to scrap bin");
  }

  const resolvedBranchId =
    targetBranchId ||
    returnDoc.shippingDetails?.destinationBranchId ||
    returnDoc.branchId;

  if (!resolvedBranchId) {
    throw new ApiError(400, "Target store facility is required for scrap quarantine");
  }

  const branchObjId = new mongoose.Types.ObjectId(resolvedBranchId);
  const workspaceObjId = new mongoose.Types.ObjectId(workspaceId);

  // Filter broken and expired items
  const scrapItems = (returnDoc.items || []).filter((item) => {
    const isBroken =
      item.sourceBin === "SCRAP_BROKEN" ||
      returnDoc.returnMotive === "BROKEN" ||
      (item.batchNo && item.batchNo.includes("[BROKEN]")) ||
      item.motive === "broken" ||
      item.condition === "broken" ||
      String(item.condition || "").includes("damag");
    const isExpired =
      item.sourceBin === "SCRAP_EXPIRED" ||
      returnDoc.returnMotive === "EXPIRED" ||
      (item.batchNo && item.batchNo.includes("[EXPIRED]")) ||
      item.motive === "expired" ||
      item.condition === "expired" ||
      String(item.condition || "").includes("expir");
    return isBroken || isExpired;
  });

  if (scrapItems.length === 0) {
    throw new ApiError(
      400,
      "No damaged or expired items found in this Debit Note eligible for scrap bin quarantine"
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    for (const item of scrapItems) {
      const cleanBatchNo = stripBatchTags(item.batchNo);
      const productObjId = new mongoose.Types.ObjectId(item.productId);
      const qtyToQuarantine = Math.max(0, Number(item.returnQty || item.qty || 0));

      if (qtyToQuarantine <= 0) continue;

      const isBroken =
        item.sourceBin === "SCRAP_BROKEN" ||
        returnDoc.returnMotive === "BROKEN" ||
        (item.batchNo && item.batchNo.includes("[BROKEN]")) ||
        item.motive === "broken" ||
        item.condition === "broken" ||
        String(item.condition || "").includes("damag");
      const resolvedScrapType = isBroken ? "BROKEN" : "EXPIRED";
      const targetBatchNo = `${cleanBatchNo} [${resolvedScrapType}]`;

      // Find source batch if any to copy rates/expiry/mrp
      let sourceBatch = null;
      try {
        if (item.batchId) {
          sourceBatch = await Batch.findById(item.batchId).session(session);
        }
        if (!sourceBatch) {
          sourceBatch = await Batch.findOne({
            workspaceId: workspaceObjId,
            product: productObjId,
            batchNo: item.batchNo,
          }).session(session);
        }
      } catch {
        // Non-blocking
      }

      const originalBatchNo = sourceBatch?.originalBatchNo || cleanBatchNo;
      const resolvedExpiry = item.expiry || sourceBatch?.expiryDate || "";

      // 1. Find or create quarantine scrap batch in target branch
      let scrapBatch = await Batch.findOne({
        workspaceId: workspaceObjId,
        branch_id: branchObjId,
        product: productObjId,
        batchNo: targetBatchNo,
      }).session(session);

      if (scrapBatch) {
        scrapBatch.scrapQty = (Number(scrapBatch.scrapQty) || 0) + qtyToQuarantine;
        if (resolvedScrapType === "BROKEN") {
          scrapBatch.brokenQty = (Number(scrapBatch.brokenQty) || 0) + qtyToQuarantine;
        } else {
          scrapBatch.expiredQty = (Number(scrapBatch.expiredQty) || 0) + qtyToQuarantine;
        }
        scrapBatch.scrapType = resolvedScrapType;
        scrapBatch.originalBatchNo = originalBatchNo;
        scrapBatch.isIncoming = true;
        scrapBatch.sourceBranchId = returnDoc.branchId;
        scrapBatch.sourceCompanyId = returnDoc.companyId;
        scrapBatch.sourceConsignmentId = returnDoc._id;
        scrapBatch.sourceTransferOrderNo = returnDoc.debitNoteNo || returnDoc.returnNo;
        scrapBatch.isDeleted = false;
        if (!scrapBatch.expiryDate && resolvedExpiry) {
          scrapBatch.expiryDate = resolvedExpiry;
        }
        await scrapBatch.save({ session });
      } else {
        scrapBatch = new Batch({
          workspaceId: workspaceObjId,
          branch_id: branchObjId,
          product: productObjId,
          batchNo: targetBatchNo,
          originalBatchNo,
          scrapType: resolvedScrapType,
          batchQty: 0,
          scrapQty: qtyToQuarantine,
          brokenQty: resolvedScrapType === "BROKEN" ? qtyToQuarantine : 0,
          expiredQty: resolvedScrapType === "EXPIRED" ? qtyToQuarantine : 0,
          isIncoming: true,
          sourceBranchId: returnDoc.branchId,
          sourceCompanyId: returnDoc.companyId,
          sourceConsignmentId: returnDoc._id,
          sourceTransferOrderNo: returnDoc.debitNoteNo || returnDoc.returnNo,
          mrp: sourceBatch?.mrp || sourceBatch?.MRP || item.mrp || 0,
          MRP: sourceBatch?.MRP || sourceBatch?.mrp || item.mrp || 0,
          ptr: sourceBatch?.ptr || item.rate || 0,
          pts: sourceBatch?.pts || 0,
          rate: sourceBatch?.rate || item.rate || 0,
          finalRateA: sourceBatch?.finalRateA || item.rate || 0,
          finalRateB: sourceBatch?.finalRateB || 0,
          finalRateC: sourceBatch?.finalRateC || 0,
          rateA: sourceBatch?.rateA || item.rate || 0,
          rateB: sourceBatch?.rateB || 0,
          rateC: sourceBatch?.rateC || 0,
          rateD: sourceBatch?.rateD || 0,
          rateE: sourceBatch?.rateE || 0,
          rateAPercentage: sourceBatch?.rateAPercentage || 0,
          expiryDate: resolvedExpiry,
        });
        await scrapBatch.save({ session });
      }

      // 2. Increment ProductFacility scrap inventory
      let facility = await ProductFacility.findOne({
        workspaceId: workspaceObjId,
        facility_id: branchObjId,
        product_id: productObjId,
      }).session(session);

      if (facility) {
        facility.scrapQty = (Number(facility.scrapQty) || 0) + qtyToQuarantine;
        if (resolvedScrapType === "BROKEN") {
          facility.brokenQty = (Number(facility.brokenQty) || 0) + qtyToQuarantine;
        } else {
          facility.expiredQty = (Number(facility.expiredQty) || 0) + qtyToQuarantine;
        }
        await facility.save({ session });
      } else {
        facility = new ProductFacility({
          workspaceId: workspaceObjId,
          facility_id: branchObjId,
          product_id: productObjId,
          total_qty_available: 0,
          qoh: 0,
          atp: 0,
          scrapQty: qtyToQuarantine,
          brokenQty: resolvedScrapType === "BROKEN" ? qtyToQuarantine : 0,
          expiredQty: resolvedScrapType === "EXPIRED" ? qtyToQuarantine : 0,
        });
        await facility.save({ session });
      }
    }

    // 3. Mark PurchaseReturn scrapDetails and shippingDetails
    returnDoc.scrapDetails = {
      quarantined: true,
      quarantinedAt: new Date(),
      quarantinedBy: userId || null,
      quarantinedBranchId: branchObjId,
    };
    if (returnDoc.shippingDetails) {
      if (!returnDoc.shippingDetails.destinationBranchId) {
        returnDoc.shippingDetails.destinationBranchId = branchObjId;
      }
      returnDoc.shippingDetails.inventoryMaterialized = true;
    }
    await returnDoc.save({ session });

    await session.commitTransaction();
    session.endSession();

    const updated = await PurchaseReturn.findById(returnDoc._id)
      .populate("companyId", "name legalName")
      .populate("branchId", "name branchCode address")
      .populate("supplierId", "businessName gstNumber")
      .populate("scrapDetails.quarantinedBranchId", "name branchCode")
      .populate("scrapDetails.quarantinedBy", "name")
      .lean();

    return updated;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

const purchaseReturnService = {
  ensurePurchaseAccounts,
  getEligibleBatchesForReturn,
  createPurchaseReturn,
  getPurchaseReturns,
  getPurchaseReturnById,
  cancelPurchaseReturn,
  dispatchReturnBox,
  syncPurchaseReturnLedger,
  receiveReturnBox,
  ingestFreshStockToStore,
  quarantineScrapToStore,
  materializeConsignmentBatches,
  resolveOriginalPurchaseBillForDestination,
  resolveSubSupplierFromPurchaseBill,
  resolveInterCompanyDestination,
  syncInterCompanyDestinationLedger,
};

export default purchaseReturnService;

