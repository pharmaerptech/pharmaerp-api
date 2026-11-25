import { createRequire } from "module";
import Fuse from "fuse.js";
import Supplier from "../../../parties/suppliers/models/supplier.model.js";
import WorkspaceProduct from "../../products/models/workspaceProduct.model.js";

const require = createRequire(import.meta.url);

let PDFParse = null;
try {
  const pdfModule = require("pdf-parse");
  PDFParse = pdfModule.PDFParse || pdfModule.default || pdfModule;
} catch (err) {
  console.warn("pdf-parse module warning:", err.message);
}

/**
 * Normalize an expiry string from e.g. "4/28" to "04/28" or "2028-04"
 */
export const normalizeExpiry = (raw) => {
  if (!raw) return "";
  const str = String(raw).trim();
  const slashMatch = str.match(/^([0-9]{1,2})\/([0-9]{2,4})$/);
  if (slashMatch) {
    const mm = slashMatch[1].padStart(2, "0");
    const yy = slashMatch[2].length === 4 ? slashMatch[2].slice(-2) : slashMatch[2];
    return `${mm}/${yy}`;
  }
  const dashMatch = str.match(/^([0-9]{4})-([0-9]{2})/);
  if (dashMatch) {
    return `${dashMatch[2]}/${dashMatch[1].slice(-2)}`;
  }
  return str;
};

/**
 * Format date string from DD-MM-YYYY or DD/MM/YYYY to YYYY-MM-DD
 */
export const normalizeDate = (raw) => {
  if (!raw) return new Date().toISOString().split("T")[0];
  const str = String(raw).trim();
  const dmy = str.match(/^([0-9]{1,2})[-\/\.]([0-9]{1,2})[-\/\.]([0-9]{2,4})$/);
  if (dmy) {
    const d = dmy[1].padStart(2, "0");
    const m = dmy[2].padStart(2, "0");
    let y = dmy[3];
    if (y.length === 2) y = `20${y}`;
    return `${y}-${m}-${d}`;
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split("T")[0];
  }
  return new Date().toISOString().split("T")[0];
};

/**
 * Extract clean numbers from formatted amounts e.g. "1,559.34" -> 1559.34
 */
