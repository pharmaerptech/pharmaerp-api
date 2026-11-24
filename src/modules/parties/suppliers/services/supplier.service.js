import mongoose from "mongoose";
import crypto from "crypto";
import ApiError from "../../../../utils/ApiError.js";
import supplierRepository from "../repositories/supplier.repository.js";
import branchRepository from "../../../organization/branches/repositories/branch.repository.js";
import { SUPPLIER_STATUS } from "../constants/supplier.constant.js";
import ledgerService from "../../../finance/ledger/services/ledger.service.js";
import ledgerRepository from "../../../finance/ledger/repositories/ledger.repository.js";
import purchaseBillRepository from "../../../catalog/purchase-bills/repositories/purchaseBill.repository.js";
import Ledger from "../../../finance/ledger/models/ledger.model.js";
import * as xlsx from "xlsx";
import { previewOutstandingImport, confirmOutstandingImport } from "./supplierOutstandingImport.service.js";

const createSupplier = async (workspaceId, companyId, userId, payload) => {
  const {
    branchId,
    supplierCode,
    supplierType,
    businessName,
    contactPerson,
    mobile,
    alternateMobile,
    email,
    gstNumber,
    panNumber,
    drugLicenseNumber,
    address,
    creditDays,
    openingBalance,
    openingBalanceType,
    notes,
    status,
  } = payload;

  if (branchId) {
    const branch = await branchRepository.findBranchByIdAndCompany(
      branchId,
      companyId,
    );
    if (!branch) {
      throw new ApiError(404, "Branch not found under this company");
    }
  }

  if (supplierCode) {
    const existing = await supplierRepository.findSupplierByCode(supplierCode);
    if (existing) {
      throw new ApiError(400, "Supplier with this code already exists");
    }
  }

  
  const mongoose = (await import('mongoose')).default;
  const AccountGroup = mongoose.model("AccountGroup");
  const Account = mongoose.model("Account");

  let creditorsGroup = await AccountGroup.findOne({ workspaceId, companyId, groupCode: "SUNDRY_CREDITORS" }) 
                    || await AccountGroup.findOne({ workspaceId, companyId, groupName: "Sundry Creditors" });
  if (!creditorsGroup) {
      let currentLiabilities = await AccountGroup.findOne({ workspaceId, companyId, groupCode: "CURRENT_LIABILITIES" }) || await AccountGroup.findOne({ workspaceId, companyId, groupName: /Current Liabilit/i });
      if (!currentLiabilities) {
          currentLiabilities = await AccountGroup.create({
              workspaceId,
              companyId,
              groupName: "Current Liabilities",
              groupCode: "CURRENT_LIABILITIES",
              nature: "LIABILITY",
              isSystemGroup: true,
              createdBy: userId,
          });
      }
      
      creditorsGroup = await AccountGroup.create({
          workspaceId,
          companyId,
          groupName: "Sundry Creditors",
          groupCode: "SUNDRY_CREDITORS",
          parentGroupId: currentLiabilities._id,
          nature: "LIABILITY",
          status: "active",
          isSystemGroup: true,
          createdBy: userId,
      });
  }

  const accCode = supplierCode ? `SUP-${supplierCode}` : `SUP-${Date.now()}`;
  const accountName = `${businessName} - Supplier`;

  const ledgerAccount = await Account.create({
    workspaceId,
    companyId,
    accountCode: accCode,
    accountName: accountName,
    accountGroupId: creditorsGroup?._id,
    accountNature: "LIABILITY",
    accountCategory: "SUPPLIER",
    openingBalance: openingBalance || 0,
    openingBalanceType: openingBalanceType || "cr",
    status: "active",
    isSystemAccount: false,
    createdBy: userId,
  });

  const supplier = await supplierRepository.createSupplier({
    workspaceId,
    companyId,
    branchId: branchId || null,
    supplierCode,
    supplierType,
    businessName,
    contactPerson,
    mobile,
    alternateMobile,
    email,
    gstNumber,
    panNumber,
    drugLicenseNumber,
    address,
    creditDays,
    openingBalance,
    openingBalanceType,
    notes,
    status,
    ledgerAccountId: ledgerAccount._id,
    createdBy: userId,
  });


  return supplier.toSafeObject();
};

