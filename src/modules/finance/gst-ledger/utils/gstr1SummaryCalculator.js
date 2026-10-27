/**
 * GSTR-1 Summary Calculator for Backend
 */

const round2 = (num) => Math.round((Number(num) || 0) * 100) / 100;

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const isValidGstin = (gstin) => {
  if (!gstin || typeof gstin !== "string") return false;
  return GSTIN_REGEX.test(gstin.trim().toUpperCase());
};

export const deduceGstrGroup = (entry) => {
  if (entry?.groupDescription && typeof entry.groupDescription === "string" && entry.groupDescription.trim()) {
    return entry.groupDescription.trim();
  }

  const gstType = String(entry?.gstType || "").toUpperCase();
  if (gstType === "GSTR-2") {
    return "B2B Supplies";
  }

  const narration = String(entry?.narration || "").toUpperCase();
  const rawDocType = String(entry?.documentType || entry?.voucherType || entry?.type || "").toUpperCase();
  const partyGstin = (entry?.partyGstin || entry?.partyId?.gstNumber || entry?.customerGstin || "").trim().toUpperCase();
  const hasValidPartyGstin = isValidGstin(partyGstin);

  const taxableAmount = Number(entry?.taxableAmount || 0);
  const cgst = Number(entry?.cgst || 0);
  const sgst = Number(entry?.sgst || 0);
  const igst = Number(entry?.igst || 0);
  const cess = Number(entry?.cess || 0);
  const totalAmount = Number(entry?.totalAmount !== undefined ? entry.totalAmount : (taxableAmount + cgst + sgst + igst + cess));
  const totalTax = cgst + sgst + igst + cess;

  const vNum = String(entry?.voucherNumber || "").toUpperCase();

  if (entry?.isExport || rawDocType.includes("EXPORT") || narration.includes("EXPORT")) {
    return "Export Invoices";
  }
  if (rawDocType.includes("ADVANCE_RECEIVED") || narration.includes("ADVANCE RECEIVED")) {
    return "Tax Liability on Advance";
  }
  if (rawDocType.includes("ADVANCE_SETTLED") || narration.includes("ADVANCE SETTLED") || narration.includes("SET-OFF ADVANCE")) {
    return "Set/off Tax on Advance of prior period";
  }
  if (rawDocType.includes("REFUND_VOUCHER") || narration.includes("REFUND FROM ADVANCE") || narration.includes("REFUND VOUCHER")) {
    return "Refund from Advance";
  }
  if (rawDocType.includes("CREDIT_NOTE") || narration.includes("CREDIT NOTE") || rawDocType.includes("SALE_RETURN") || vNum.startsWith("RET-") || vNum.startsWith("CN-")) {
    return (hasValidPartyGstin || narration.includes("(B2B)")) ? "Credit Note - Registered" : "Credit Note - Unregistered";
  }
  if (rawDocType.includes("DEBIT_NOTE") || narration.includes("DEBIT NOTE") || vNum.startsWith("DN-")) {
    return (hasValidPartyGstin || narration.includes("(B2B)")) ? "Debit Note - Registered" : "Debit Note - Unregistered";
  }
  if (entry?.isNilRated || entry?.taxRate === 0 || narration.includes("NIL RATED") || (taxableAmount > 0 && totalTax === 0)) {
    return "Nil Rated";
  }
  if (entry?.isExempt || narration.includes("EXEMPT")) {
    return "Exempted";
  }
  if (hasValidPartyGstin || narration.includes("(B2B)") || entry?.billingMode === "B2B") {
    return "B2B";
  }
  if (igst > 0 && totalAmount > 250000) {
    return "B2C (Large) Invoice";
  }
  return "B2C (Small) Invoice";
};

export const isCreditNoteEntry = (entry) => {
  if (!entry) return false;
  const group = String(entry.groupDescription || "").toUpperCase();
  const narration = String(entry.narration || "").toUpperCase();
  const vNum = String(entry.voucherNumber || "").toUpperCase();
  const docType = String(entry.documentType || entry.voucherType || entry.type || "").toUpperCase();
  return (
    group.includes("CREDIT NOTE") ||
    group.includes("CDN") ||
    docType.includes("CREDIT_NOTE") ||
    docType.includes("SALE_RETURN") ||
    narration.includes("CREDIT NOTE") ||
    narration.includes("SALES RETURN") ||
    vNum.startsWith("RET-") ||
    vNum.startsWith("CN-")
  );
};

