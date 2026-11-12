import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { initializeBranchCashSchema } from "../../src/modules/finance/treasury/cash-management/branch-cash/validations/branchCash.validation.js";

describe("Branch Cash Initialization Validation & Service", () => {
  const validBranchId = "507f1f77bcf86cd799439011";
  const validWorkspaceId = "507f1f77bcf86cd799439012";
  const validCompanyId = "507f1f77bcf86cd799439013";
  const validUserId = "507f1f77bcf86cd799439014";

  describe("initializeBranchCashSchema", () => {
    it("should accept openingAmount of 0 with empty openingDenominations array", () => {
      const { error, value } = initializeBranchCashSchema.validate({
        branchId: validBranchId,
        openingAmount: 0,
        openingDenominations: [],
        narration: "New branch starting with zero cash",
      });

      expect(error).toBeUndefined();
      expect(value.openingAmount).toBe(0);
      expect(value.openingDenominations).toEqual([]);
    });

    it("should accept openingAmount of 0 when openingDenominations is omitted", () => {
      const { error, value } = initializeBranchCashSchema.validate({
        branchId: validBranchId,
        openingAmount: 0,
      });

      expect(error).toBeUndefined();
      expect(value.openingAmount).toBe(0);
      expect(value.openingDenominations).toEqual([]);
    });

    it("should reject positive openingAmount with empty openingDenominations", () => {
      const { error } = initializeBranchCashSchema.validate({
        branchId: validBranchId,
        openingAmount: 500,
        openingDenominations: [],
      });

      expect(error).toBeDefined();
    });

    it("should accept positive openingAmount with valid openingDenominations", () => {
      const { error } = initializeBranchCashSchema.validate({
        branchId: validBranchId,
        openingAmount: 500,
        openingDenominations: [{ denomination: 500, quantity: 1 }],
      });

      expect(error).toBeUndefined();
    });

    it("should reject negative openingAmount", () => {
      const { error } = initializeBranchCashSchema.validate({
        branchId: validBranchId,
        openingAmount: -10,
        openingDenominations: [],
      });

      expect(error).toBeDefined();
    });
  });

  describe("branchCashService.initializeBranchCashWithOpeningBalance", () => {
    let branchCashService;
    let mockSession;
    let mockBranchCashRepo;
    let mockAccountRepo;
    let mockFindOrCreateSystemAccount;

    beforeEach(async () => {
      jest.resetModules();

      mockSession = {
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        abortTransaction: jest.fn(),
        endSession: jest.fn(),
      };

      let storedCash = null;
      let storedBalance = null;

      mockBranchCashRepo = {
        findByBranchId: jest.fn(async () => storedCash),
        findBalanceByBranchId: jest.fn(async () => storedBalance),
        findAllByCompany: jest.fn(async () => (storedCash ? [storedCash] : [])),
        createBranchCash: jest.fn(async (doc) => {
          storedCash = {
            ...doc,
            _id: "507f1f77bcf86cd799439099",
            createdAt: new Date("2026-11-10T10:00:00Z"),
            toSafeObject() {
              return { ...this };
            },
          };
          return storedCash;
        }),
        createBranchCashBalance: jest.fn(async (doc) => {
          storedBalance = {
            ...doc,
            _id: "507f1f77bcf86cd799439098",
          };
          return storedBalance;
        }),
      };

      mockAccountRepo = {
        findAccountByCode: jest.fn(async () => ({
          _id: "507f1f77bcf86cd799439077",
          accountCode: "BCASH-99439011",
          name: "Branch Cash - Main",
        })),
        findAccountByName: jest.fn(async () => null),
      };

      mockFindOrCreateSystemAccount = jest.fn(async () => ({
        _id: "507f1f77bcf86cd799439077",
      }));

      jest.unstable_mockModule("mongoose", () => ({
        default: {
          startSession: jest.fn(async () => mockSession),
          models: {
            Branch: {
              findById: jest.fn(() => ({
                select: jest.fn(() => ({
                  session: jest.fn(async () => ({
                    name: "New Branch",
                    branchCode: "NB-01",
                  })),
                })),
              })),
            },
          },
        },
      }));

      jest.unstable_mockModule(
        "../../src/modules/finance/treasury/cash-management/branch-cash/models/branchCashBalance.model.js",
        () => ({ default: { find: jest.fn(async () => []) } })
      );

      jest.unstable_mockModule(
        "../../src/modules/finance/treasury/cash-management/branch-cash/repositories/branchCash.repository.js",
        () => ({ default: mockBranchCashRepo })
      );

      jest.unstable_mockModule(
        "../../src/modules/finance/chart-of-accounts/repositories/account.repository.js",
        () => ({ default: mockAccountRepo })
      );

      jest.unstable_mockModule(
        "../../src/modules/finance/treasury/shared/findOrCreateSystemAccount.js",
        () => ({ default: mockFindOrCreateSystemAccount })
      );

      jest.unstable_mockModule(
        "../../src/modules/operations/shifts/shift.model.js",
        () => ({
          Shift: {
            findOne: jest.fn(() => ({
              select: jest.fn(() => ({
                session: jest.fn(async () => null),
              })),
            })),
          },
        })
      );

      const mod = await import(
        "../../src/modules/finance/treasury/cash-management/branch-cash/services/branchCash.service.js"
      );
      branchCashService = mod.default;
    });

    it("should initialize branch cash with 0 openingAmount and empty openingDenominations", async () => {
      const res = await branchCashService.initializeBranchCashWithOpeningBalance(
        validWorkspaceId,
        validCompanyId,
        validUserId,
        {
          branchId: validBranchId,
          openingAmount: 0,
          openingDenominations: [],
          narration: "Initial zero cash",
        }
      );

      expect(mockBranchCashRepo.createBranchCash).toHaveBeenCalledTimes(1);
      expect(mockBranchCashRepo.createBranchCashBalance).toHaveBeenCalledWith(
        expect.objectContaining({
          runningTotal: 0,
          runningDenominations: [],
          frozenTotal: 0,
          frozenDenominations: [],
        }),
        expect.any(Object)
      );
      expect(mockSession.commitTransaction).toHaveBeenCalledTimes(1);
      expect(res.runningCash).toBe(0);
      expect(res.frozenCash).toBe(0);
      expect(res.isInitialized).toBe(true);
    });

    it("should initialize branch cash with 0 openingAmount even if zero-quantity denominations are sent", async () => {
      const res = await branchCashService.initializeBranchCashWithOpeningBalance(
        validWorkspaceId,
        validCompanyId,
        validUserId,
        {
          branchId: validBranchId,
          openingAmount: 0,
          openingDenominations: [{ denomination: 500, quantity: 0 }],
        }
      );

      expect(mockBranchCashRepo.createBranchCashBalance).toHaveBeenCalledWith(
        expect.objectContaining({
          runningTotal: 0,
          runningDenominations: [],
        }),
        expect.any(Object)
      );
      expect(res.runningCash).toBe(0);
      expect(res.isInitialized).toBe(true);
    });

    it("should reject positive openingAmount without non-zero denominations", async () => {
      await expect(
        branchCashService.initializeBranchCashWithOpeningBalance(
          validWorkspaceId,
          validCompanyId,
          validUserId,
          {
            branchId: validBranchId,
            openingAmount: 500,
            openingDenominations: [],
          }
        )
      ).rejects.toThrow(/Denomination breakdown is required/);
    });

    it("should reject 0 openingAmount when non-zero denominations are provided", async () => {
      await expect(
        branchCashService.initializeBranchCashWithOpeningBalance(
          validWorkspaceId,
          validCompanyId,
          validUserId,
          {
            branchId: validBranchId,
            openingAmount: 0,
            openingDenominations: [{ denomination: 500, quantity: 1 }],
          }
        )
      ).rejects.toThrow(/does not match declared opening amount/);
    });
  });
});