export const ensureSupplierLedgerAccount = async (
  supplier,
  companyId,
  workspaceId,
  userId = null
) => {
  const AccountGroup = mongoose.model("AccountGroup");
  const Account = mongoose.model("Account");

  if (supplier.ledgerAccountId) {
    const existing = await Account.findOne({
      _id: supplier.ledgerAccountId,
      companyId,
      workspaceId,
      isDeleted: false,
    });
    if (existing) {
      return supplier.ledgerAccountId;
    }
  }

  const sId = supplier._id ? supplier._id.toString() : String(Date.now());
  const accCode = supplier.supplierCode
    ? `SUP-${supplier.supplierCode}`
    : `SUP-${sId.slice(-6)}`;
  const accountName = `${supplier.businessName || supplier.name || "Supplier"} - Supplier`;

  let account = await Account.findOne({
    workspaceId,
    companyId,
    $or: [{ accountCode: accCode }, { accountName: accountName }],
  });

  if (!account) {
    let creditorsGroup =
      (await AccountGroup.findOne({
        workspaceId,
        companyId,
        groupCode: "SUNDRY_CREDITORS",
      })) ||
      (await AccountGroup.findOne({
        workspaceId,
        companyId,
        groupName: "Sundry Creditors",
      }));
    if (!creditorsGroup) {
      let currentLiabilities =
        (await AccountGroup.findOne({
          workspaceId,
          companyId,
          groupCode: "CURRENT_LIABILITIES",
        })) ||
        (await AccountGroup.findOne({
          workspaceId,
          companyId,
          groupName: /Current Liabilit/i,
        }));
      if (!currentLiabilities) {
        currentLiabilities = await AccountGroup.create({
          workspaceId,
          companyId,
          groupName: "Current Liabilities",
          groupCode: "CURRENT_LIABILITIES",
          nature: "LIABILITY",
          isSystemGroup: true,
          createdBy: userId,
        });
      }

      creditorsGroup = await AccountGroup.create({
        workspaceId,
        companyId,
        groupName: "Sundry Creditors",
        groupCode: "SUNDRY_CREDITORS",
        parentGroupId: currentLiabilities._id,
        nature: "LIABILITY",
        status: "active",
        isSystemGroup: true,
        createdBy: userId,
      });
    }

    account = await Account.create({
      workspaceId,
      companyId,
      accountCode: accCode,
      accountName: accountName,
      accountGroupId: creditorsGroup?._id,
      accountNature: "LIABILITY",
      accountCategory: "SUPPLIER",
      openingBalance: supplier.openingBalance || 0,
      openingBalanceType: supplier.openingBalanceType || "cr",
      status: "active",
      isSystemAccount: false,
      createdBy: userId,
    });
  }

  supplier.ledgerAccountId = account._id;
  if (typeof supplier.save === "function") {
    await supplier.save();
  } else if (supplierRepository && supplier._id) {
    await supplierRepository.saveSupplier(supplier);
  }

  return account._id;
};