export const parseCleanNumber = (val) => {
  if (val === undefined || val === null || val === "") return 0;
  const cleaned = String(val).replace(/,/g, "").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

/**
 * Core text parser for standard Indian Pharma GST invoices (Marg ERP, Galaxy Pharma, Basant, Dawa Bazar)
 */
export const parsePurchaseBillText = (rawText) => {
  if (!rawText || typeof rawText !== "string") {
    return {
      supplier: {},
      buyer: {},
      invoice: {},
      items: [],
      totals: {},
    };
  }

  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // 1. Extract GSTINs (usually 1st is supplier, 2nd is buyer)
  const gstinRegex = /\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/g;
  const gstins = [];
  let gMatch;
  while ((gMatch = gstinRegex.exec(rawText)) !== null) {
    if (!gstins.includes(gMatch[1])) {
      gstins.push(gMatch[1]);
    }
  }

  const supplierGstin = gstins[0] || "";
  const buyerGstin = gstins[1] || "";

  // 2. Extract Supplier Name & Header Details
  let supplierName = "";
  let supplierAddress = "";
  let supplierPhone = "";

  // Look for supplier name near top lines
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const l = lines[i];
    if (/GST\s*INVOICE|TAX\s*INVOICE/i.test(l)) continue;
    if (/^(?:M\/s|M\/S)\s+AGAM/i.test(l) && !supplierName) {
      supplierName = l.replace(/^(?:M\/s|M\/S)\s+/i, "").trim();
      break;
    }
    if (/^[A-Z\s\.\&]{4,}$/.test(l) && !supplierName && !/INVOICE|TAX|PHONE|GSTIN|DAWA\s*BAZAR/i.test(l)) {
      supplierName = l.trim();
      break;
    }
  }

  // Fallback supplier detection
  if (!supplierName) {
    if (/GALAXY\s*PHARMA/i.test(rawText)) supplierName = "GALAXY PHARMA";
    else if (/BASANT\s*MEDICAL\s*STORES/i.test(rawText)) supplierName = "BASANT MEDICAL STORES";
    else if (/AGAM\s*MEDICAL\s*AGENCY/i.test(rawText)) supplierName = "M/S AGAM MEDICAL AGENCY";
    else supplierName = "Imported Supplier";
  }

  // Phone
  const phoneMatch = rawText.match(/Phone\s*:\s*([0-9\s,\-]+)/i);
  if (phoneMatch) supplierPhone = phoneMatch[1].trim();

  // Address
  if (/DAWA\s*BAZAR/i.test(rawText)) {
    supplierAddress = "Dawa Bazar, Indore (M.P.)";
  }

  // 3. Extract Invoice No, Date, Due Date
  let invoiceNo = "";
  let invoiceDate = "";
  let dueDate = "";

  const invMatch = rawText.match(/Invoice\s*No[\.:\s]*([A-Za-z0-9\/\-_]+)/i);
  if (invMatch) {
    invoiceNo = invMatch[1].trim();
  }

  const dateMatch = rawText.match(/(?:Invoice\s*Date|Date)[\.:\s]*([0-9]{1,2}[-\/\.][0-9]{1,2}[-\/\.][0-9]{2,4})/i);
  if (dateMatch) {
    invoiceDate = normalizeDate(dateMatch[1]);
  }

  const dueMatch = rawText.match(/Due\s*Date[\.:\s]*([0-9]{1,2}[-\/\.][0-9]{1,2}[-\/\.][0-9]{2,4})/i);
  if (dueMatch) {
    dueDate = normalizeDate(dueMatch[1]);
  }

  // 4. Line Items Parser
  const items = [];

  // Match items with regex:
  // e.g. "1.) PANTOCID IT 30049039 SIH0775A 4/28 6 379.00 259.89 288.76 0.00 5 1559.34"
  // or "1. 300490 CETANIL TM 50MG TABS 10S DY26931007 5/28 10.00 0.00 180.47 137.50 0.00 0.00 2.50 2.50 1375.00"
  // or "28. CLAVAM FORTE SYP ALKEM 30MLS 30041090 26440977 8/27 9 0.00 182.80 125.35 139.28 16.67 2.50 2.50 1128.15"

  for (const line of lines) {
    // Check if line begins with item index: "1.)", "1.", "28."
    const itemIdxMatch = line.match(/^([0-9]{1,3})[\.\)]+\s*(.+)$/);
    if (!itemIdxMatch) continue;

    const itemContent = itemIdxMatch[2].trim();

    // Look for Expiry token "M/YY" or "MM/YY" e.g. "4/28", "12/27", "11/32"
    const expRegex = /\b([0-1]?[0-9]\/[2-3][0-9])\b/;
    const expMatch = itemContent.match(expRegex);
    if (!expMatch) continue;

    const expIndex = expMatch.index;
    const rawExpiry = expMatch[1];
    const expiry = normalizeExpiry(rawExpiry);

    // Everything before expiry contains: Product name, HSN, Batch (and optional pack/company)
    const beforeExp = itemContent.substring(0, expIndex).trim();
    // Everything after expiry contains numeric fields: Qty, Free, MRP, Rate/PTS, PTR, Disc, GST, Amount
    const afterExp = itemContent.substring(expIndex + rawExpiry.length).trim();

    // Split beforeExp into tokens
    const beforeTokens = beforeExp.split(/\s+/);
    if (beforeTokens.length < 2) continue;

    // Batch is usually the last token before expiry
    const batch = beforeTokens[beforeTokens.length - 1];

    // Split numbers after expiry
    const numTokens = afterExp.split(/\s+/).map(parseCleanNumber);
    // Typical token sequences:
    // Galaxy PDF: [MRP: 379.00, PTS: 259.89, PTR: 288.76, DISC: 0.00, GST: 5, AMOUNT: 1559.34] -> 6 numbers (Qty in beforeTokens)
    // Galaxy text: [Qty: 6, MRP: 379.00, PTS: 259.89, PTR: 288.76, DISC: 0.00, GST: 5, AMOUNT: 1559.34] -> 7 numbers
    // Agam: [Qty: 10.00, Free: 0.00, MRP: 180.47, Rate: 137.50, Sch%: 0, Disc%: 0, CGST%: 2.5, SGST%: 2.5, Amount: 1375.00] -> 9 numbers
    // Basant: [Qty: 20, Free: 0.00, MRP: 24.91, Rate: 17.08, PTR: 18.98, Disc%: 0, SGST%: 2.5, CGST%: 2.5, Amount: 341.60] -> 9 numbers

    let qty = 1;
    let freeQty = 0;
    let mrp = 0;
    let rate = 0;
    let rateA = 0;
    let rateB = 0;
    let disc = 0;
    let gst = 5;
    let amount = 0;
    let qtyFromBeforeTokens = false;

    if (numTokens.length >= 8) {
      qty = numTokens[0];
      freeQty = numTokens[1];
      mrp = numTokens[2];
      rate = numTokens[3];
      rateA = rate;
      rateB = numTokens[4] || rate;
      disc = numTokens[5] || 0;
      const cgst = numTokens[6] || 0;
      const sgst = numTokens[7] || 0;
      gst = cgst + sgst > 0 ? cgst + sgst : (numTokens[8] || 5);
      amount = numTokens[numTokens.length - 1];
    } else if (numTokens.length === 7) {
      qty = numTokens[0];
      freeQty = 0;
      mrp = numTokens[1];
      rate = numTokens[2]; // PTS
      rateA = rate;
      rateB = numTokens[3]; // PTR
      disc = numTokens[4];
      gst = numTokens[5];
      amount = numTokens[6];
    } else if (numTokens.length === 6) {
      // In layouts like Galaxy Pharma PDF, Qty is positioned right before the batch in beforeTokens
      // numTokens: [MRP, PTS, PTR, DISC, GST, AMOUNT]
      mrp = numTokens[0];
      rate = numTokens[1]; // PTS
      rateA = rate;
      rateB = numTokens[2]; // PTR
      disc = numTokens[3];
      gst = numTokens[4];
      amount = numTokens[5];

      const candidateQty = parseCleanNumber(beforeTokens[beforeTokens.length - 2]);
      if (candidateQty > 0) {
        qty = candidateQty;
        qtyFromBeforeTokens = true;
      } else if (rate > 0 && amount > 0) {
        qty = Math.round(amount / rate);
      }
    } else if (numTokens.length >= 4) {
      qty = numTokens[0];
      mrp = numTokens[1];
      rate = numTokens[2];
      rateA = rate;
      amount = numTokens[numTokens.length - 1];
    }

    // Check if there is HSN code (6-8 digits) in beforeTokens
    let hsn = "3004";
    let nameTokens = [];
    let pack = "10's";

    // How many trailing tokens to skip from medicine name (batch, and optional qty / rack)
    const trailingSkipCount = qtyFromBeforeTokens ? 2 : 1;

    for (let t = 0; t < beforeTokens.length - trailingSkipCount; t++) {
      const tok = beforeTokens[t];
      if (/^[0-9]{4,8}$/.test(tok)) {
        hsn = tok;
      } else if (/^(?:10S|8\*6\*2|6X10|14S|500GM|3X10|1\*10S|1\*15|10TAB|10TABS|200ML|200MD|2\.5ML|60'|15'|10'|1'|30'|7\.5|30MLS|10ML|PCS)$/i.test(tok)) {
        pack = tok.toUpperCase();
      } else if (!/^(?:ALKm|ALKEM|CIPLA|MANK|MANKIND|ERIS|LUPIN|SUN)$/i.test(tok)) {
        // Exclude rack numbers if directly before qty
        if (qtyFromBeforeTokens && t === beforeTokens.length - trailingSkipCount - 1 && /^[0-9]{1,3}$/.test(tok)) {
          continue; // Skip rack number
        }
        nameTokens.push(tok);
      }
    }

    const rawName = nameTokens.join(" ").replace(/^[0-9]{4,8}/, "").trim();

    items.push({
      itemIndex: items.length + 1,
      rawName: rawName || `Medicine Item ${items.length + 1}`,
      name: rawName || `Medicine Item ${items.length + 1}`,
      pack,
      hsn,
      batch,
      expiry,
      qty: Number(qty) || 1,
      freeQty: Number(freeQty) || 0,
      mrp: Number(mrp) || 0,
      rate: Number(rate) || 0,
      rateA: Number(rateA) || Number(rate) || 0,
      rateB: Number(rateB) || Number(rate) || 0,
      rateC: Number(rate) || 0,
      disc: Number(disc) || 0,
      schPct: 0,
      gst: Number(gst) || 5,
      amount: Number(amount) || (qty * rate),
      retailerMarginPercent: 20,
      stockistMarginPercent: 10,
    });
  }

  // 5. Extract Totals
  const subtotalMatch = rawText.match(/SUB\s*TOTAL[\s:]*([0-9\.,]+)/i);
  const subtotal = subtotalMatch ? parseCleanNumber(subtotalMatch[1]) : items.reduce((s, i) => s + (i.amount || 0), 0);

  const grandTotalMatch = rawText.match(/GRAND\s*TOTAL[\s:]*([0-9\.,]+)/i);
  const grandTotal = grandTotalMatch ? parseCleanNumber(grandTotalMatch[1]) : Math.round(subtotal * 1.05);

  const sgstMatch = rawText.match(/SGST\s*(?:2\.5\s*%)?[\s:]*([0-9\.,]+)/i);
  const cgstMatch = rawText.match(/CGST\s*(?:2\.5\s*%)?[\s:]*([0-9\.,]+)/i);
  const sgst = sgstMatch ? parseCleanNumber(sgstMatch[1]) : 0;
  const cgst = cgstMatch ? parseCleanNumber(cgstMatch[1]) : 0;

  const discMatch = rawText.match(/(?:Discount|C\.\s*D\.)[\s:]*([0-9\.,\-]+)/i);
  const discount = discMatch ? Math.abs(parseCleanNumber(discMatch[1])) : 0;

  return {
    supplier: {
      name: supplierName,
      gstin: supplierGstin,
      address: supplierAddress,
      phone: supplierPhone,
    },
    buyer: {
      name: /PAHUCH/i.test(rawText) ? "Pahuch Healthcare" : "Agam Med Agency",
      gstin: buyerGstin,
    },
    invoice: {
      invoiceNo: invoiceNo || `INV-${Date.now().toString().slice(-5)}`,
      date: invoiceDate || new Date().toISOString().split("T")[0],
      dueDate: dueDate || invoiceDate || new Date().toISOString().split("T")[0],
      totalItems: items.length,
    },
    items,
    totals: {
      subtotal,
      discount,
      sgst,
      cgst,
      totalGst: sgst + cgst,
      grandTotal,
    },
  };
};

