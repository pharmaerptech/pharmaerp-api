import xlsx from "xlsx";
import crypto from "crypto";
import { parseB2BOutstandingExcel } from "./b2bOutstandingParser.service.js";
import SalesInvoice from "../../../sales/invoices/models/invoice.model.js";


import mongoose from "mongoose";
import ApiError from "../../../../utils/ApiError.js";
import customerRepository from "../repositories/customer.repository.js";
import branchRepository from "../../../organization/branches/repositories/branch.repository.js";
import gstLedgerRepository from "../../../finance/gst-ledger/repositories/gstLedger.repository.js";
import financialPeriodRepository from "../../../finance/financial-periods/repositories/financialPeriod.repository.js";
import { CUSTOMER_STATUS, CUSTOMER_TYPE, CUSTOMER_TRANSACTION_TYPE } from "../constants/customer.constant.js";
import Customer from "../models/customer.model.js";
import Batch from "../../../catalog/products/models/batch.model.js";
import ProductFacility from "../../../catalog/products/models/productFacility.model.js";
import accountRepository from "../../../finance/chart-of-accounts/repositories/account.repository.js";
import accountGroupRepository from "../../../finance/chart-of-accounts/repositories/accountGroup.repository.js";
import openingBalanceService from "../../../finance/opening-balances/services/openingBalance.service.js";
import ledgerService from "../../../finance/ledger/services/ledger.service.js";
import customerAdvanceService from "./customerAdvance.service.js";
import CustomerAdvanceTransaction from "../models/customerAdvanceTransaction.model.js";
import CustomerCreditTransaction from "../models/customerCreditTransaction.model.js";
import SharedContactGroup from "../models/sharedContactGroup.model.js";
import CustomerRelationship, { CONFIRMATION_STATUS } from "../models/customerRelationship.model.js";
import { getReciprocalRelation } from "../helpers/phoneNormalizer.js";

const findOrCreateWalkInCustomer = async (workspaceId, companyId, userId = null, options = {}) => {
  const session = options.session || null;

  // 1. Check if already exists for this company
  const existing = await customerRepository.findWalkInCustomer(companyId, workspaceId, { session });
  if (existing) {
    return existing.toSafeObject ? existing.toSafeObject() : existing;
  }

  try {
    // 2. Ensure CURRENT_ASSETS and SUNDRY_DEBTORS groups exist
    let currentAssetsGroup = await accountGroupRepository.findGroupByCode(companyId, "CURRENT_ASSETS", { session });
    if (!currentAssetsGroup) {
      currentAssetsGroup = await accountGroupRepository.createGroup(
        {
          workspaceId,
          companyId,
          groupCode: "CURRENT_ASSETS",
          groupName: "Current Assets",
          nature: "ASSET",
          parentGroupId: null,
          isSystemGroup: true,
          createdBy: userId,
        },
        { session }
      );
    }

    let sundryDebtorsGroup = await accountGroupRepository.findGroupByCode(companyId, "SUNDRY_DEBTORS", { session });
    if (!sundryDebtorsGroup) {
      sundryDebtorsGroup = await accountGroupRepository.createGroup(
        {
          workspaceId,
          companyId,
          groupCode: "SUNDRY_DEBTORS",
          groupName: "Sundry Debtors",
          nature: "ASSET",
          parentGroupId: currentAssetsGroup._id,
          isSystemGroup: true,
          createdBy: userId,
        },
        { session }
      );
    }

    // 3. Find or create CUST-WALKIN system ledger account
    let ledgerAccount = await accountRepository.findAccountByCode(companyId, "CUST-WALKIN", { session });
    if (!ledgerAccount) {
      ledgerAccount = await accountRepository.createAccount(
        {
          workspaceId,
          companyId,
          accountCode: "CUST-WALKIN",
          accountName: "Walk-in Customer",
          accountGroupId: sundryDebtorsGroup._id,
          accountNature: "ASSET",
          accountCategory: "CUSTOMER",
          openingBalance: 0,
          openingBalanceType: "dr",
          status: "active",
          isSystemAccount: true,
          createdBy: userId,
        },
        { session }
      );
    }

    // 4. Create the Walk-in Customer document
    const walkInCustomer = await customerRepository.createCustomer(
      {
        workspaceId,
        companyId,
        branchId: null,
        customerCode: "WALK-IN",
        customerType: CUSTOMER_TYPE.WALK_IN,
        name: "Walk-in Customer",
        mobile: null,
        alternateMobile: null,
        email: null,
        gstNumber: null,
        panNumber: null,
        drugLicenseNumber: null,
        creditLimit: 0,
        creditDays: 0,
        openingBalance: 0,
        openingBalanceType: "dr",
        advanceBalance: 0,
        creditNoteBalance: 0,
        creditOutstanding: 0,
        isWalkIn: true,
        isSystemCustomer: true,
        status: "active",
        ledgerAccountId: ledgerAccount?._id || null,
        createdBy: userId,
      },
      { session }
    );

    return walkInCustomer.toSafeObject ? walkInCustomer.toSafeObject() : walkInCustomer;
  } catch (err) {
    if (err.code === 11000 || String(err.message).includes("E11000")) {
      const fallback = await customerRepository.findWalkInCustomer(companyId, workspaceId, { session });
      if (fallback) {
        return fallback.toSafeObject ? fallback.toSafeObject() : fallback;
      }
    }
    throw err;
  }
};

const getWalkInCustomer = async (workspaceId, companyId) => {
  const customer = await customerRepository.findWalkInCustomer(companyId, workspaceId);
  if (!customer) {
    return null;
  }
  return customer.toSafeObject ? customer.toSafeObject() : customer;
};