export const computeSupplierOutstanding = async (
  supplier,
  companyId,
  workspaceId
) => {
  const accountId = supplier.ledgerAccountId;
  if (!accountId) {
    return {
      outstandingAmount: Number(supplier.openingBalance || 0),
      balanceType: supplier.openingBalanceType || "cr",
    };
  }

  // Self-heal: Check if any dispatched purchase returns for this supplier are missing ledger sync
  try {
    const PurchaseReturn = mongoose.model("PurchaseReturn");
    const unsyncedReturns = await PurchaseReturn.find({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      companyId: new mongoose.Types.ObjectId(companyId),
      $or: [
        { supplierId: supplier._id },
        { "shippingDetails.destinationSupplierId": supplier._id },
      ],
      "shippingDetails.transitStatus": { $in: ["IN_TRANSIT", "DELIVERED", "DISPATCHED"] },
      $or: [
        { journalVoucherId: null },
        { journalVoucherId: { $exists: false } },
      ],
    }).lean();

    if (unsyncedReturns.length > 0) {
      const { syncPurchaseReturnLedger } = await import(
        "../../../catalog/purchase-returns/services/purchaseReturn.service.js"
      );
      for (const ret of unsyncedReturns) {
        await syncPurchaseReturnLedger(ret, ret.creditNoteNo);
      }
    }
  } catch (healErr) {
    console.warn("Self-healing supplier ledger sync in outstanding computation warning:", healErr?.message);
  }

  const aggregate = await Ledger.aggregate([
    {
      $match: {
        accountId: new mongoose.Types.ObjectId(accountId),
        companyId: new mongoose.Types.ObjectId(companyId),
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
      },
    },
    {
      $group: {
        _id: null,
        totalDebit: { $sum: "$debit" },
        totalCredit: { $sum: "$credit" },
      },
    },
  ]);

  const transDebit = aggregate[0]?.totalDebit || 0;
  const transCredit = aggregate[0]?.totalCredit || 0;

  const opDebit =
    supplier.openingBalanceType === "dr" ? Number(supplier.openingBalance) || 0 : 0;
  const opCredit =
    supplier.openingBalanceType === "cr" ? Number(supplier.openingBalance) || 0 : 0;

  const totalDebit = transDebit + opDebit;
  const totalCredit = transCredit + opCredit;

  let amt = 0;
  let type = "cr";

  if (totalCredit >= totalDebit) {
    amt = totalCredit - totalDebit;
    type = "cr";
  } else {
    amt = totalDebit - totalCredit;
    type = "dr";
  }

  return {
    outstandingAmount: amt,
    balanceType: type,
  };
};

const getSuppliers = async (workspaceId, companyId, query = {}) => {
  const { page, limit, sort, ...filters } = query;
  const [result, stats] = await Promise.all([
    supplierRepository.getSuppliers(
      workspaceId,
      companyId,
      filters,
      { page, limit, sort },
    ),
    supplierRepository.getSuppliersStats(
      workspaceId,
      companyId,
      filters
    )
  ]);

  const populatedSuppliers = await Promise.all(
    result.suppliers.map(async (s) => {
      const obj = s.toSafeObject();
      try {
        const outstanding = await computeSupplierOutstanding(s, companyId, workspaceId);
        return {
          ...obj,
          outstandingAmount: outstanding.outstandingAmount,
          balanceType: outstanding.balanceType
        };
      } catch (err) {
        return { ...obj, outstandingAmount: s.openingBalance || 0, balanceType: s.openingBalanceType || "cr" };
      }
    })
  );

  return {
    suppliers: populatedSuppliers,
    total: result.total,
    page: result.page,
    limit: result.limit,
    stats,
  };
};

const getSupplierById = async (supplierId, companyId, workspaceId) => {
  const supplier = await supplierRepository.findSupplierByIdCompanyAndWorkspace(
    supplierId,
    companyId,
    workspaceId,
  );

  if (!supplier) {
    throw new ApiError(404, "Supplier not found");
  }

  if (!supplier.ledgerAccountId) {
    try {
      await ensureSupplierLedgerAccount(supplier, companyId, workspaceId);
    } catch (e) {
      console.warn("Failed to auto-resolve supplier ledger account:", e?.message);
    }
  }

  const safe = supplier.toSafeObject();
  try {
    const outstanding = await computeSupplierOutstanding(supplier, companyId, workspaceId);
    safe.outstandingAmount = outstanding.outstandingAmount;
    safe.balanceType = outstanding.balanceType;
  } catch (err) {
    safe.outstandingAmount = supplier.openingBalance || 0;
    safe.balanceType = supplier.openingBalanceType || "cr";
  }

  return safe;
};

