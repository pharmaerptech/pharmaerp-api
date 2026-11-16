import mongoose from "mongoose";
import ApiError from "../../../../../../utils/ApiError.js";
import cashExchangeRepository from "../repositories/cashExchange.repository.js";
import { CASH_EXCHANGE_STATUS } from "../constants/cashExchange.constant.js";
import BranchCash from "../../branch-cash/models/branchCash.model.js";
import branchCashRepository from "../../branch-cash/repositories/branchCash.repository.js";

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Compute the monetary total from a denomination array.
 * Uses integer rounding to avoid floating-point drift.
 */
const computeTotal = (denominations) =>
  denominations.reduce((sum, d) => sum + d.denomination * d.quantity, 0);

/**
 * Normalize a denomination array — compute subtotal per line.
 */
const normalizeDenominations = (denominations) =>
  denominations.map((d) => ({
    denomination: d.denomination,
    quantity: d.quantity,
    subtotal: d.denomination * d.quantity,
  }));

// ---------------------------------------------------------------------------
// CREATE CASH EXCHANGE
// ---------------------------------------------------------------------------
const createCashExchange = async (workspaceId, companyId, userId, payload) => {
  const {
    exchangeDate,
    branchId,
    cashPartition = "running",
    denominationsReceived,
    denominationsGiven,
    narration,
    notes,
  } = payload;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Service-level check: cash exchange is strictly for running cash drawer only
    if (cashPartition && cashPartition !== "running") {
      throw new ApiError(
        400,
        "Cash exchange is only permitted in the active running cash drawer",
      );
    }

    // 2. Normalise incoming denominations (compute subtotals)
    const normReceived = normalizeDenominations(denominationsReceived);
    const normGiven = normalizeDenominations(denominationsGiven);

    const totalReceived = computeTotal(normReceived);
    const totalGiven = computeTotal(normGiven);

    // 3. Service-layer balance invariant (defence-in-depth beyond Joi)
    if (Math.round(totalReceived * 100) !== Math.round(totalGiven * 100)) {
      throw new ApiError(
        400,
        `Exchange imbalance: total received (₹${totalReceived}) does not equal total given (₹${totalGiven})`,
      );
    }

    // 4. Validate BranchCash exists and is active
    const branchCash = await BranchCash.findOne({
      branchId,
      workspaceId,
      companyId,
      isActive: true,
    }).session(session);

    if (!branchCash) {
      throw new ApiError(400, "Branch Cash not found or inactive");
    }

    // 5. SHIFT GATE: Cash exchange is an active cashier operation requiring an open shift
    const { Shift } = await import(
      "../../../../../operations/shifts/shift.model.js"
    );
    const candidateShift = await Shift.findOne({
      companyId,
      workspaceId,
      branchId,
      status: { $in: ["open", "closing"] },
    })
      .select("_id status")
      .session(session);

    if (!candidateShift || candidateShift.status !== "open") {
      if (candidateShift && candidateShift.status === "closing") {
        throw new ApiError(
          409,
          "Cannot exchange cash: shift closing is currently in progress on another device.",
        );
      }
      throw new ApiError(
        400,
        "Cannot exchange cash: no active open shift found for this branch. Open a shift first.",
      );
    }
    const shiftId = candidateShift._id;

    // 6. PRE-FLIGHT: validate sufficient running denominations for what we give OUT
    await branchCashRepository.validateSufficientRunningDenominations(
      branchId,
      companyId,
      normGiven,
      { session },
    );

    // 7. Generate sequential exchange number: EX-YYYY-NNNNN
    const exchangeNumber = await cashExchangeRepository.getNextExchangeNumber(
      companyId,
      workspaceId,
      { session },
    );

    // 8. Update running denomination balance
    await branchCashRepository.subtractRunningDenominations(
      branchId,
      companyId,
      normGiven,
      userId,
      { session },
    );
    await branchCashRepository.addRunningDenominations(
      branchId,
      companyId,
      normReceived,
      userId,
      { session },
    );

    // 9. Persist the CashExchange record
    const cashExchange = await cashExchangeRepository.createCashExchange(
      {
        workspaceId,
        companyId,
        branchId,
        shiftId,
        exchangeNumber,
        exchangeDate: new Date(exchangeDate),
        cashPartition: "running",
        denominationsReceived: normReceived,
        totalReceived,
        denominationsGiven: normGiven,
        totalGiven,
        narration: narration || null,
        notes: notes || null,
        status: CASH_EXCHANGE_STATUS.COMPLETED,
        createdBy: userId,
      },
      { session },
    );

    await session.commitTransaction();
    session.endSession();

    // Return fully populated document
    return getCashExchangeById(cashExchange._id, companyId, workspaceId);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

// ---------------------------------------------------------------------------
// GET CASH EXCHANGES (LIST)
// ---------------------------------------------------------------------------
const getCashExchanges = async (workspaceId, companyId, query = {}) => {
  const { page, limit, sort, all, ...filters } = query;

  const result = await cashExchangeRepository.getCashExchanges(
    workspaceId,
    companyId,
    filters,
    { page, limit, sort, all: all === "true" || all === true },
  );

  return {
    cashExchanges: result.cashExchanges.map((ce) => ce.toSafeObject()),
    total: result.total,
    page: result.page,
    limit: result.limit,
  };
};

// ---------------------------------------------------------------------------
// GET CASH EXCHANGE BY ID
// ---------------------------------------------------------------------------
const getCashExchangeById = async (id, companyId, workspaceId) => {
  const cashExchange = await cashExchangeRepository.findByIdCompanyAndWorkspace(
    id,
    companyId,
    workspaceId,
  );
  if (!cashExchange) {
    throw new ApiError(404, "Cash Exchange not found");
  }
  return cashExchange.toSafeObject();
};

export default {
  createCashExchange,
  getCashExchanges,
  getCashExchangeById,
};
