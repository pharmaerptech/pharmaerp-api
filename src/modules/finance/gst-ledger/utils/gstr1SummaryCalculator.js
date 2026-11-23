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
  const partyGstin = (
    entry?.partyGstin ||
    entry?.partyId?.gstNumber ||
    entry?.partyId?.gstin ||
    entry?.customerGstin ||
    entry?.customer?.gstNumber ||
    entry?.customer?.gstin ||
    entry?.customerId?.gstNumber ||
    entry?.customerId?.gstin ||
    ""
  ).trim().toUpperCase();
  const hasValidPartyGstin = isValidGstin(partyGstin);

  const gstType = String(entry?.gstType || "").toUpperCase();
  if (gstType === "GSTR-2") {
    return "B2B Supplies";
  }

  const rawGroup = String(entry?.groupDescription || "").trim();
  const gNorm = rawGroup.toUpperCase();
  const narration = String(entry?.narration || "").toUpperCase();
  const rawDocType = String(entry?.documentType || entry?.voucherType || entry?.type || "").toUpperCase();
  const vNum = String(entry?.voucherNumber || "").toUpperCase();

  const taxableAmount = Number(entry?.taxableAmount || 0);
  const cgst = Number(entry?.cgst || 0);
  const sgst = Number(entry?.sgst || 0);
  const igst = Number(entry?.igst || 0);
  const cess = Number(entry?.cess || 0);
  const totalAmount = Number(entry?.totalAmount !== undefined ? entry.totalAmount : (taxableAmount + cgst + sgst + igst + cess));
  const totalTax = cgst + sgst + igst + cess;

  // 1. Export Invoices
  if (gNorm.includes("EXPORT") || entry?.isExport || rawDocType.includes("EXPORT") || narration.includes("EXPORT")) {
    return "Export Invoices";
  }

  // 2. Advance Tax / Adjustments
  if (gNorm.includes("ADVANCE_RECEIVED") || gNorm.includes("TAX LIABILITY ON ADVANCE") || rawDocType.includes("ADVANCE_RECEIVED") || narration.includes("ADVANCE RECEIVED")) {
    return "Tax Liability on Advance";
  }
  if (gNorm.includes("SET/OFF") || gNorm.includes("SET-OFF") || gNorm.includes("ADVANCE_SETTLED") || rawDocType.includes("ADVANCE_SETTLED") || narration.includes("ADVANCE SETTLED") || narration.includes("SET-OFF ADVANCE")) {
    return "Set/off Tax on Advance of prior period";
  }
  if (gNorm.includes("REFUND") || rawDocType.includes("REFUND_VOUCHER") || narration.includes("REFUND FROM ADVANCE") || narration.includes("REFUND VOUCHER")) {
    return "Refund from Advance";
  }

  // 3. Credit Note / Sales Return
  // Registered if party has valid GSTIN; Unregistered if party has no GSTIN
  if (
    gNorm.includes("CREDIT NOTE") ||
    gNorm.includes("SALE RETURN") ||
    gNorm.includes("SALE_RETURN") ||
    gNorm.includes("CDN") ||
    rawDocType.includes("CREDIT_NOTE") ||
    rawDocType.includes("SALE_RETURN") ||
    narration.includes("CREDIT NOTE") ||
    narration.includes("SALES RETURN") ||
    vNum.startsWith("RET-") ||
    vNum.startsWith("CN-")
  ) {
    if (gNorm === "CREDIT NOTE - UNREGISTERED" || gNorm.includes("UNREGISTERED")) {
      return "Credit Note - Unregistered";
    }
    if (gNorm === "CREDIT NOTE - REGISTERED" || gNorm.includes("REGISTERED")) {
      if (entry?.partyGstin === "" || (entry?.partyGstin && !hasValidPartyGstin)) {
        return "Credit Note - Unregistered";
      }
      return "Credit Note - Registered";
    }
    if (hasValidPartyGstin) {
      return "Credit Note - Registered";
    }
    if (narration.includes("(B2B)") && entry?.partyGstin === undefined) {
      return "Credit Note - Registered";
    }
    return "Credit Note - Unregistered";
  }

  // 4. Debit Note
  if (gNorm.includes("DEBIT NOTE") || rawDocType.includes("DEBIT_NOTE") || narration.includes("DEBIT NOTE") || vNum.startsWith("DN-")) {
    if (gNorm === "DEBIT NOTE - UNREGISTERED" || gNorm.includes("UNREGISTERED")) {
      return "Debit Note - Unregistered";
    }
    if (gNorm === "DEBIT NOTE - REGISTERED" || gNorm.includes("REGISTERED")) {
      if (entry?.partyGstin === "" || (entry?.partyGstin && !hasValidPartyGstin)) {
        return "Debit Note - Unregistered";
      }
      return "Debit Note - Registered";
    }
    if (hasValidPartyGstin) {
      return "Debit Note - Registered";
    }
    if (narration.includes("(B2B)") && entry?.partyGstin === undefined) {
      return "Debit Note - Registered";
    }
    return "Debit Note - Unregistered";
  }

  // 5. Nil Rated / Exempted
  if (gNorm === "NIL RATED" || entry?.isNilRated || entry?.taxRate === 0 || narration.includes("NIL RATED") || (taxableAmount > 0 && totalTax === 0)) {
    return "Nil Rated";
  }
  if (gNorm === "EXEMPTED" || entry?.isExempt || narration.includes("EXEMPT")) {
    return "Exempted";
  }

  // 6. Registered B2B Outward Supplies (Only if recipient has valid GSTIN)
  if (hasValidPartyGstin) {
    return "B2B";
  }

  // 7. Unregistered Outward Supplies (B2C Large vs B2C Small)
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

    const group = deduceGstrGroup(entry);

    if (group === "B2B") {
      addValues(b2b, item);
    } else if (group === "B2C (Large) Invoice") {
      addValues(b2cl, item);
    } else if (group === "B2C (Small) Invoice") {
      addValues(b2cs, item);
    } else if (group === "Nil Rated") {
      addValues(nilRated, item);
    } else if (group === "Exempted") {
      addValues(exempted, item);
    } else if (group === "Export Invoices") {
      addValues(exportInvoices, item);
    } else if (group === "Tax Liability on Advance") {
      addValues(taxAdvance, item);
    } else if (group === "Set/off Tax on Advance of prior period") {
      addValues(setOffAdvance, item);
    } else if (group === "Credit Note - Registered") {
      addValues(cdnRegistered, item);
    } else if (group === "Credit Note - Unregistered") {
      addValues(cdnUnregistered, item);
    } else if (group === "Debit Note - Registered") {
      addValues(cdnRegistered, item);
    } else if (group === "Debit Note - Unregistered") {
      addValues(cdnUnregistered, item);
    } else if (group === "Refund from Advance") {
      addValues(cdnRefundAdvance, item);
    } else {
      // Fallback
      if (hasValidPartyGstin) {
        addValues(b2b, item);
      } else if (isInterState && totalAmount > b2cLargeThreshold) {
        addValues(b2cl, item);
      } else {
        addValues(b2cs, item);
      }
    }

    // Local vs Central summary factor:
    // Credit notes and advance set-offs reduce net outward liability
    const isCredit = group.includes("Credit Note") || isCreditNoteEntry(entry);
    const isSetOff = group.includes("Set/off");
    const factor = (isCredit || isSetOff) ? -1 : 1;

    if (isInterState) {
      addValues(centralSummary, item, factor);
    } else {
      addValues(localSummary, item, factor);
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