const updateSupplier = async (
  supplierId,
  companyId,
  workspaceId,
  userId,
  payload,
) => {
  const supplier = await supplierRepository.findSupplierByIdCompanyAndWorkspace(
    supplierId,
    companyId,
    workspaceId,
  );

  if (!supplier) {
    throw new ApiError(404, "Supplier not found");
  }

  if (payload.branchId) {
    const branch = await branchRepository.findBranchByIdAndCompany(
      payload.branchId,
      companyId,
    );
    if (!branch) {
      throw new ApiError(404, "Branch not found under this company");
    }
  }

  if (payload.supplierCode && payload.supplierCode !== supplier.supplierCode) {
    const existing = await supplierRepository.findSupplierByCode(
      payload.supplierCode,
    );
    if (existing && existing._id.toString() !== supplier._id.toString()) {
      throw new ApiError(400, "Supplier with this code already exists");
    }
  }

  const allowedFields = [
    "branchId",
    "supplierCode",
    "supplierType",
    "businessName",
    "contactPerson",
    "mobile",
    "alternateMobile",
    "email",
    "gstNumber",
    "panNumber",
    "drugLicenseNumber",
    "address",
    "creditDays",
    "openingBalance",
    "openingBalanceType",
    "notes",
    "status",
  ];

  allowedFields.forEach((field) => {
    if (payload[field] !== undefined) {
      supplier[field] = payload[field];
    }
  });

  await supplierRepository.saveSupplier(supplier);

  return supplier.toSafeObject();
};

const deleteSupplier = async (supplierId, companyId, workspaceId, userId) => {
  const supplier = await supplierRepository.deleteSupplierById(
    supplierId,
    companyId,
    workspaceId,
    userId,
  );

  if (!supplier) {
    throw new ApiError(404, "Supplier not found");
  }

  return { success: true };
};

/*
|--------------------------------------------------------------------------
| Additional Financial / Purchases / Outstanding Stubs
|--------------------------------------------------------------------------
*/

const getSupplierLedger = async (supplierId, companyId, workspaceId, query = {}) => {
  console.log("Fetching ledger for supplier:", supplierId);
  const supplier = await supplierRepository.findSupplierByIdCompanyAndWorkspace(
    supplierId,
    companyId,
    workspaceId,
  );

  if (!supplier) {
    throw new ApiError(404, "Supplier not found");
  }

  if (!supplier.ledgerAccountId) {
    try {
      await ensureSupplierLedgerAccount(supplier, companyId, workspaceId);
    } catch (e) {
      console.warn("Failed to auto-resolve supplier ledger account:", e?.message);
    }
  }

  if (!supplier.ledgerAccountId) {
    console.log("Supplier has no ledgerAccountId!", supplierId);
    return { entries: [], total: 0, page: 1, limit: 20, meta: { totalDebit: 0, totalCredit: 0 } };
  }

  console.log("Supplier ledgerAccountId:", supplier.ledgerAccountId);
  
  const ledgerData = await ledgerService.getLedger(workspaceId, companyId, {
    accountId: supplier.ledgerAccountId,
    ...query,
  });

  console.log("Ledger data fetched successfully, total entries:", ledgerData?.total);
  return {
    ...ledgerData,
    supplier: {
      _id: supplier._id,
      businessName: supplier.businessName || supplier.name,
      openingBalance: supplier.openingBalance || 0,
      openingBalanceType: supplier.openingBalanceType || "cr",
      ledgerAccountId: supplier.ledgerAccountId,
    },
  };
};

const getSupplierOutstanding = async (supplierId, companyId, workspaceId) => {
  const supplier = await supplierRepository.findSupplierByIdCompanyAndWorkspace(
    supplierId,
    companyId,
    workspaceId,
  );

  if (!supplier) {
    throw new ApiError(404, "Supplier not found");
  }

  if (!supplier.ledgerAccountId) {
    try {
      await ensureSupplierLedgerAccount(supplier, companyId, workspaceId);
    } catch (e) {
      console.warn("Failed to auto-resolve supplier ledger account:", e?.message);
    }
  }

  return computeSupplierOutstanding(supplier, companyId, workspaceId);
};

const getSupplierPurchases = async (supplierId, companyId, workspaceId, query = {}) => {
  await getSupplierById(supplierId, companyId, workspaceId); // Validate supplier

  const { page, limit, sort, ...filters } = query;
  filters.supplierId = supplierId;

  const result = await purchaseBillRepository.getPurchaseBills(
    workspaceId,
    companyId,
    filters,
    { page, limit, sort }
  );

  return result;
};

