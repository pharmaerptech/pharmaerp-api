import mongoose from "mongoose";
import SalesReturn from "../models/salesReturn.model.js";
import "../../../parties/customers/models/customer.model.js";
import "../../../operations/shifts/shift.model.js";

/**
 * Create a new sales return memo in the dedicated collection
 */
const createSalesReturn = async (returnData, options = {}) => {
  const salesReturn = new SalesReturn(returnData);
  return salesReturn.save({ session: options.session || null });
};

/**
 * Find single sales return by ID or memo number
 */
const findSalesReturnById = async (returnId, companyId, workspaceId, session = null) => {
  const isObjectId = mongoose.Types.ObjectId.isValid(returnId);
  const query = {
    companyId: new mongoose.Types.ObjectId(companyId),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    isDeleted: false,
    ...(isObjectId
      ? {
          $or: [
            { _id: new mongoose.Types.ObjectId(returnId) },
            { returnNo: returnId },
            { invoiceNo: returnId },
          ],
        }
      : {
          $or: [{ returnNo: returnId }, { invoiceNo: returnId }],
        }),
  };

  const queryBuilder = SalesReturn.findOne(query)
    .populate(
      "customerId",
      "name mobile phone customerCode gstNumber billingAddress advanceBalance creditLimit"
    )
    .populate("doctorId", "name doctorCode specialty")
    .populate("shiftId", "shiftNo shiftNumber openedAt status")
    .populate("originalInvoiceId", "invoiceNo grandTotal date billingMode")
    .lean();

  if (session) {
    queryBuilder.session(session);
  }

  return queryBuilder.exec();
};

/**
 * Query sales returns with pagination, filters, and sorting
 */
const findSalesReturns = async (query = {}, options = {}) => {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.max(1, parseInt(options.limit, 10) || 50);
  const skip = (page - 1) * limit;
  const sort = options.sort || { date: -1, createdAt: -1 };

  const [returns, total] = await Promise.all([
    SalesReturn.find(query)
      .populate("customerId", "name mobile phone customerCode gstNumber")
      .populate("doctorId", "name doctorCode specialty")
      .populate("originalInvoiceId", "invoiceNo grandTotal date")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    SalesReturn.countDocuments(query),
  ]);

  return {
    returns,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

/**
 * Count sales returns matching filter
 */
const countSalesReturns = async (query = {}) => {
  return SalesReturn.countDocuments(query);
};

export default {
  createSalesReturn,
  findSalesReturnById,
  findSalesReturns,
  countSalesReturns,
};
