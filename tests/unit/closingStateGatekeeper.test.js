import { describe, it, expect } from "@jest/globals";
import mongoose from "mongoose";
import { Shift } from "../../src/modules/operations/shifts/shift.model.js";
import BusinessDay from "../../src/modules/operations/business-days/businessDay.model.js";

describe("Shift & BusinessDay Closing State Validation", () => {
  describe("Shift Model Enum", () => {
    it("should allow 'closing' as a valid shift status", () => {
      const shift = new Shift({
        workspaceId: new mongoose.Types.ObjectId(),
        companyId: new mongoose.Types.ObjectId(),
        branchId: new mongoose.Types.ObjectId(),
        shiftNo: "SFT-TEST-001",
        businessDayId: new mongoose.Types.ObjectId(),
        date: new Date(),
        openedBy: new mongoose.Types.ObjectId(),
        status: "closing",
        closingInitiatedAt: new Date(),
        closingInitiatedBy: new mongoose.Types.ObjectId(),
      });

      const err = shift.validateSync();
      expect(err).toBeUndefined();
      expect(shift.status).toBe("closing");
    });

    it("should reject an invalid shift status", () => {
      const shift = new Shift({
        workspaceId: new mongoose.Types.ObjectId(),
        companyId: new mongoose.Types.ObjectId(),
        branchId: new mongoose.Types.ObjectId(),
        shiftNo: "SFT-TEST-002",
        businessDayId: new mongoose.Types.ObjectId(),
        date: new Date(),
        openedBy: new mongoose.Types.ObjectId(),
        status: "invalid_status",
      });

      const err = shift.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.status).toBeDefined();
    });
  });

  describe("BusinessDay Model Enum", () => {
    it("should allow 'closing' as a valid business day status", () => {
      const bd = new BusinessDay({
        workspaceId: new mongoose.Types.ObjectId(),
        companyId: new mongoose.Types.ObjectId(),
        branchId: new mongoose.Types.ObjectId(),
        businessDayNo: "BD-TEST-001",
        businessDate: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
        status: "closing",
        closingInitiatedAt: new Date(),
        closingInitiatedBy: new mongoose.Types.ObjectId(),
      });

      const err = bd.validateSync();
      expect(err).toBeUndefined();
      expect(bd.status).toBe("closing");
    });

    it("should reject an invalid business day status", () => {
      const bd = new BusinessDay({
        workspaceId: new mongoose.Types.ObjectId(),
        companyId: new mongoose.Types.ObjectId(),
        branchId: new mongoose.Types.ObjectId(),
        businessDayNo: "BD-TEST-002",
        businessDate: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
        status: "pending_closing",
      });

      const err = bd.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.status).toBeDefined();
    });
  });
});