const getSupplierPayments = async (supplierId, companyId, workspaceId) => {
  await getSupplierById(supplierId, companyId, workspaceId);
  return []; // Will implement when Payment module is ready
};



const GST_STATE_CODES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "25": "Daman and Diu", "26": "Dadra and Nagar Haveli", "27": "Maharashtra", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh"
};

const previewImport = async (workspaceId, companyId, fileBuffer) => {
  const workbook = xlsx.read(fileBuffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  // Read as array of arrays first to find the header row
  const rawRows = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
  
  if (rawRows.length === 0) {
    throw new ApiError(400, "The Excel file is empty.");
  }

  // Find the header row (look for common keywords and multiple columns)
  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(20, rawRows.length); i++) {
    const validCells = rawRows[i].filter(c => String(c).trim() !== "");
    const rowStr = rawRows[i].map(c => String(c).toLowerCase()).join(" ");
    
    // Real header row has multiple columns and combinations of keywords
    if (
      validCells.length >= 3 && 
      (rowStr.includes("name") || rowStr.includes("ledger") || rowStr.includes("party")) &&
      (rowStr.includes("mobile") || rowStr.includes("phone") || rowStr.includes("sno") || rowStr.includes("balance") || rowStr.includes("email"))
    ) {
      headerRowIndex = i;
      break;
    }
  }

  const headers = rawRows[headerRowIndex].map(h => String(h).toLowerCase().trim());
  const dataRows = rawRows.slice(headerRowIndex + 1);

  const data = dataRows.map(rowArr => {
    const obj = {};
    let lastHeader = "";
    headers.forEach((h, idx) => {
      let currentHeader = h;
      if (currentHeader) {
        lastHeader = currentHeader;
      } else if (lastHeader.includes("mobile") || lastHeader.includes("phone")) {
        currentHeader = `${lastHeader}_${idx}`; 
      }
      
      if (currentHeader && rowArr[idx] !== undefined && rowArr[idx] !== "") {
        obj[currentHeader] = rowArr[idx];
      }
    });
    return obj;
  }).filter(row => Object.keys(row).length > 0);

  const Supplier = mongoose.model("Supplier");
  const existingSuppliers = await Supplier.find({
    workspaceId,
    companyId,
    isDeleted: false
  }).select("mobile email gstNumber panNumber businessName").lean();
  
  const existingMobilePhones = new Set(existingSuppliers.map(s => s.mobile).filter(Boolean));
  const existingEmails = new Set(existingSuppliers.map(s => s.email).filter(Boolean));
  const existingGSTs = new Set(existingSuppliers.map(s => s.gstNumber).filter(Boolean));
  const existingPANs = new Set(existingSuppliers.map(s => s.panNumber).filter(Boolean));
  const existingNames = new Set(existingSuppliers.map(s => s.businessName?.toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean));

  const parsedRows = data.map((lowerRow, index) => {
    const businessName = String(lowerRow["name"] || lowerRow["ledger name"] || lowerRow["party name"] || lowerRow["ledger"] || "").trim();
    
    // Extract mobile from any column that looks like mobile/phone
    let mobile = "";
    let alternateMobile = "";
    const mobileKeys = Object.keys(lowerRow).filter(k => k.includes("mobile") || k.includes("phone"));
    for (const mk of mobileKeys) {
      const val = String(lowerRow[mk]).replace(/\D/g, ''); // Extract only digits
      if (val.length >= 10) {
        const potentialMobile = val.substring(val.length - 10); // get last 10 digits
        if (/^[6-9][0-9]{9}$/.test(potentialMobile)) {
          if (!mobile) {
            mobile = potentialMobile;
          } else if (!alternateMobile && potentialMobile !== mobile) {
            alternateMobile = potentialMobile;
          }
        }
      }
    }

    const email = String(lowerRow["email"] || "").trim();
    const gstNumber = String(lowerRow["gstin"] || lowerRow["gstin no."] || lowerRow["gstin no"] || lowerRow["gst"] || lowerRow["tin"] || "").trim();
    const panNumber = String(lowerRow["pan"] || lowerRow["panno"] || "").trim();
    const contactPerson = String(lowerRow["contact"] || lowerRow["contact person"] || "").trim();
    
    const addressLine1 = String(lowerRow["address1"] || lowerRow["address"] || lowerRow["address & details"] || "").trim();
    const addressLine2 = [
      String(lowerRow["address2"] || ""),
      String(lowerRow["address3"] || "")
    ].filter(Boolean).map(s => s.trim()).join(", ");
    const city = String(lowerRow["city"] || "").trim();
    const pincode = String(lowerRow["pin"] || lowerRow["pincode"] || "").trim();
    
    // License
    const drugLicenseNumber = String(lowerRow["licence"] || lowerRow["dl no"] || "").trim();

    // Extract balance
    let openingBalance = 0;
    let openingBalanceType = "cr";
    

    let creditDays = 0;
    const rawCreditDays = String(lowerRow["crdays"] || lowerRow["credit days"] || "").trim();
    if (rawCreditDays) {
      const numMatch = rawCreditDays.match(/\d+/);
      if (numMatch) {
        creditDays = parseInt(numMatch[0], 10) || 0;
      }
    }

    const errors = [];

    // Skip completely empty rows or rows that are just repeated headers (common in PDF/Excel reports)
    const normalizedName = businessName.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!businessName || normalizedName === "ledger name" || normalizedName === "name" || normalizedName === "party name" || normalizedName === "ledger") {
      return null;
    }

    if (!businessName) {
      errors.push("Business Name is required");
    }
    
    

    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push("Invalid email format");
      }
    }

    let state = null;
    if (gstNumber) {
      // Relaxed validation to allow 12-character legacy GSTs (State Code + PAN)
      if (true) {
        const stateCode = gstNumber.substring(0, 2);
        if (GST_STATE_CODES[stateCode]) {
          state = GST_STATE_CODES[stateCode];
        }
      }
    }

    

    return {
      rowNumber: index + headerRowIndex + 2, // Accounting for header and 0-indexing
      data: {
        businessName,
        contactPerson: contactPerson || null,
        mobile: mobile || null,
        alternateMobile: alternateMobile || null,
        email: email || null,
        gstNumber: gstNumber || null,
        panNumber: panNumber || null,
        drugLicenseNumber: drugLicenseNumber || null,
        address: { 
          addressLine1,
          addressLine2: addressLine2 || null,
          city: city || null,
          state: state || null,
          pincode: pincode || null
        },
        openingBalance,
        openingBalanceType,
        creditDays,
      },
      isValid: errors.length === 0,
      errors
    };
  }).filter(Boolean); // Filter out skipped null rows

  return parsedRows;
};