const createEmptyGroup = (description, isSubItem = false) => ({
  description,
  isSubItem,
  count: 0,
  taxable: 0,
  sgst: 0,
  cgst: 0,
  igst: 0,
  cess: 0,
  totalTax: 0,
  invoiceValue: 0,
});

const addValues = (target, src, factor = 1) => {
  target.taxable = round2(target.taxable + factor * (Number(src.taxableAmount || src.taxable || 0)));
  target.sgst = round2(target.sgst + factor * (Number(src.sgst || 0)));
  target.cgst = round2(target.cgst + factor * (Number(src.cgst || 0)));
  target.igst = round2(target.igst + factor * (Number(src.igst || 0)));
  target.cess = round2(target.cess + factor * (Number(src.cess || 0)));
  target.totalTax = round2(target.sgst + target.cgst + target.igst + target.cess);
  target.invoiceValue = round2(target.invoiceValue + factor * (Number(src.totalAmount || src.invoiceValue || 0)));
  target.count += 1;
};

export const calculateGstr1Summary = (entries = [], options = {}) => {
  const companyGstin = (options.companyGstin || "").trim().toUpperCase();
  const companyStateCode = companyGstin.length >= 2 ? companyGstin.slice(0, 2) : "";
  const b2cLargeThreshold = options.b2cLargeThreshold || 250000;

  const b2b = createEmptyGroup("B2B");
  const b2cl = createEmptyGroup("B2C (Large) Invoice");
  const b2cs = createEmptyGroup("B2C (Small) Invoice");
  
  const nilRated = createEmptyGroup("Nil Rated", true);
  const exempted = createEmptyGroup("Exempted", true);
  const nilExemptedParent = createEmptyGroup("Nil Rated/Exempted");

  const exportInvoices = createEmptyGroup("Export Invoices");
  const taxAdvance = createEmptyGroup("Tax Liability on Advance");
  const setOffAdvance = createEmptyGroup("Set/off Tax on Advance of prior period");

  const cdnRegistered = createEmptyGroup("Registered Parties", true);
  const cdnUnregistered = createEmptyGroup("Unregistered Parties", true);
  const cdnRefundAdvance = createEmptyGroup("Refund from Advance", true);
  const creditDebitParent = createEmptyGroup("Less: Credit/Debit Note & Refund Voucher");

  const localSummary = createEmptyGroup("Local (Intra-State)");
  const centralSummary = createEmptyGroup("Central (Inter-State)");

  entries.forEach((entry) => {
    const rawGroup = String(entry.groupDescription || deduceGstrGroup(entry) || "").trim();
    const rawDocType = String(entry.documentType || entry.voucherType || entry.type || "").toUpperCase();
    const narration = String(entry.narration || "").toUpperCase();
    const partyGstin = (entry.partyGstin || entry.partyId?.gstNumber || entry.customerGstin || "").trim().toUpperCase();
    const hasValidPartyGstin = isValidGstin(partyGstin);

    const taxableAmount = round2(Number(entry.taxableAmount || 0));
    const cgst = round2(Number(entry.cgst || 0));
    const sgst = round2(Number(entry.sgst || 0));
    const igst = round2(Number(entry.igst || 0));
    const cess = round2(Number(entry.cess || 0));
    const totalAmount = round2(Number(entry.totalAmount !== undefined ? entry.totalAmount : (taxableAmount + cgst + sgst + igst + cess)));

    const item = {
      taxableAmount,
      cgst,
      sgst,
      igst,
      cess,
      totalAmount,
    };

    const isInterState = igst > 0 || (partyGstin && companyStateCode && partyGstin.slice(0, 2) !== companyStateCode);

    // If explicit groupDescription is stored on the GSTR record:
    if (rawGroup) {
      const gNorm = rawGroup.toUpperCase();
      if (gNorm.includes("B2B")) {
        addValues(b2b, item);
      } else if (gNorm.includes("B2C (LARGE)") || gNorm.includes("B2CL")) {
        addValues(b2cl, item);
      } else if (gNorm.includes("B2C (SMALL)") || gNorm.includes("B2CS")) {
        addValues(b2cs, item);
      } else if (gNorm === "NIL RATED" || gNorm.includes("NIL")) {
        addValues(nilRated, item);
      } else if (gNorm.includes("EXEMPT")) {
        addValues(exempted, item);
      } else if (gNorm.includes("EXPORT")) {
        addValues(exportInvoices, item);
      } else if (gNorm.includes("TAX LIABILITY ON ADVANCE") || gNorm.includes("ADVANCE_RECEIVED")) {
        addValues(taxAdvance, item);
      } else if (gNorm.includes("SET/OFF") || gNorm.includes("SET-OFF") || gNorm.includes("ADVANCE_SETTLED")) {
        addValues(setOffAdvance, item);
      } else if (gNorm.includes("REFUND FROM ADVANCE") || gNorm.includes("REFUND_VOUCHER")) {
        addValues(cdnRefundAdvance, item);
      } else if (gNorm.includes("CREDIT NOTE") || gNorm.includes("DEBIT NOTE") || gNorm.includes("CDN")) {
        if (gNorm.includes("REGISTERED") || hasValidPartyGstin) {
          addValues(cdnRegistered, item);
        } else {
          addValues(cdnUnregistered, item);
        }
      } else {
        // Fallback to B2C Small
        addValues(b2cs, item);
      }

      if (isInterState) {
        addValues(centralSummary, item);
      } else {
        addValues(localSummary, item);
      }
      return;
    }

    // Otherwise, classify based on entry characteristics
    if (entry.isExport || rawDocType.includes("EXPORT") || narration.includes("EXPORT")) {
      addValues(exportInvoices, item);
      centralSummary.count += 1;
      centralSummary.taxable = round2(centralSummary.taxable + taxableAmount);
      centralSummary.igst = round2(centralSummary.igst + igst);
      centralSummary.totalTax = round2(centralSummary.totalTax + igst + cess);
      centralSummary.invoiceValue = round2(centralSummary.invoiceValue + totalAmount);
      return;
    }

    if (rawDocType.includes("ADVANCE_RECEIVED") || narration.includes("ADVANCE RECEIVED")) {
      addValues(taxAdvance, item);
      if (isInterState) addValues(centralSummary, item);
      else addValues(localSummary, item);
      return;
    }

    if (rawDocType.includes("ADVANCE_SETTLED") || narration.includes("ADVANCE SETTLED") || narration.includes("SET-OFF ADVANCE")) {
      addValues(setOffAdvance, item);
      if (isInterState) addValues(centralSummary, item);
      else addValues(localSummary, item);
      return;
    }

    const isCreditNote = rawDocType.includes("CREDIT_NOTE") || narration.includes("CREDIT NOTE") || rawDocType.includes("SALE_RETURN");
    const isDebitNote = rawDocType.includes("DEBIT_NOTE") || narration.includes("DEBIT NOTE");
    const isRefundAdvance = rawDocType.includes("REFUND_VOUCHER") || narration.includes("REFUND FROM ADVANCE");

    if (isCreditNote || isDebitNote || isRefundAdvance) {
      if (isRefundAdvance) {
        addValues(cdnRefundAdvance, item);
      } else if (hasValidPartyGstin) {
        addValues(cdnRegistered, item);
      } else {
        addValues(cdnUnregistered, item);
      }

      const noteFactor = isDebitNote ? 1 : -1;
      if (isInterState) addValues(centralSummary, item, noteFactor);
      else addValues(localSummary, item, noteFactor);
      return;
    }

    if (entry.isNilRated || entry.taxRate === 0 || narration.includes("NIL RATED")) {
      addValues(nilRated, item);
      if (isInterState) addValues(centralSummary, item);
      else addValues(localSummary, item);
      return;
    }

    if (entry.isExempt || narration.includes("EXEMPT")) {
      addValues(exempted, item);
      if (isInterState) addValues(centralSummary, item);
      else addValues(localSummary, item);
      return;
    }

    if (hasValidPartyGstin || entry.billingMode === "B2B") {
      addValues(b2b, item);
    } else {
      if (isInterState && totalAmount > b2cLargeThreshold) {
        addValues(b2cl, item);
      } else {
        addValues(b2cs, item);
      }
    }

    if (isInterState) {
      addValues(centralSummary, item);
    } else {
      addValues(localSummary, item);
    }
  });

  // Calculate parent subtotal: Nil Rated/Exempted
  nilExemptedParent.count = nilRated.count + exempted.count;
  nilExemptedParent.taxable = round2(nilRated.taxable + exempted.taxable);
  nilExemptedParent.sgst = round2(nilRated.sgst + exempted.sgst);
  nilExemptedParent.cgst = round2(nilRated.cgst + exempted.cgst);
  nilExemptedParent.igst = round2(nilRated.igst + exempted.igst);
  nilExemptedParent.cess = round2(nilRated.cess + exempted.cess);
  nilExemptedParent.totalTax = round2(nilRated.totalTax + exempted.totalTax);
  nilExemptedParent.invoiceValue = round2(nilRated.invoiceValue + exempted.invoiceValue);

  // Calculate parent subtotal: Less: Credit/Debit Note & Refund Voucher
  creditDebitParent.count = cdnRegistered.count + cdnUnregistered.count + cdnRefundAdvance.count;
  creditDebitParent.taxable = round2(cdnRegistered.taxable + cdnUnregistered.taxable + cdnRefundAdvance.taxable);
  creditDebitParent.sgst = round2(cdnRegistered.sgst + cdnUnregistered.sgst + cdnRefundAdvance.sgst);
  creditDebitParent.cgst = round2(cdnRegistered.cgst + cdnUnregistered.cgst + cdnRefundAdvance.cgst);
  creditDebitParent.igst = round2(cdnRegistered.igst + cdnUnregistered.igst + cdnRefundAdvance.igst);
  creditDebitParent.cess = round2(cdnRegistered.cess + cdnUnregistered.cess + cdnRefundAdvance.cess);
  creditDebitParent.totalTax = round2(cdnRegistered.totalTax + cdnUnregistered.totalTax + cdnRefundAdvance.totalTax);
  creditDebitParent.invoiceValue = round2(cdnRegistered.invoiceValue + cdnUnregistered.invoiceValue + cdnRefundAdvance.invoiceValue);

  // Overall Total Row
  const totalRow = {
    description: "Total",
    isTotal: true,
    count: b2b.count + b2cl.count + b2cs.count + nilExemptedParent.count + exportInvoices.count + taxAdvance.count + setOffAdvance.count + creditDebitParent.count,
    taxable: round2(
      b2b.taxable + b2cl.taxable + b2cs.taxable + nilExemptedParent.taxable + exportInvoices.taxable + taxAdvance.taxable - setOffAdvance.taxable - creditDebitParent.taxable
    ),
    sgst: round2(
      b2b.sgst + b2cl.sgst + b2cs.sgst + nilExemptedParent.sgst + exportInvoices.sgst + taxAdvance.sgst - setOffAdvance.sgst - creditDebitParent.sgst
    ),
    cgst: round2(
      b2b.cgst + b2cl.cgst + b2cs.cgst + nilExemptedParent.cgst + exportInvoices.cgst + taxAdvance.cgst - setOffAdvance.cgst - creditDebitParent.cgst
    ),
    igst: round2(
      b2b.igst + b2cl.igst + b2cs.igst + nilExemptedParent.igst + exportInvoices.igst + taxAdvance.igst - setOffAdvance.igst - creditDebitParent.igst
    ),
    cess: round2(
      b2b.cess + b2cl.cess + b2cs.cess + nilExemptedParent.cess + exportInvoices.cess + taxAdvance.cess - setOffAdvance.cess - creditDebitParent.cess
    ),
    invoiceValue: round2(
      b2b.invoiceValue + b2cl.invoiceValue + b2cs.invoiceValue + nilExemptedParent.invoiceValue + exportInvoices.invoiceValue + taxAdvance.invoiceValue - setOffAdvance.invoiceValue - creditDebitParent.invoiceValue
    ),
  };
  totalRow.totalTax = round2(totalRow.sgst + totalRow.cgst + totalRow.igst + totalRow.cess);

  localSummary.isSummaryBox = true;
  centralSummary.isSummaryBox = true;

  return {
    groups: [
      b2b,
      b2cl,
      b2cs,
      nilExemptedParent,
      nilRated,
      exempted,
      exportInvoices,
      taxAdvance,
      setOffAdvance,
      creditDebitParent,
      cdnRegistered,
      cdnUnregistered,
      cdnRefundAdvance,
      totalRow,
      localSummary,
      centralSummary,
    ],
    totalRow,
    localSummary,
    centralSummary,
  };
};

export default calculateGstr1Summary;