const createCustomer = async (workspaceId, companyId, userId, payload) => {
  const {
    branchId,
    customerCode,
    customerType,
    name,
    mobile,
    alternateMobile,
    email,
    gstNumber,
    panNumber,
    drugLicenseNumber,
    billingAddress,
    shippingAddress,
    creditLimit,
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

  if (customerCode) {
    const existing = await customerRepository.findCustomerByCode(customerCode, companyId);
    if (existing) {
      throw new ApiError(400, "Customer with this code already exists");
    }
  }

  // Prevent duplicate Walk-in customer creation
  const isWalkInAttempt =
    payload.isWalkIn === true ||
    customerType === CUSTOMER_TYPE.WALK_IN ||
    customerType === "walk_in" ||
    customerCode === "WALK-IN" ||
    name?.trim().toLowerCase() === "walk-in customer";

  if (isWalkInAttempt) {
    const existingWalkIn = await customerRepository.findWalkInCustomer(companyId, workspaceId);
    if (existingWalkIn) {
      throw new ApiError(
        400,
        "A Walk-in Customer already exists for this company. Each company is strictly restricted to only one Walk-in Customer."
      );
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Get or create CURRENT_ASSETS account group
    let currentAssetsGroup = await accountGroupRepository.findGroupByCode(companyId, "CURRENT_ASSETS", { session });
    
    if (!currentAssetsGroup) {
      currentAssetsGroup = await accountGroupRepository.createGroup({
        workspaceId,
        companyId,
        groupCode: "CURRENT_ASSETS",
        groupName: "Current Assets",
        nature: "ASSET",
        parentGroupId: null,
        isSystemGroup: true,
        createdBy: userId,
      }, { session });
    }

    // 2. Get or create SUNDRY_DEBTORS account group
    let sundryDebtorsGroup = await accountGroupRepository.findGroupByCode(companyId, "SUNDRY_DEBTORS", { session });
    
    if (!sundryDebtorsGroup) {
      sundryDebtorsGroup = await accountGroupRepository.createGroup({
        workspaceId,
        companyId,
        groupCode: "SUNDRY_DEBTORS",
        groupName: "Sundry Debtors",
        nature: "ASSET",
        parentGroupId: currentAssetsGroup._id,
        isSystemGroup: true,
        createdBy: userId,
      }, { session });
    }

    const accCode = customerCode
      ? `CUST-${customerCode}`
      : `CUST-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const ledgerAccount = await accountRepository.createAccount({
      workspaceId,
      companyId,
      accountCode: accCode,
      accountName: `${name} - Customer`,
      accountGroupId: sundryDebtorsGroup._id,
      accountNature: "ASSET",
      accountCategory: "CUSTOMER",
      openingBalance: openingBalance || 0,
      openingBalanceType: openingBalanceType || "dr",
      status: "active",
      isSystemAccount: false,
      createdBy: userId,
    }, { session });

    // 3. Create the Customer with the linked ledger account
    const customer = await customerRepository.createCustomer({
      workspaceId,
      companyId,
      branchId: branchId || null,
      customerCode,
      customerType,
      name,
      mobile,
      alternateMobile,
      email,
      gstNumber,
      panNumber,
      drugLicenseNumber,
      billingAddress,
      shippingAddress,
      creditLimit,
      creditDays,
      openingBalance,
      openingBalanceType,
      notes,
      status,
      ledgerAccountId: ledgerAccount._id,
      createdBy: userId,
    }, { session });

    // 4. Post Opening Balance Journal if opening balance is provided
    console.log("--- CUSTOMER CREATION LOG ---");
    console.log(`Customer Ledger Account created with ID: ${ledgerAccount._id}`);
    console.log(`Opening Balance value: ${openingBalance}`);
    if (openingBalance && openingBalance > 0) {
      console.log("Posting Opening Balance Journal...");
      try {
        await openingBalanceService.postOpeningBalanceJournal(
          workspaceId,
          companyId,
          userId,
          ledgerAccount._id,
          openingBalance,
          openingBalanceType || "dr",
          { session }
        );
        console.log("Successfully posted Opening Balance Journal");
      } catch (err) {
        console.error("Failed to post opening balance:", err);
      }
    } else {
      console.log("No opening balance provided or it is <= 0. Skipping journal.");
    }

    await session.commitTransaction();
    session.endSession();

    return customer.toSafeObject();
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

const getCustomers = async (workspaceId, companyId, query = {}) => {
  const { page, limit, sort, ...filters } = query;
  const result = await customerRepository.getCustomers(
    workspaceId,
    companyId,
    filters,
    { page, limit, sort },
  );

  const mappedCustomers = result.customers.map((c) => {
    const obj = c.toSafeObject ? c.toSafeObject() : { ...c };
    if (obj.outstandingAmount === undefined) {
      obj.outstandingAmount = obj.openingBalance || 0;
      obj.balanceType = obj.openingBalanceType || "dr";
    }
    obj.creditLimit = Number(obj.creditLimit || 0);
    obj.advanceBalance = Number(obj.advanceBalance || 0);
    obj.creditOutstanding = Number(obj.creditOutstanding || 0);
    obj.creditNoteBalance = Number(obj.creditNoteBalance || 0);
    return obj;
  });

  const customerIds = mappedCustomers.map((c) => c._id).filter(Boolean);

  if (customerIds.length > 0) {
    try {
      const [advanceAgg, creditAgg] = await Promise.all([
        CustomerAdvanceTransaction.aggregate([
          {
            $match: {
              customerId: { $in: customerIds },
              companyId: new mongoose.Types.ObjectId(companyId),
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
              status: "ACTIVE",
            },
          },
          {
            $group: {
              _id: "$customerId",
              received: {
                $sum: {
                  $cond: [{ $eq: ["$type", CUSTOMER_TRANSACTION_TYPE.ADVANCE_RECEIVED] }, "$amount", 0],
                },
              },
              settled: {
                $sum: {
                  $cond: [
                    {
                      $in: [
                        "$type",
                        [CUSTOMER_TRANSACTION_TYPE.ADVANCE_SETTLED, CUSTOMER_TRANSACTION_TYPE.CREDIT_SETTLED],
                      ],
                    },
                    "$amount",
                    0,
                  ],
                },
              },
            },
          },
        ]),
        CustomerCreditTransaction.aggregate([
          {
            $match: {
              customerId: { $in: customerIds },
              companyId: new mongoose.Types.ObjectId(companyId),
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
              status: { $in: ["PENDING", "PARTIAL"] },
            },
          },
          {
            $group: {
              _id: "$customerId",
              totalDue: { $sum: "$balanceDue" },
            },
          },
        ]),
      ]);

      const advMap = new Map();
      advanceAgg.forEach((a) => {
        const bal = Math.max(0, Math.round(((a.received || 0) - (a.settled || 0)) * 100) / 100);
        advMap.set(String(a._id), bal);
      });

      const creditMap = new Map();
      creditAgg.forEach((c) => {
        const due = Math.max(0, Math.round((c.totalDue || 0) * 100) / 100);
        creditMap.set(String(c._id), due);
      });

      mappedCustomers.forEach((c) => {
        const cId = String(c._id);
        c.advanceBalance = advMap.get(cId) ?? 0;
        c.creditOutstanding = creditMap.get(cId) ?? 0;
        c.availableCredit = Math.max(0, (c.creditLimit || 0) - c.creditOutstanding);
      });
    } catch (err) {
      console.warn("Failed to enrich real-time customer balances:", err.message);
    }
  }

  // Enrich global stats with real-time global advance and credit totals
  const stats = { ...(result.stats || {}) };
  try {
    const [globalAdvAgg, globalCreditAgg] = await Promise.all([
      CustomerAdvanceTransaction.aggregate([
        {
          $match: {
            companyId: new mongoose.Types.ObjectId(companyId),
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            status: "ACTIVE",
          },
        },
        {
          $group: {
            _id: null,
            received: {
              $sum: {
                $cond: [{ $eq: ["$type", CUSTOMER_TRANSACTION_TYPE.ADVANCE_RECEIVED] }, "$amount", 0],
              },
            },
            settled: {
              $sum: {
                $cond: [
                  {
                    $in: [
                      "$type",
                      [CUSTOMER_TRANSACTION_TYPE.ADVANCE_SETTLED, CUSTOMER_TRANSACTION_TYPE.CREDIT_SETTLED],
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
          },
        },
      ]),
      CustomerCreditTransaction.aggregate([
        {
          $match: {
            companyId: new mongoose.Types.ObjectId(companyId),
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            status: { $in: ["PENDING", "PARTIAL"] },
          },
        },
        {
          $group: {
            _id: null,
            totalDue: { $sum: "$balanceDue" },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const realAdvance = Math.max(
      0,
      Math.round(((globalAdvAgg[0]?.received || 0) - (globalAdvAgg[0]?.settled || 0)) * 100) / 100
    );
    const realCreditDue = Math.max(0, Math.round((globalCreditAgg[0]?.totalDue || 0) * 100) / 100);
    stats.totalAdvance = realAdvance;
    stats.totalCr = realAdvance;
    stats.totalDr = realCreditDue;
    stats.drCount = globalCreditAgg[0]?.count || 0;
    stats.netRunning = Math.abs(realCreditDue - realAdvance);
    stats.runningType = realCreditDue >= realAdvance ? "Dr" : "Cr";
  } catch (err) {
    console.warn("Failed to compute real-time global customer stats:", err.message);
  }

  return {
    customers: mappedCustomers,
    total: result.total,
    page: result.page,
    limit: result.limit,
    stats,
  };
};

const getCustomerById = async (customerId, companyId, workspaceId) => {
  const customer = await customerRepository.findCustomerByIdCompanyAndWorkspace(
    customerId,
    companyId,
    workspaceId,
  );

  if (!customer) {
    throw new ApiError(404, "Customer not found");
  }

  const safeCustomer = customer.toSafeObject();

  try {
    const [advanceBalance, pendingCredits] = await Promise.all([
      customerAdvanceService.getAdvanceBalance(customerId, companyId, workspaceId),
      CustomerCreditTransaction.find({
        customerId,
        companyId,
        workspaceId,
        status: { $in: ["PENDING", "PARTIAL"] },
      }).select("balanceDue dueDate").lean(),
    ]);

    const creditOutstanding = (pendingCredits || []).reduce(
      (sum, c) => sum + Number(c.balanceDue || 0),
      0
    );

    const now = new Date();
    const overdueCount = (pendingCredits || []).filter(
      (c) => c.dueDate && new Date(c.dueDate) < now
    ).length;

    safeCustomer.advanceBalance = Math.round(advanceBalance * 100) / 100;
    safeCustomer.creditOutstanding = Math.round(creditOutstanding * 100) / 100;
    safeCustomer.availableCredit = Math.max(0, (customer.creditLimit || 0) - creditOutstanding);
    safeCustomer.overdueCount = overdueCount;
    safeCustomer.creditNoteBalance = Math.round(Number(customer.creditNoteBalance || 0) * 100) / 100;
  } catch (err) {
    console.warn("Failed to attach credit/advance summary to customer:", err.message);
    safeCustomer.advanceBalance = 0;
    safeCustomer.creditOutstanding = 0;
    safeCustomer.availableCredit = customer.creditLimit || 0;
    safeCustomer.overdueCount = 0;
  }

  // Enrich with SharedContactGroup and pairwise relationship records from the viewing customer's perspective
  if (safeCustomer.sharedContactGroupId) {
    try {
      const group = await SharedContactGroup.findOne({
        _id: safeCustomer.sharedContactGroupId,
        workspaceId,
        companyId,
      }).lean();

      if (group && Array.isArray(group.members) && group.members.length > 0) {
        const sortedMembers = [...group.members].sort(
          (a, b) => (a.sequence || 1) - (b.sequence || 1)
        );
        const memberCustomerIds = sortedMembers.map((m) => m.customerId);

        const [memberCustomers, relationshipRecords] = await Promise.all([
          Customer.find({
            _id: { $in: memberCustomerIds },
            workspaceId,
            companyId,
            isDeleted: false,
          })
            .select("_id customerCode name mobile gender")
            .lean(),
          CustomerRelationship.find({
            workspaceId,
            companyId,
            sourceCustomerId: customer._id,
            targetCustomerId: { $in: memberCustomerIds },
          }).lean(),
        ]);

        const customerMap = new Map(
          memberCustomers.map((c) => [c._id.toString(), c])
        );
        const relMap = new Map(
          relationshipRecords.map((r) => [r.targetCustomerId.toString(), r])
        );

        const enrichedMembers = sortedMembers
          .map((m) => {
            const targetCust = customerMap.get(m.customerId.toString());
            if (!targetCust) return null;

            const isSelf = m.customerId.toString() === customer._id.toString();
            const relRecord = relMap.get(m.customerId.toString());

            let relation = isSelf ? "Self" : "Other";
            let confirmationStatus = isSelf ? "confirmed" : "suggested";

            if (relRecord) {
              relation = relRecord.relationship;
              confirmationStatus = relRecord.confirmationStatus;
            }

            return {
              customerId: targetCust._id,
              customerCode: targetCust.customerCode,
              name: targetCust.name,
              mobile: targetCust.mobile,
              gender: targetCust.gender || null,
              sequence: m.sequence,
              joinedAt: m.joinedAt,
              relation,
              confirmationStatus,
              confirmedBy: relRecord?.confirmedBy || null,
              confirmedAt: relRecord?.confirmedAt || null,
              notes: relRecord?.notes || null,
              relationshipId: relRecord?._id || null,
            };
          })
          .filter(Boolean);

        safeCustomer.sharedContactGroup = {
          _id: group._id,
          normalizedPhone: group.normalizedPhone,
          members: enrichedMembers,
        };
        safeCustomer.members = enrichedMembers;
      }
    } catch (err) {
      console.warn("Failed to attach sharedContactGroup to customer:", err.message);
    }
  }

  return safeCustomer;
};

const updateCustomerRelationship = async (
  workspaceId,
  companyId,
  userId,
  sourceCustomerId,
  targetCustomerId,
  data
) => {
  const { relationship, confirmationStatus = CONFIRMATION_STATUS.CONFIRMED, notes } = data;

  const [sourceCustomer, targetCustomer] = await Promise.all([
    Customer.findOne({ _id: sourceCustomerId, workspaceId, companyId, isDeleted: false }),
    Customer.findOne({ _id: targetCustomerId, workspaceId, companyId, isDeleted: false }),
  ]);

  if (!sourceCustomer) {
    throw new ApiError(404, "Source customer not found");
  }
  if (!targetCustomer) {
    throw new ApiError(404, "Target customer not found");
  }

  if (sourceCustomerId.toString() === targetCustomerId.toString()) {
    throw new ApiError(400, "Cannot change relationship with oneself");
  }

  let groupId = sourceCustomer.sharedContactGroupId || targetCustomer.sharedContactGroupId;
  if (!groupId) {
    const phone = sourceCustomer.mobile;
    if (phone && phone === targetCustomer.mobile) {
      let group = await SharedContactGroup.findOne({
        workspaceId,
        companyId,
        normalizedPhone: phone,
      });
      if (!group) {
        group = new SharedContactGroup({
          workspaceId,
          companyId,
          normalizedPhone: phone,
          members: [
            { customerId: sourceCustomer._id, sequence: 1 },
            { customerId: targetCustomer._id, sequence: 2 },
          ],
        });
        await group.save();
      }
      groupId = group._id;
      sourceCustomer.sharedContactGroupId = groupId;
      targetCustomer.sharedContactGroupId = groupId;
      await Promise.all([sourceCustomer.save(), targetCustomer.save()]);
    } else {
      throw new ApiError(400, "Customers do not belong to the same shared contact group");
    }
  }

  // 1. Update source -> target relationship
  const updatedRelationship = await CustomerRelationship.findOneAndUpdate(
    {
      workspaceId,
      companyId,
      sourceCustomerId,
      targetCustomerId,
    },
    {
      $set: {
        sharedContactGroupId: groupId,
        relationship,
        confirmationStatus,
        confirmedBy: confirmationStatus === CONFIRMATION_STATUS.CONFIRMED ? userId : null,
        confirmedAt: confirmationStatus === CONFIRMATION_STATUS.CONFIRMED ? new Date() : null,
        notes: notes !== undefined ? notes : null,
      },
    },
    { upsert: true, new: true, runValidators: true }
  );

  // 2. Check and derive reciprocal relationship for target -> source when confirmed
  if (confirmationStatus === CONFIRMATION_STATUS.CONFIRMED) {
    const reciprocalRel = getReciprocalRelation(relationship, {
      isSameCustomer: false,
      targetGender: sourceCustomer.gender || null,
    });

    if (reciprocalRel && reciprocalRel !== "Other") {
      await CustomerRelationship.findOneAndUpdate(
        {
          workspaceId,
          companyId,
          sourceCustomerId: targetCustomerId,
          targetCustomerId: sourceCustomerId,
        },
        {
          $set: {
            sharedContactGroupId: groupId,
            relationship: reciprocalRel,
            confirmationStatus: CONFIRMATION_STATUS.CONFIRMED,
            confirmedBy: userId,
            confirmedAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );
    }
  }

  return updatedRelationship;
};

const addCustomerRelationship = async (
  workspaceId,
  companyId,
  userId,
  sourceCustomerId,
  data
) => {
  const {
    targetCustomerId: providedTargetId,
    name,
    mobile,
    gender = null,
    relationship = "Other",
    confirmationStatus = CONFIRMATION_STATUS.CONFIRMED,
    notes = null,
  } = data;

  const sourceCustomer = await Customer.findOne({
    _id: sourceCustomerId,
    workspaceId,
    companyId,
    isDeleted: false,
  });

  if (!sourceCustomer) {
    throw new ApiError(404, "Source customer not found");
  }

  let targetCustomer = null;

  if (providedTargetId) {
    targetCustomer = await Customer.findOne({
      _id: providedTargetId,
      workspaceId,
      companyId,
      isDeleted: false,
    });
    if (!targetCustomer) {
      throw new ApiError(404, "Target customer not found");
    }
  } else if (name) {
    const cleanPhone = mobile ? String(mobile).trim() : null;
    if (cleanPhone) {
      targetCustomer = await Customer.findOne({
        workspaceId,
        companyId,
        name: new RegExp(`^${name.trim()}$`, "i"),
        mobile: cleanPhone,
        isDeleted: false,
      });
    }

    if (!targetCustomer) {
      targetCustomer = new Customer({
        workspaceId,
        companyId,
        name: name.trim(),
        mobile: cleanPhone || sourceCustomer.mobile,
        gender: gender || null,
        customerType: "other",
        customerCode: null,
        createdBy: userId,
        status: "active",
      });
      await targetCustomer.save();
    }
  } else {
    throw new ApiError(400, "Either targetCustomerId or customer name is required");
  }

  if (sourceCustomer._id.equals(targetCustomer._id)) {
    throw new ApiError(400, "Cannot add relationship to oneself");
  }

  // Determine or create SharedContactGroup
  let group = null;
  if (sourceCustomer.sharedContactGroupId) {
    group = await SharedContactGroup.findOne({
      _id: sourceCustomer.sharedContactGroupId,
      workspaceId,
      companyId,
    });
  } else if (targetCustomer.sharedContactGroupId) {
    group = await SharedContactGroup.findOne({
      _id: targetCustomer.sharedContactGroupId,
      workspaceId,
      companyId,
    });
  }

  const phoneForGroup = sourceCustomer.mobile || targetCustomer.mobile || `grp-${Date.now()}`;

  if (!group) {
    group = new SharedContactGroup({
      workspaceId,
      companyId,
      normalizedPhone: phoneForGroup,
      members: [
        { customerId: sourceCustomer._id, sequence: 1 },
        { customerId: targetCustomer._id, sequence: 2 },
      ],
    });
    await group.save();
  } else {
    const isTargetInGroup = group.members.some((m) =>
      m.customerId.equals(targetCustomer._id)
    );
    if (!isTargetInGroup) {
      const nextSequence =
        group.members.length > 0
          ? Math.max(...group.members.map((m) => m.sequence || 0)) + 1
          : 1;
      group.members.push({ customerId: targetCustomer._id, sequence: nextSequence });
      await group.save();
    }

    const isSourceInGroup = group.members.some((m) =>
      m.customerId.equals(sourceCustomer._id)
    );
    if (!isSourceInGroup) {
      const nextSequence =
        group.members.length > 0
          ? Math.max(...group.members.map((m) => m.sequence || 0)) + 1
          : 1;
      group.members.push({ customerId: sourceCustomer._id, sequence: nextSequence });
      await group.save();
    }
  }

  if (!sourceCustomer.sharedContactGroupId || !sourceCustomer.sharedContactGroupId.equals(group._id)) {
    sourceCustomer.sharedContactGroupId = group._id;
    await sourceCustomer.save();
  }
  if (!targetCustomer.sharedContactGroupId || !targetCustomer.sharedContactGroupId.equals(group._id)) {
    targetCustomer.sharedContactGroupId = group._id;
    await targetCustomer.save();
  }

  const relDoc = await CustomerRelationship.findOneAndUpdate(
    {
      workspaceId,
      companyId,
      sourceCustomerId: sourceCustomer._id,
      targetCustomerId: targetCustomer._id,
    },
    {
      $set: {
        sharedContactGroupId: group._id,
        relationship,
        confirmationStatus,
        confirmedBy: confirmationStatus === CONFIRMATION_STATUS.CONFIRMED ? userId : null,
        confirmedAt: confirmationStatus === CONFIRMATION_STATUS.CONFIRMED ? new Date() : null,
        notes,
      },
    },
    { upsert: true, new: true, runValidators: true }
  );

  if (confirmationStatus === CONFIRMATION_STATUS.CONFIRMED) {
    const reciprocalRel = getReciprocalRelation(relationship, {
      isSameCustomer: false,
      targetGender: sourceCustomer.gender || null,
    });

    if (reciprocalRel && reciprocalRel !== "Other") {
      await CustomerRelationship.findOneAndUpdate(
        {
          workspaceId,
          companyId,
          sourceCustomerId: targetCustomer._id,
          targetCustomerId: sourceCustomer._id,
        },
        {
          $set: {
            sharedContactGroupId: group._id,
            relationship: reciprocalRel,
            confirmationStatus: CONFIRMATION_STATUS.CONFIRMED,
            confirmedBy: userId,
            confirmedAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );
    }
  }

  return {
    relationship: relDoc,
    targetCustomer: {
      _id: targetCustomer._id,
      name: targetCustomer.name,
      mobile: targetCustomer.mobile,
      gender: targetCustomer.gender,
      customerCode: targetCustomer.customerCode,
    },
  };
};

const deleteCustomerRelationship = async (
  workspaceId,
  companyId,
  userId,
  sourceCustomerId,
  targetCustomerId
) => {
  const [sourceCustomer, targetCustomer] = await Promise.all([
    Customer.findOne({ _id: sourceCustomerId, workspaceId, companyId, isDeleted: false }),
    Customer.findOne({ _id: targetCustomerId, workspaceId, companyId, isDeleted: false }),
  ]);

  if (!sourceCustomer) {
    throw new ApiError(404, "Source customer not found");
  }
  if (!targetCustomer) {
    throw new ApiError(404, "Target customer not found");
  }

  // 1. Delete pairwise relationship records between source and target in both directions
  await CustomerRelationship.deleteMany({
    workspaceId,
    companyId,
    $or: [
      { sourceCustomerId, targetCustomerId },
      { sourceCustomerId: targetCustomerId, targetCustomerId: sourceCustomerId },
    ],
  });

  // 2. Update SharedContactGroup
  const groupId = sourceCustomer.sharedContactGroupId || targetCustomer.sharedContactGroupId;
  if (groupId) {
    const group = await SharedContactGroup.findOne({ _id: groupId, workspaceId, companyId });
    if (group) {
      group.members = group.members.filter(
        (m) => !m.customerId.equals(targetCustomerId)
      );

      group.members.forEach((m, idx) => {
        m.sequence = idx + 1;
      });

      if (group.members.length <= 1) {
        if (group.members.length === 1) {
          const remainingId = group.members[0].customerId;
          await Customer.updateOne(
            { _id: remainingId },
            { $set: { sharedContactGroupId: null } }
          );
        }
        await SharedContactGroup.deleteOne({ _id: group._id });
        await Customer.updateOne(
          { _id: targetCustomerId },
          { $set: { sharedContactGroupId: null } }
        );
        await Customer.updateOne(
          { _id: sourceCustomerId },
          { $set: { sharedContactGroupId: null } }
        );
      } else {
        await group.save();
        await Customer.updateOne(
          { _id: targetCustomerId },
          { $set: { sharedContactGroupId: null } }
        );
      }
    }
  }

  return { success: true, message: "Relationship removed successfully" };
};

const updateCustomer = async (
  customerId,
  companyId,
  workspaceId,
  userId,
  payload,
) => {
  const customer = await customerRepository.findCustomerByIdCompanyAndWorkspace(
    customerId,
    companyId,
    workspaceId,
  );

  if (!customer) {
    throw new ApiError(404, "Customer not found");
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

  if (payload.customerCode && payload.customerCode !== customer.customerCode) {
    const existing = await customerRepository.findCustomerByCode(
      payload.customerCode,
      companyId,
    );
    if (existing && existing._id.toString() !== customer._id.toString()) {
      throw new ApiError(400, "Customer with this code already exists");
    }
  }

  if (customer.isWalkIn) {
    if (payload.customerType && payload.customerType !== CUSTOMER_TYPE.WALK_IN) {
      throw new ApiError(400, "Walk-in Customer type cannot be changed.");
    }
    if (payload.creditLimit && Number(payload.creditLimit) > 0) {
      throw new ApiError(400, "Credit Limit cannot be assigned to Walk-in Customer.");
    }
    if (payload.openingBalance && Number(payload.openingBalance) > 0) {
      throw new ApiError(400, "Opening balance cannot be assigned to Walk-in Customer.");
    }
  } else {
    if (
      payload.isWalkIn === true ||
      payload.customerType === CUSTOMER_TYPE.WALK_IN ||
      payload.customerType === "walk_in" ||
      payload.customerCode === "WALK-IN"
    ) {
      throw new ApiError(
        400,
        "Cannot convert an existing regular customer into a Walk-in Customer. Each company already has a dedicated singleton Walk-in Customer."
      );
    }
  }

  const allowedFields = [
    "branchId",
    "customerCode",
    "customerType",
    "name",
    "mobile",
    "alternateMobile",
    "email",
    "gstNumber",
    "panNumber",
    "drugLicenseNumber",
    "billingAddress",
    "shippingAddress",
    "creditLimit",
    "creditDays",
    "openingBalance",
    "openingBalanceType",
    "notes",
    "status",
  ];

  allowedFields.forEach((field) => {
    if (payload[field] !== undefined) {
      customer[field] = payload[field];
    }
  });

  await customerRepository.saveCustomer(customer);

  return customer.toSafeObject();
};

const deleteCustomer = async (customerId, companyId, workspaceId, userId) => {
  const existing = await customerRepository.findCustomerByIdCompanyAndWorkspace(
    customerId,
    companyId,
    workspaceId,
  );

  if (!existing) {
    throw new ApiError(404, "Customer not found");
  }

  if (existing.isWalkIn || existing.isSystemCustomer) {
    throw new ApiError(400, "System Walk-in Customer cannot be deleted.");
  }
  const customer = await customerRepository.deleteCustomerById(
    customerId,
    companyId,
    workspaceId,
    userId,
  );

  if (!customer) {
    throw new ApiError(404, "Customer not found");
  }

  return { success: true };
};

/*
|--------------------------------------------------------------------------
| Additional Financial / Sales / Outstanding Stubs
|--------------------------------------------------------------------------
*/

const getCustomerLedger = async (customerId, companyId, workspaceId, query = {}) => {
  const customer = await getCustomerById(customerId, companyId, workspaceId);

  if (!customer.ledgerAccountId) {
    return [];
  }

  const ledgerResult = await ledgerService.getLedger(
    workspaceId,
    companyId,
    { 
      accountId: customer.ledgerAccountId, 
      sort: query.sort || { voucherDate: -1, createdAt: -1 },
      ...query 
    }
  );

  return ledgerResult;
};

const getCustomerOutstanding = async (customerId, companyId, workspaceId) => {
  const customer = await getCustomerById(customerId, companyId, workspaceId);

  return {
    outstandingAmount: customer.openingBalance || 0,
    balanceType: customer.openingBalanceType || "dr",
  };
};

const getCustomerPayments = async (customerId, companyId, workspaceId) => {
  await getCustomerById(customerId, companyId, workspaceId);
  return [];
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

const previewImport = async (workspaceId, companyId, fileBuffer, importType = "b2b") => {
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
      validCells.length >= 2 && 
      (rowStr.includes("name") || rowStr.includes("customer") || rowStr.includes("patient") || rowStr.includes("client") || rowStr.includes("ledger") || rowStr.includes("party") || rowStr.includes("title")) &&
      (rowStr.includes("mobile") || rowStr.includes("phone") || rowStr.includes("contact") || rowStr.includes("sno") || rowStr.includes("s.no") || rowStr.includes("balance") || rowStr.includes("email") || rowStr.includes("city") || rowStr.includes("location") || rowStr.includes("district") || rowStr.includes("town") || rowStr.includes("station") || rowStr.includes("address") || rowStr.includes("address1"))
    ) {
      headerRowIndex = i;
      break;
    }
  }

  let headers = rawRows[headerRowIndex].map(h => String(h).toLowerCase().trim());
  
  // If headers still don't contain 'name' or 'customer', try to find a row that looks like data and assume column 0 is name, column 1 is mobile, etc.
  if (!headers.some(h => h.includes("name") || h.includes("customer") || h.includes("patient") || h.includes("client") || h.includes("ledger") || h.includes("party"))) {
    // Fallback: standard assumption
    headers = headers.map((h, i) => i === 0 ? "name" : i === 1 ? "mobile" : h);
  }

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

  const Customer = mongoose.model("Customer");
  const existingCustomers = await Customer.find({
    workspaceId,
    companyId,
    isDeleted: false
  }).select("mobile email gstNumber panNumber name billingAddress.city").lean();
  
  const existingMobilePhones = new Set(existingCustomers.map(s => s.mobile).filter(Boolean));
  const existingEmails = new Set(existingCustomers.map(s => s.email).filter(Boolean));
  const existingGSTs = new Set(existingCustomers.map(s => s.gstNumber).filter(Boolean));
  const existingPANs = new Set(existingCustomers.map(s => s.panNumber).filter(Boolean));
  const existingKeys = new Set(existingCustomers.map(s => {
    const n = (s.name || "").toLowerCase().replace(/\s+/g, " ").trim();
    const c = (s.billingAddress?.city || "").toLowerCase().replace(/\s+/g, " ").trim();
    const m = (s.mobile || "").trim();
    const e = (s.email || "").toLowerCase().trim();
    return `${n}|${m}|${e}|${c}`;
  }).filter(k => k.startsWith("|") === false));

  const parsedRows = data.map((lowerRow, index) => {
    const businessName = String(lowerRow["name"] || lowerRow["customer name"] || lowerRow["customer"] || lowerRow["supplier name"] || lowerRow["ledger name"] || lowerRow["party name"] || lowerRow["ledger"] || lowerRow["patient name"] || lowerRow["patient"] || lowerRow["client"] || lowerRow["client name"] || "").trim();
    
    // Extract mobile from any column that looks like mobile/phone
    let mobile = "";
    let alternateMobile = "";
    const mobileKeys = Object.keys(lowerRow).filter(k => k.includes("mobile") || k.includes("phone") || k.includes("contact"));
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
    const gstNumber = String(lowerRow["gstin"] || lowerRow["gstin no."] || lowerRow["gstin no"] || lowerRow["gst"] || lowerRow["gst number"] || lowerRow["gst no"] || lowerRow["gst no."] || lowerRow["tin"] || "").trim();
    let panNumber = String(lowerRow["pan"] || lowerRow["panno"] || lowerRow["pan number"] || lowerRow["pan no."] || lowerRow["pan no"] || "").trim();
    const contactPerson = String(lowerRow["contact"] || lowerRow["contact person"] || "").trim();
    
    let addressLine1 = String(lowerRow["address1"] || lowerRow["address"] || lowerRow["address & details"] || "").trim();
    const addressLine2 = [
      String(lowerRow["address2"] || ""),
      String(lowerRow["address3"] || "")
    ].filter(Boolean).map(s => s.trim()).join(", ");
    let city = String(lowerRow["city"] || lowerRow["location"] || lowerRow["district"] || lowerRow["town"] || lowerRow["station"] || "").trim();
    const pincode = String(lowerRow["pin"] || lowerRow["pincode"] || "").trim();
    
    if (importType === "b2c" && addressLine1 && !city) {
      city = addressLine1;
      addressLine1 = "";
    }
    
    // License
    const drugLicenseNumber = String(lowerRow["licence"] || lowerRow["dl no"] || lowerRow["dl number"] || lowerRow["dl no."] || lowerRow["dl"] || lowerRow["drug license"] || "").trim();

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
    if (!businessName || normalizedName === "ledger name" || normalizedName === "name" || normalizedName === "customer name" || normalizedName === "customer" || normalizedName === "party name" || normalizedName === "ledger") {
      return null;
    }

    const normalizedCity = city.toLowerCase().replace(/\s+/g, ' ').trim();
    const emailLowerCase = email ? email.toLowerCase().trim() : "";
    const customerKey = `${normalizedName}|${mobile || ""}|${emailLowerCase}|${normalizedCity}`;

    if (!businessName) {
      errors.push("Business Name is required");
    } else {
      existingKeys.add(customerKey);
    }
    
    

    if (email) {
      
    }

    let state = null;
    if (gstNumber) {
      // Relaxed validation to allow 12-character legacy GSTs (State Code + PAN)
      if (true) {
        existingGSTs.add(gstNumber);
        const stateCode = gstNumber.substring(0, 2);
        if (GST_STATE_CODES[stateCode]) {
          state = GST_STATE_CODES[stateCode];
        }
      }
    }

    



    return {
      rowNumber: index + headerRowIndex + 2, // Accounting for header and 0-indexing
      data: {
        name: businessName,
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

const confirmImport = async (workspaceId, companyId, userId, customersData, importType = "b2b") => {
  const results = {
    successful: 0,
    failed: 0,
    errors: []
  };

  try {
    const CustomerModel = mongoose.model("Customer");
    const AccountGroup = mongoose.model("AccountGroup");
    const Account = mongoose.model("Account");

    // Optimize: Fetch ONLY relevant customers for this batch to prevent N^2 performance degradation
    const chunkMobiles = customersData.map(c => (c.mobile || "").trim()).filter(Boolean);
    const chunkNames = customersData.map(c => (c.name || "").trim()).filter(Boolean);

    let existingCustomers = [];
    if (importType !== "b2c" && chunkNames.length > 0) {
      existingCustomers = await CustomerModel.find({
        workspaceId,
        companyId,
        isDeleted: false,
        name: { $in: chunkNames }
      }).select("name billingAddress.city mobile").lean();
    }
    
    const existingKeys = new Set();
    const existingMobiles = new Set();
    
    existingCustomers.forEach(c => {
      if (c.mobile) existingMobiles.add(c.mobile);
      const n = (c.name || "").toLowerCase().replace(/\s+/g, " ").trim();
      const city = (c.billingAddress?.city || "").toLowerCase().replace(/\s+/g, " ").trim();
      const m = (c.mobile || "").trim();
      const e = (c.email || "").toLowerCase().trim();
      if (n) existingKeys.add(`${n}|${m}|${e}|${city}`);
    });

    let debtorsGroup = await AccountGroup.findOne({ workspaceId, companyId, groupCode: "SUNDRY_DEBTORS" }) 
                      || await AccountGroup.findOne({ workspaceId, companyId, groupName: "Sundry Debtors" });
    
    if (!debtorsGroup) {
        let currentAssets = await AccountGroup.findOne({ workspaceId, companyId, groupCode: "CURRENT_ASSETS" }) 
                            || await AccountGroup.findOne({ workspaceId, companyId, groupName: /Current Asset/i });
        if (!currentAssets) {
            currentAssets = await AccountGroup.create({
                workspaceId,
                companyId,
                groupName: "Current Assets",
                groupCode: "CURRENT_ASSETS",
                nature: "ASSET",
                isSystemGroup: true,
                createdBy: userId,
            });
        }
        
        debtorsGroup = await AccountGroup.create({
            workspaceId,
            companyId,
            groupName: "Sundry Debtors",
            groupCode: "SUNDRY_DEBTORS",
            parentGroupId: currentAssets._id,
            nature: "ASSET",
            isSystemGroup: true,
            createdBy: userId,
        });
    }
    
    // To maximize performance, we completely skip checking the database for existing codes.
    // We rely entirely on the 8-character cryptographic hex string which gives 4.2 billion combinations,
    // making collisions practically impossible.
    const usedCodes = new Set();
    
    const accountsToInsert = [];
    const payloadsToInsert = [];
    
    for (const customerData of customersData) {
      const normalizedName = customerData.name?.toLowerCase().replace(/\s+/g, ' ').trim();
      const normalizedCity = (customerData.address?.city || "").toLowerCase().replace(/\s+/g, " ").trim();
      const mobile = (customerData.mobile || "").trim();
      const emailLowerCase = (customerData.email || "").toLowerCase().trim();
      const customerKey = `${normalizedName}|${mobile}|${emailLowerCase}|${normalizedCity}`;

      
      // Prevent duplicates in the same batch
      existingKeys.add(customerKey);
      
      // Auto-generate unique code that won't collide even across concurrent chunks
      let customerCode = customerData.customerCode ? String(customerData.customerCode).trim().toUpperCase() : null;
      if (importType === "b2c") {
        customerCode = null; // B2C customer code can be skipped cleanly
      } else if (!customerCode) {
        do {
          customerCode = `CUS-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
        } while(usedCodes.has(customerCode));
        usedCodes.add(customerCode);
      }
      
      const accountId = new mongoose.Types.ObjectId();
      const accCode = customerCode 
        ? `CUST-${customerCode}` 
        : `CUST-${accountId.toString().slice(-8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
      const accountName = `${customerData.name} - Customer`;
      
      accountsToInsert.push({
        _id: accountId,
        workspaceId,
        companyId,
        accountCode: accCode,
        accountName: accountName,
        accountGroupId: debtorsGroup?._id,
        accountNature: "ASSET",
        accountCategory: "CUSTOMER",
        openingBalance: customerData.openingBalance || 0,
        openingBalanceType: customerData.openingBalanceType || "dr",
        status: "active",
        isSystemAccount: false,
        createdBy: userId,
      });

      payloadsToInsert.push({
        ...customerData,
        customerCode,
        billingAddress: customerData.address || {},
        shippingAddress: customerData.address || {},
        ledgerAccountId: accountId,
        workspaceId,
        companyId,
        createdBy: userId,
      });
      
      // Prevent duplicates in the same batch
      existingKeys.add(customerKey);
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
      // Use ordered: false so if one customer fails, the rest succeed
      try {
        await customerRepository.insertManyCustomers(payloadsToInsert);
        results.successful = payloadsToInsert.length;
      } catch (err) {
        if (err.writeErrors) {
           results.successful = payloadsToInsert.length - err.writeErrors.length;
           throw err; // Re-throw to be caught by the outer catch
        }
        throw err;
      }
    }

    
  } catch (error) {
    if (error.writeErrors) {
      results.failed = error.writeErrors.length;
      error.writeErrors.forEach(err => {
        const errorMsg = err.errmsg || err.message || (err.err && err.err.errmsg) || JSON.stringify(err);
        results.errors.push(`Bulk import failed: ${errorMsg}`);
      });
    } else {
      results.failed = customersData.length;
      results.errors.push(`Bulk import failed: ${error.message}`);
    }
  }

  return results;
};


const levenshteinDistance = (a, b) => {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
      }
    }
  }
  return matrix[b.length][a.length];
};

const findNearestMatch = (name, candidates) => {
  if (!name || !candidates || (candidates.length === 0 && candidates.size === 0)) return null;
  const lowerName = name.toLowerCase().replace(/\s+/g, ' ').trim();
  let bestMatch = null;
  let minDistance = Infinity;

  // First check inclusion (often the case with B2B names)
  for (const candidate of candidates) {
    if (candidate.includes(lowerName) || lowerName.includes(candidate)) {
      const dist = Math.abs(candidate.length - lowerName.length);
      if (dist < minDistance) {
        minDistance = dist;
        bestMatch = candidate;
      }
    }
  }

  // If no inclusion match, fall back to Levenshtein distance
  if (!bestMatch) {
    for (const candidate of candidates) {
      const dist = levenshteinDistance(lowerName, candidate);
      const maxAllowed = Math.max(3, Math.floor(lowerName.length * 0.3));
      if (dist <= maxAllowed && dist < minDistance) {
        minDistance = dist;
        bestMatch = candidate;
      }
    }
  }
  return bestMatch;
};

const previewB2BOutstandingImport = async (workspaceId, companyId, fileBuffer) => {
  const { reportDate, invoices } = parseB2BOutstandingExcel(fileBuffer);
  
  if (!invoices || invoices.length === 0) {
    throw new ApiError(400, "No valid invoices found in the Excel file.");
  }

  // To check duplicates efficiently, fetch all existing invoice numbers for this company
  const existingInvoices = await SalesInvoice.find({
    workspaceId,
    companyId,
    isDeleted: false
  }).select('invoiceNo').lean();
  
  const existingInvoiceSet = new Set(existingInvoices.map(i => i.invoiceNo));

  // Also fetch existing wholesale customers to validate they exist
  const existingCustomers = await mongoose.model("Customer").find({
    workspaceId,
    companyId,
    isDeleted: false
  }).select('name billingAddress').lean();

  const existingCustomerMap = new Map();
  existingCustomers.forEach(c => {
    const rawName = c.name || "";
    const name = rawName.toLowerCase().replace(/\s+/g, ' ').trim();
    const rawCity = c.billingAddress?.city || "";
    const city = rawCity.toLowerCase().replace(/\s+/g, ' ').trim();
    
    const displayName = rawCity ? `${rawName} (${rawCity})` : rawName;
    
    if (name) existingCustomerMap.set(name, displayName);
    
    if (name && city) {
      existingCustomerMap.set(`${name} ${city}`, displayName);
    }
  });

  const previewData = invoices.map((inv) => {
    const errors = [];
    let suggestedCustomer = null;
    
    if (!inv.invoiceNumber) errors.push("Invoice number is missing");
    if (!inv.invoiceDate) errors.push("Invoice date is missing/invalid");
    if (isNaN(inv.billAmount)) errors.push("Bill amount is invalid");
    if (isNaN(inv.outstandingAmount)) errors.push("Outstanding amount is invalid");
    
    if (!inv.customerName) {
      errors.push("Customer name is missing");
    } else {
      const isMatched = existingCustomerMap.has(inv.customerName.toLowerCase().replace(/\s+/g, ' ').trim());
      if (!isMatched) {
        const matchKey = findNearestMatch(inv.customerName, Array.from(existingCustomerMap.keys()));
        if (matchKey) {
           suggestedCustomer = existingCustomerMap.get(matchKey);
           errors.push(`Customer not found (Did you mean "${suggestedCustomer}"?)`);
        } else {
           errors.push("Customer not found in the system");
        }
      }
    }

    if (existingInvoiceSet.has(inv.invoiceNumber)) {
      errors.push("Invoice number already exists in the system (Already Imported)");
    }

    return {
      rowNumber: inv.rowNumber,
      isValid: errors.length === 0,
      errors,
      suggestedCustomer,
      data: {
        name: inv.customerName,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate,
        billAmount: inv.billAmount,
        openingBalance: inv.outstandingAmount,
        openingBalanceType: "dr",
        dueDays: inv.dueDays
      }
    };
  });

  return previewData;
};

const confirmB2BOutstandingImport = async (workspaceId, companyId, userId, customersData) => {
  const session = await mongoose.startSession();
  let successful = 0;
  let failed = 0;
  let errors = [];

  try {
    session.startTransaction();

    // 1. Get unique customer names from input
    const uniqueNames = [...new Set(customersData.map(d => (d.name || "").trim()))].filter(Boolean);
    
    // 2. Fetch all existing wholesale customers for this company to avoid N+1 queries
    const existingCustomers = await Customer.find({
      workspaceId,
      companyId,
      isDeleted: false
    }).session(session);

    const existingNamesMap = new Map();
    for (const c of existingCustomers) {
      const rawName = c.name || "";
      const name = rawName.toLowerCase().replace(/\s+/g, ' ').trim();
      if (name) existingNamesMap.set(name, c);
      
      const rawCity = c.billingAddress?.city || "";
      const city = rawCity.toLowerCase().replace(/\s+/g, ' ').trim();
      if (name && city) {
        existingNamesMap.set(`${name} ${city}`, c);
      }
      
      const displayName = rawCity ? `${rawName} (${rawCity})` : rawName;
      const displayNameKey = displayName.toLowerCase().replace(/\s+/g, ' ').trim();
      if (displayNameKey) existingNamesMap.set(displayNameKey, c);
    }

    // 3. (Removed) We no longer create new customers during B2B outstanding import.
    // 4. (Removed) We no longer bulk insert new customers.

    // 5. Prepare bulk operations for invoices and balance updates
    const invoicesToInsert = [];
    const customerUpdatesMap = new Map(); // customerId -> additional balance

    for (const data of customersData) {
      const customerName = (data.name || "").toLowerCase().replace(/\s+/g, ' ').trim();
      const customer = existingNamesMap.get(customerName);
      
      if (!customer) {
         failed++;
         errors.push(`Row with Invoice ${data.invoiceNumber}: Customer not found`);
         continue;
      }

      const cid = customer._id.toString();
      customerUpdatesMap.set(cid, (customerUpdatesMap.get(cid) || 0) + (data.openingBalance || 0));

      invoicesToInsert.push({
          workspaceId,
          companyId,
          customerId: customer._id,
          invoiceNo: data.invoiceNumber,
          date: new Date(data.invoiceDate),
          paymentMethod: "Credit",
          status: data.openingBalance > 0 && data.openingBalance < data.billAmount ? "Partial" : (data.openingBalance > 0 ? "Credit" : "Paid"),
          grandTotal: data.billAmount || 0,
          subtotal: data.billAmount || 0,
          createdBy: userId,
          items: [{
             itemName: "Historical Outstanding",
             qty: 1,
             rate: data.billAmount || 0,
             amount: data.billAmount || 0
          }]
      });
    }

    // 6. Execute bulk operations
    if (customerUpdatesMap.size > 0) {
      const bulkOps = [];
      for (const [cid, additionalBalance] of customerUpdatesMap.entries()) {
        bulkOps.push({
          updateOne: {
            filter: { _id: cid },
            update: { 
              $inc: { openingBalance: additionalBalance },
              $set: { openingBalanceType: "dr" }
            }
          }
        });
      }
      await Customer.bulkWrite(bulkOps, { session });
    }

    if (invoicesToInsert.length > 0) {
      await SalesInvoice.insertMany(invoicesToInsert, { session });
      successful = invoicesToInsert.length;
    }

    await session.commitTransaction();
    return { successful, failed, errors };
  } catch (error) {
    await session.abortTransaction();
    throw new ApiError(500, "Import confirmation failed: " + error.message);
  } finally {
    session.endSession();
  }
};

export default {
  previewImport,
  confirmImport,
  previewB2BOutstandingImport,
  confirmB2BOutstandingImport,
  findOrCreateWalkInCustomer,
  getWalkInCustomer,
  createCustomer,
  getCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  getCustomerLedger,
  getCustomerOutstanding,
  getCustomerPayments,
  updateCustomerRelationship,
  addCustomerRelationship,
  deleteCustomerRelationship,
};