const confirmImport = async (workspaceId, companyId, userId, suppliersData) => {
  const results = {
    successful: 0,
    failed: 0,
    errors: []
  };

  try {
    const Supplier = mongoose.model("Supplier");
    const AccountGroup = mongoose.model("AccountGroup");
    const Account = mongoose.model("Account");

    // Pre-fetch existing to prevent duplicates during concurrent imports
    const existingSuppliers = await Supplier.find({
      workspaceId,
      companyId,
      isDeleted: false
    }).select("businessName").lean();
    
    const existingNames = new Set(existingSuppliers.map(s => s.businessName?.toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean));

    let creditorsGroup = await AccountGroup.findOne({ workspaceId, companyId, groupCode: "SUNDRY_CREDITORS" }) 
                      || await AccountGroup.findOne({ workspaceId, companyId, groupName: "Sundry Creditors" });
    if (!creditorsGroup) {
        let currentLiabilities = await AccountGroup.findOne({ workspaceId, companyId, groupCode: "CURRENT_LIABILITIES" }) || await AccountGroup.findOne({ workspaceId, companyId, groupName: /Current Liabilit/i });
        if (!currentLiabilities) {
            currentLiabilities = await AccountGroup.create({
                workspaceId,
                companyId,
                groupName: "Current Liabilities",
                groupCode: "CURRENT_LIABILITIES",
                nature: "LIABILITY",
                isSystemGroup: true,
                createdBy: userId,
            });
        }
        
        creditorsGroup = await AccountGroup.create({
            workspaceId,
            companyId,
            groupName: "Sundry Creditors",
            groupCode: "SUNDRY_CREDITORS",
            parentGroupId: currentLiabilities._id,
            nature: "LIABILITY",
            status: "active",
            isSystemGroup: true,
            createdBy: userId,
        });
    }

    const existingCodes = await Supplier.find({ isDeleted: false }).select("supplierCode").lean();
    const usedCodes = new Set(existingCodes.map(s => s.supplierCode));

    const existingAccounts = await Account.find({
      companyId,
      isDeleted: false
    }).select("accountCode").lean();

    // Add existing account codes to usedCodes to prevent orphaned account code collisions
    existingAccounts.forEach(a => {
      if (a.accountCode && a.accountCode.startsWith('SUP-')) {
        usedCodes.add(a.accountCode.replace('SUP-', ''));
      }
    });

    const accountsToInsert = [];
    const payloadsToInsert = [];
    
    for (const supplierData of suppliersData) {
      const normalizedName = supplierData.businessName?.toLowerCase().replace(/\s+/g, ' ').trim();

      
      // Auto-generate code
      let supplierCode;
      do {
         supplierCode = `SUP${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
      } while (usedCodes.has(supplierCode));
      usedCodes.add(supplierCode);
      const accCode = `SUP-${supplierCode}`;
      
      const accountName = `${supplierData.businessName} - Supplier`;
      
      const accountId = new mongoose.Types.ObjectId();
      
      accountsToInsert.push({
        _id: accountId,
        workspaceId,
        companyId,
        accountCode: accCode,
        accountName: accountName,
        accountGroupId: creditorsGroup?._id,
        accountNature: "LIABILITY",
        accountCategory: "SUPPLIER",
        openingBalance: supplierData.openingBalance || 0,
        openingBalanceType: supplierData.openingBalanceType || "cr",
        status: "active",
        isSystemAccount: false,
        createdBy: userId,
      });

      payloadsToInsert.push({
        ...supplierData,
        supplierCode,
        ledgerAccountId: accountId,
        workspaceId,
        companyId,
        createdBy: userId,
      });
      
      if (normalizedName) {
        existingNames.add(normalizedName);
      }
    }

    if (accountsToInsert.length > 0) {
      const BATCH_SIZE = 1000;
      for (let i = 0; i < accountsToInsert.length; i += BATCH_SIZE) {
        const batch = accountsToInsert.slice(i, i + BATCH_SIZE);
        try {
          await Account.insertMany(batch, { ordered: false });
        } catch (err) {
          console.warn("Some accounts failed to insert during bulk import batch:", err.message);
        }
      }
    }

    if (payloadsToInsert.length > 0) {
      await supplierRepository.insertManySuppliers(payloadsToInsert);
      results.successful = payloadsToInsert.length;
    }
  } catch (error) {
    if (error.writeErrors) {
      // If some failed in unordered bulk op
      results.successful = suppliersData.length - error.writeErrors.length;
      results.failed = error.writeErrors.length;
      error.writeErrors.forEach(err => {
        const errorMsg = err.errmsg || err.message || (err.err && err.err.errmsg) || JSON.stringify(err);
        results.errors.push(`Failed for index ${err.index}: ${errorMsg}`);
      });
    } else {
      results.failed = suppliersData.length;
      results.errors.push(`Bulk import failed: ${error.message}`);
    }
  }

  return results;
};

export default {
  createSupplier,
  getSuppliers,
  getSupplierById,
  updateSupplier,
  deleteSupplier,
  getSupplierLedger,
  getSupplierOutstanding,
  computeSupplierOutstanding,
  ensureSupplierLedgerAccount,
  getSupplierPurchases,
  getSupplierPayments,
  previewImport,
  confirmImport,
  previewOutstandingImport,
  confirmOutstandingImport,
};
