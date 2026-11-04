import mongoose from "mongoose";
import CreditNote from "../models/creditNote.model.js";
import Branch from "../../../organization/branches/models/branch.model.js";
import { getBranchInitials } from "../../../../utils/branchInitials.js";
import financialPeriodRepository from "../../../finance/financial-periods/repositories/financialPeriod.repository.js";
import { CREDIT_NOTE_STATUS } from "../constants/creditNote.constant.js";

/**
 * Generate sequential Credit Note number (e.g., CN-MB-2627-0001)
 */
const getNextCreditNoteNumber = async (companyId, workspaceId, branchId = null, date = null, session = null) => {
  let targetBranch = null;
  if (branchId) {
    targetBranch = await Branch.findOne({
      _id: branchId,
      workspaceId,
      companyId,
      isDeleted: false,
    }).session(session);
  }

  if (!targetBranch) {
    targetBranch = await Branch.findOne({
      workspaceId,
      companyId,
      isDeleted: false,
    }).sort({ isMainBranch: -1, createdAt: 1 }).session(session);
  }

  const branchInitials = getBranchInitials(targetBranch);
  const cnDateObj = date ? new Date(date) : new Date();

  // Resolve FY string (e.g., 2627 for April 2026 - March 2027)
  let fyString = "";
  const month = cnDateObj.getMonth();
  const year = cnDateObj.getFullYear();
  if (month >= 3) {
    fyString = `${year.toString().slice(-2)}${(year + 1).toString().slice(-2)}`;
  } else {
    fyString = `${(year - 1).toString().slice(-2)}${year.toString().slice(-2)}`;
  }

  try {
    const periods = await financialPeriodRepository.getPeriods(
      workspaceId,
      companyId,
      { status: "OPEN" },
      { session }
    );
    const period = periods?.periods?.[0];
    if (period && period.startDate && period.endDate) {
      const startYear = new Date(period.startDate).getFullYear();
      const endYear = new Date(period.endDate).getFullYear();
      fyString = `${startYear.toString().slice(-2)}${endYear.toString().slice(-2)}`;
    }
  } catch (err) {
    // Fallback to standard calendar/FY formula
  }

  const prefix = `CN-${branchInitials}-${fyString}-`;

  const lastDoc = await CreditNote.findOne({
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    companyId: new mongoose.Types.ObjectId(companyId),
    creditNoteNo: { $regex: `^${prefix}` },
  })
    .sort({ creditNoteNo: -1, createdAt: -1 })
    .session(session);

  let sequenceNo = 1;
  if (lastDoc && lastDoc.creditNoteNo && lastDoc.creditNoteNo.startsWith(prefix)) {
    const parts = lastDoc.creditNoteNo.split("-");
    const lastSeqPart = parts[parts.length - 1];
    const parsed = parseInt(lastSeqPart, 10);
    if (!isNaN(parsed) && parsed >= 1) {
      sequenceNo = parsed + 1;
    }
  }

  let candidateSeq = sequenceNo;
  let finalNo = `${prefix}${candidateSeq.toString().padStart(4, "0")}`;

  let collision = await CreditNote.findOne({
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    creditNoteNo: finalNo,
  }).session(session);

  while (collision) {
    candidateSeq += 1;
    finalNo = `${prefix}${candidateSeq.toString().padStart(4, "0")}`;
    collision = await CreditNote.findOne({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      creditNoteNo: finalNo,
    }).session(session);
  }

  return finalNo;
};

/**
 * Create a new Credit Note
 */
const createCreditNote = async (data, options = {}) => {
  const creditNote = new CreditNote(data);
  return creditNote.save({ session: options.session || null });
};

/**
 * Find single Credit Note by ID or Number
 */
const findCreditNoteById = async (idOrNo, companyId, workspaceId, session = null) => {
  const isObjectId = mongoose.Types.ObjectId.isValid(idOrNo);
  const query = {
    companyId: new mongoose.Types.ObjectId(companyId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
    ...(isObjectId
      ? {
          $or: [
            { _id: new mongoose.Types.ObjectId(idOrNo) },
            { creditNoteNo: idOrNo },
          ],
        }
      : { creditNoteNo: idOrNo }),
  };

  const queryBuilder = CreditNote.findOne(query)
    .populate("customerId", "name mobile phone customerCode gstNumber billingAddress advanceBalance creditNoteBalance")
    .populate("branchId", "name branchCode branchInitials")
    .populate("shiftId", "shiftNo shiftNumber status openedAt")
    .populate("sourceReturnId", "returnNo invoiceNo grandTotal date")
    .populate("originalInvoiceId", "invoiceNo grandTotal date billingMode")
    .populate("redemptions.invoiceId", "invoiceNo grandTotal date")
    .populate("createdBy", "name email");

  if (session) {
    queryBuilder.session(session);
  }

  return queryBuilder.exec();
};

/**
 * Find Credit Notes with filters and pagination
 */
const findCreditNotes = async (query = {}, options = {}) => {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.max(1, parseInt(options.limit, 10) || 20);
  const skip = (page - 1) * limit;
  const sort = options.sort || { issueDate: -1, createdAt: -1 };

  const [creditNotes, total] = await Promise.all([
    CreditNote.find(query)
      .populate("customerId", "name mobile phone customerCode gstNumber")
      .populate("branchId", "name branchCode")
      .populate("sourceReturnId", "returnNo invoiceNo grandTotal")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    CreditNote.countDocuments(query),
  ]);

  return {
    creditNotes,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

/**
 * Find active credit notes for a customer (with available balance > 0)
 */
const findActiveCustomerCreditNotes = async (customerId, companyId, workspaceId, session = null) => {
  const query = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    companyId: new mongoose.Types.ObjectId(companyId),
    customerId: new mongoose.Types.ObjectId(customerId),
    status: { $in: [CREDIT_NOTE_STATUS.ACTIVE, CREDIT_NOTE_STATUS.PARTIALLY_REDEEMED] },
    balanceAmount: { $gt: 0 },
    isDeleted: false,
  };

  const queryBuilder = CreditNote.find(query)
    .sort({ issueDate: 1, createdAt: 1 }); // FIFO allocation order

  if (session) {
    queryBuilder.session(session);
  }

  return queryBuilder.exec();
};

/**
 * Count Credit Notes matching query
 */
const countCreditNotes = async (query = {}) => {
  return CreditNote.countDocuments(query);
};

export default {
  getNextCreditNoteNumber,
  createCreditNote,
  findCreditNoteById,
  findCreditNotes,
  findActiveCustomerCreditNotes,
  countCreditNotes,
};