/**
 * Extract text from PDF buffer using PDFParse
 */
export const extractTextFromPdfBuffer = async (buffer) => {
  if (!buffer) return "";
  if (!PDFParse) {
    console.warn("PDFParse not available, falling back to string representation");
    return buffer.toString("utf8");
  }

  try {
    const parser = new PDFParse({ data: buffer });
    const textResult = await parser.getText();
    await parser.destroy();
    return typeof textResult === "string" ? textResult : (textResult?.text || "");
  } catch (err) {
    console.error("Failed to parse PDF buffer:", err);
    return buffer.toString("utf8");
  }
};

/**
 * Enrich parsed purchase bill with matching WorkspaceProduct and Supplier records
 */
export const enrichParsedBillWithCatalog = async (workspaceId, companyId, parsedData) => {
  if (!parsedData) return null;

  // 1. Resolve Supplier
  let matchedSupplier = null;
  const supGstin = (parsedData.supplier?.gstin || "").trim().toUpperCase();
  const supName = (parsedData.supplier?.name || "").trim();

  if (supGstin || supName) {
    matchedSupplier = await Supplier.findOne({
      workspaceId,
      companyId,
      isDeleted: false,
      $or: [
        ...(supGstin ? [{ gstNumber: supGstin }] : []),
        ...(supName ? [{ businessName: { $regex: new RegExp(`^${supName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } }] : []),
        ...(supName ? [{ businessName: { $regex: new RegExp(supName.split(" ")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") } }] : []),
      ],
    }).lean();
  }

  // 2. Load Workspace Products for fuzzy matching
  const workspaceProducts = await WorkspaceProduct.find({
    workspaceId,
    isDeleted: false,
  })
    .select("_id name pack hsn hsnTaxpercent mrp ptr pts rateA rateB rateC")
    .lean();

  const fuse = new Fuse(workspaceProducts, {
    keys: ["name"],
    threshold: 0.4,
    distance: 100,
  });

  const enrichedItems = (parsedData.items || []).map((item) => {
    let matchedProduct = null;
    if (workspaceProducts.length > 0) {
      // Try exact name match first
      matchedProduct = workspaceProducts.find(
        (p) => p.name?.trim().toLowerCase() === item.rawName?.trim().toLowerCase()
      );

      // Try fuzzy search
      if (!matchedProduct) {
        const searchResults = fuse.search(item.rawName);
        if (searchResults && searchResults.length > 0) {
          matchedProduct = searchResults[0].item;
        }
      }
    }

    return {
      ...item,
      id: `${matchedProduct?._id || Date.now()}-${Math.random()}`,
      productId: matchedProduct?._id || null,
      name: matchedProduct?.name || item.rawName,
      pack: item.pack || matchedProduct?.pack || "10's",
      hsn: item.hsn || matchedProduct?.hsn || "3004",
      gst: item.gst || matchedProduct?.hsnTaxpercent || 5,
      mrp: item.mrp || matchedProduct?.mrp || item.rate,
      rateA: item.rateA || matchedProduct?.rateA || item.rate,
      rateB: item.rateB || matchedProduct?.rateB || item.rate,
      rateC: item.rateC || matchedProduct?.rateC || item.rate,
      isMatched: Boolean(matchedProduct),
      matchedProductName: matchedProduct?.name || null,
      isNewProduct: !matchedProduct,
    };
  });

  return {
    ...parsedData,
    matchedSupplier: matchedSupplier
      ? {
          _id: matchedSupplier._id,
          id: matchedSupplier._id,
          businessName: matchedSupplier.businessName,
          name: matchedSupplier.businessName,
          gstNumber: matchedSupplier.gstNumber || "",
          mobile: matchedSupplier.mobile || "",
        }
      : null,
    suggestedSupplier: {
      businessName: parsedData.supplier?.name || "Imported Supplier",
      gstNumber: parsedData.supplier?.gstin || "",
      address: parsedData.supplier?.address || "",
      mobile: parsedData.supplier?.phone || "",
    },
    items: enrichedItems,
  };
};

export const SAMPLE_INVOICE_TEXTS = {
  "galaxy-pharma": `GST INVOICE
GALAXY PHARMA
L.G 36 DAWA BAZAR
13-14, RNT MARG
INDORE
Phone : 0731-2704356,9826305057,9993472003
D.L.No. : DB/183/1661/78 GSTIN : 23AAXPN0919L1Z8
M/s AGAM MED AGENCY DHAMNOD DHAMNOD
WARD NO.07,JANTA CO OPERATIVE MILES COMPLEX
INFRONT OF JILA SAHKARI BANK,A.B.ROAD,DHAMNOD
MADHYA PRADESH
GSTIN : 23CRRPM3368P1ZX
Invoice No. INV01671 Date 20-07-2026
PRODUCT NAME HSN RACK BATCH EXP QTY FREE MRP PTS PTR DISC GST AMOUNT
1.) PANTOCID IT 30049039 SIH0775A 4/28 6 379.00 259.89 288.76 0.00 5 1559.34
2.) MODULA 20MG 30049099 PXC0015 2/27 2 908.44 622.94 692.14 0.00 5 1245.88
3.) ENCORATE CHRONO 500 30049081 18 GTH1896A 5/28 20 99.75 68.40 76.00 0.00 5 1368.00
4.) ENCORATE CHRONO 300 30049081 18 GTH1894A 5/28 20 65.46 44.89 49.87 0.00 5 897.80
SUB TOTAL 5071.02
Discount -2.5 % -126.78
SGST 2.5 % 129.96
CGST 2.5 % 129.96
GRAND TOTAL 5458.00`,

  "agam-medical": `M/S AGAM MEDICAL AGENCY
SHOP NO./PLOT NO./WARD NO.7,
JANTA CO-OPRATIVE,MILES COMPLEX A.B.ROAD DHAMNOD TEH.DHARMPURI DIST.DHAR
Phone : 9425459619,9098803098 E-Mail : shrikrishnamedical619@gmail.com
GST INVOICE GSTIN : 23CRRPM3368P1ZX
M/s PAHUCH AROGYAM PHARMACY PVTLTD
ADD 17 ATAL BIHARI MARKET DHAMNOD
GSTIN : 23AANCP5805G1ZF
Invoice No. :A003183 Date :20-08-2026
1. 300490 CETANIL TM 50MG TABS 10S DY26931007 5/28 10.00 0.00 180.47 137.50 0.00 0.00 2.50 2.50 1375.00
2. 300490 LEVOLIN 0.31 RESPULES 8*6*2 6L80296 2/28 96.00 0.00 6.73 5.13 0.00 0.00 2.50 2.50 492.48
3. 300490 GUDCEF PLUS TAB 6X10 C9AKZ004 2/28 5.00 1.00 232.02 176.78 0.00 0.00 2.50 2.50 883.90
4. 3004 AXCER 90 TAB 14S GTH1501A 4/29 5.00 0.00 491.25 374.29 0.00 0.00 2.50 2.50 1871.45
5. 300490 GEMER SITA IR 50/1GM/2 TAB 10S GTH1621A 4/28 10.00 0.00 169.00 128.76 0.00 0.00 2.50 2.50 1287.60
6. 19019090LACTODEX 2 500GM DG44260582 9/27 3.00 0.00 552.00 473.14 0.00 0.00 2.50 2.50 1419.42
7. 300490 VOGLISTAR PLUS 0.2 TAB 3X10 P0AFY003 11/27 5.00 0.00 131.48 100.18 0.00 0.00 2.50 2.50 500.90
8. 300490 PROTOL AM TAB 1*10S APAM26002 3/29 10.00 0.00 132.47 100.93 0.00 0.00 2.50 2.50 1009.30
9. 1901 LACTODEX 1 500GM DG55261079 10/27 5.00 0.00 550.00 471.43 0.00 0.00 2.50 2.50 2357.15
10. 3401 LONAZEP 0.5 1*15 SIH0393A 1/29 5.00 0.00 55.28 42.12 0.00 0.00 2.50 2.50 210.60
11. 3401 MIRTAZ 7.5 1*10 SIH0852A 3/28 7.00 0.00 109.00 83.05 0.00 0.00 2.50 2.50 581.35
SUB TOTAL 11989.15
C. D. 839.22
SGST 278.76
CGST 278.76
GRAND TOTAL 11707.00`,

  "basant-medical": `BASANT MEDICAL STORES
L.G.- 239, DAWA BAZAR,
13-14, R.N.T. MARG,
INDORE (M.P.)
Phone : 0731-2700675, 2701675
GST INVOICE	FSSAI NO. : 11419850001059
D.L NO. : 20B/21B-DB-307/96
GSTIN : 23ADHPJ3065C1Z2
M/s AGAM MEDICAL AGNECY
WARD NO 7 JANTA CO OPERATIVE MILES
A B ROAD State : 23
DHAMNOD
PH.NO.: 9098803098
D.L NO. : 20B//693/14/2019 21B/694/14/2019
GSTIN : 23CRRPM3368P1ZX Food Licence :
Invoice No. 2627/R01252 Date : 14-07-2026
SN. PRODUCT NAME PACK HSN BATCH NO. EXP. QTY QTY. MRP RATE P.T.R DISC. SGST CGST AMOUNT
1. NUROKIND FAST STRIP MANKI 1' 30045039 4B2Z016 10/27 20 0.00 24.91 17.08 18.98 0.00 2.50 2.50 341.60
2. INZIT 4 TABS ERIS 10' 30049079 GINZ26002 8/28 10 0.00 136.75 93.77 104.19 0.00 2.50 2.50 937.70
3. OLKEM TRIO 12.5 TAB ALKEM 10TAB 30049079 2670601 12/27 10 0.00 199.20 136.59 151.77 0.00 2.50 2.50 1365.90
4. OLKEM TRIO 40 TABS ALKEM 10TAB 30049079 2670702 2/28 10 0.00 289.20 198.31 220.34 0.00 2.50 2.50 1983.10
5. TSART AM TAB ALKEM 15' 30049079 26440903 2/28 10 0.00 274.20 188.02 208.91 0.00 2.50 2.50 1880.20
6. OLKEM BETA 25 TAB ALKEM 10TAB 30049079 26440238 12/27 10 0.00 175.75 120.51 133.90 0.00 2.50 2.50 1205.10
7. OLKEM TRIO 6.25 TAB ALKEM 10TABS30049079 2670503 3/28 10 0.00 215.45 147.74 164.15 0.00 2.50 2.50 1477.40
8. A TO Z SYP(B) ALKEM 200ML 21069099 26490492 9/27 25 5.00 260.00 178.29 198.10 0.00 2.50 2.50 4457.25
9. ARNICOR 50 TAB CIPLA 10 30049099 BO260066A 2/28 9.60 2.40 226.87 155.57 172.85 0.00 2.50 2.50 1493.47
10. ASTHALIN INHELER CIPLA 200MD 30049091 5BA3252 10/27 20 0.00 168.79 115.74 128.60 0.00 2.50 2.50 2314.80
11. ASTHALIN RESPULES CIPLA 2.5ML 30049091 6L80311 2/29 400 0.00 8.80 6.03 6.70 0.00 2.50 2.50 2412.00
12. ASTHALIN ROTOCAP CIPLA 60' 30049091 6SA0496 1/29 30 0.00 71.77 49.21 54.68 0.00 2.50 2.50 1476.30
13. CIPLAR LA 40 TABS CIPLA 15' 30049074 6SB0394 4/28 12 0.00 123.28 84.53 93.93 0.00 2.50 2.50 1014.36
14. CIPLAR 40MG TABS CIPLA 15' 30049074 6SB0142 1/29 10 0.00 51.65 35.42 39.35 0.00 2.50 2.50 354.20
15. CLOPIVAS 75 TAB CIPLA 15 30049099 6SN0412 1/28 10 0.00 100.72 69.07 76.73 0.00 2.50 2.50 690.70
16. CLOPIVAS AP 150MG TAB CIPLA 15' 30049099 6EC0121 2/28 10 0.00 107.76 73.89 82.10 0.00 2.50 2.50 738.90
17. DYTOR 10 TAB CIPLA 15 30049079 6SB0323 4/29 30 0.00 116.51 79.90 88.78 0.00 2.50 2.50 2397.00
18. DYTOR PLUS 10 TABS CIPLA 15' 30049079 6SB0299 3/28 12 0.00 122.56 84.04 93.38 0.00 2.50 2.50 1008.48
19. FEMPRO 2.5 TABS CIPLA 10' 30049099 5GJ0645 8/28 5 0.00 85.35 58.52 65.02 0.00 2.50 2.50 292.60
20. FORACORT 200 ROTOCAP CIPLA 30 30049099 6SA0612 2/28 30 0.00 184.57 126.57 140.64 0.00 2.50 2.50 3797.10
21. FORACORT 400 ROTOCAP CIPLA 30 30049099 6SA0484 1/28 10 0.00 222.70 152.72 169.68 0.00 2.50 2.50 1527.20
22. NADIBACT PLUS CREA CIPLA 7.5 30049099 6D018 1/28 5 0.00 136.17 93.37 103.75 0.00 2.50 2.50 466.85
23. AEROCORT FORT ROTACAP CIPLA 30' 30049099 5SA2481 10/27 3 0.00 130.59 89.55 99.50 0.00 2.50 2.50 268.65
24. AEROCORT ROTOCAP CIPLA 60' 30049099 6SA0132 5/27 30 0.00 142.67 97.83 98.82 0.00 2.50 2.50 2934.90
25. DYTOR 5 TAB CIPLA 15 30049079 6SN0600 3/29 30 0.00 81.35 55.78 61.98 0.00 2.50 2.50 1673.40
26. CLAVAM DROPS ALKEM 10ML 30041090 26440364 12/27 20 4.00 124.65 85.47 94.97 0.00 2.50 2.50 1709.40
27. CLAVAM FORTE SYP ALKEM 30MLS 30041090 25444843 5/27 10 2.00 182.80 125.35 139.28 0.00 2.50 2.50 1253.50
28. CLAVAM FORTE SYP ALKEM 30MLS 30041090 26440977 8/27 9 0.00 182.80 125.35 139.28 16.67 2.50 2.50 1128.15
SUB TOTAL 42600.21
Discount 188.06
Discount -2.5 % -1060.35
SGST 2.5 % 1086.80
CGST 2.5 % 1086.80
GRAND TOTAL 45646.00`,
};

export default {
  parsePurchaseBillText,
  extractTextFromPdfBuffer,
  enrichParsedBillWithCatalog,
  normalizeExpiry,
  normalizeDate,
  parseCleanNumber,
  SAMPLE_INVOICE_TEXTS,
};
