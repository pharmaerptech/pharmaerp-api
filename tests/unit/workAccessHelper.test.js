// tests/unit/workAccessHelper.test.js

import {
  WORK_MODES,
  WORK_LEVELS,
  expandWorkLevelHierarchy,
  normalizeRoleWorkAccess,
  resolveEffectiveWorkAccess,
  isWorkModeAllowed,
  isWorkLevelAllowed,
  isRequestedWorkContextCompatible,
  canActorManageRoleSpec,
} from "../../src/modules/core/access-control/utils/workAccess.helper.js";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
} from "../../src/modules/core/access-control/constants/permission.constant.js";
import { SYSTEM_ROLES } from "../../src/modules/core/access-control/constants/role.constant.js";

describe("workAccess.helper", () => {
  test("expandWorkLevelHierarchy follows strict downward hierarchy", () => {
    expect(expandWorkLevelHierarchy(WORK_LEVELS.WORKSPACE)).toEqual([
      "workspace",
      "company",
      "branch",
    ]);
    expect(expandWorkLevelHierarchy(WORK_LEVELS.COMPANY)).toEqual([
      "company",
      "branch",
    ]);
    expect(expandWorkLevelHierarchy(WORK_LEVELS.BRANCH)).toEqual(["branch"]);
    expect(expandWorkLevelHierarchy("unknown")).toEqual([]);
  });

  test("work mode has NO hierarchy — view-only cannot enter operation even at workspace level", () => {
    const viewOnlyWorkspace = resolveEffectiveWorkAccess({
      role: {
        code: "auditor",
        workModes: ["view"],
        workLevel: "workspace",
        permissions: [
          PERMISSIONS.WORK_MODE_VIEW,
          PERMISSIONS.WORK_LEVEL_WORKSPACE,
          PERMISSIONS.DASHBOARD_VIEW,
        ],
      },
      isOwner: false,
    });

    expect(viewOnlyWorkspace.allowedWorkModes).toEqual(["view"]);
    expect(viewOnlyWorkspace.allowedWorkLevels).toEqual([
      "workspace",
      "company",
      "branch",
    ]);

    expect(isWorkModeAllowed(viewOnlyWorkspace, ["view"])).toBe(true);
    expect(isWorkModeAllowed(viewOnlyWorkspace, ["operation"])).toBe(false);
    expect(isWorkLevelAllowed(viewOnlyWorkspace, "workspace")).toBe(true);
    expect(isWorkLevelAllowed(viewOnlyWorkspace, "company")).toBe(true);
    expect(isWorkLevelAllowed(viewOnlyWorkspace, "branch")).toBe(true);

    expect(
      isRequestedWorkContextCompatible({
        workAccess: viewOnlyWorkspace,
        requestedLevel: "workspace",
        requestedMode: "operation",
        minLevel: "workspace",
        allowedRouteModes: ["operation"],
      }),
    ).toEqual({ allowed: false, reason: "WORK_MODE_DENIED" });
  });

  test("branch-only operation role cannot ascend to company or workspace or use view mode", () => {
    const cashierAccess = resolveEffectiveWorkAccess({
      role: {
        code: SYSTEM_ROLES.CASHIER,
        permissions: DEFAULT_ROLE_PERMISSIONS[SYSTEM_ROLES.CASHIER],
      },
      isOwner: false,
    });

    expect(cashierAccess.allowedWorkModes).toEqual(["operation"]);
    expect(cashierAccess.highestWorkLevel).toBe("branch");
    expect(cashierAccess.allowedWorkLevels).toEqual(["branch"]);

    expect(isWorkModeAllowed(cashierAccess, ["view"])).toBe(false);
    expect(isWorkModeAllowed(cashierAccess, ["operation"])).toBe(true);
    expect(isWorkLevelAllowed(cashierAccess, "branch")).toBe(true);
    expect(isWorkLevelAllowed(cashierAccess, "company")).toBe(false);
    expect(isWorkLevelAllowed(cashierAccess, "workspace")).toBe(false);

    expect(
      isRequestedWorkContextCompatible({
        workAccess: cashierAccess,
        requestedLevel: "company",
        requestedMode: "operation",
        minLevel: "branch",
      }),
    ).toEqual({ allowed: false, reason: "WORK_LEVEL_DENIED" });
  });

  test("normalizeRoleWorkAccess synchronizes workModes/workLevel with permissions and strips invalid values", () => {
    const res = normalizeRoleWorkAccess({
      permissions: [
        PERMISSIONS.SALE_VIEW,
        PERMISSIONS.WORK_LEVEL_BRANCH,
        PERMISSIONS.WORK_LEVEL_WORKSPACE,
        "nonexistent:permission",
      ],
      workModes: ["operation"],
      workLevel: "company",
    });

    expect(res.workModes).toEqual(["operation"]);
    expect(res.workLevel).toBe("company");
    expect(res.syncedPermissions).toContain(PERMISSIONS.WORK_MODE_OPERATION);
    expect(res.syncedPermissions).not.toContain(PERMISSIONS.WORK_MODE_VIEW);
    expect(res.syncedPermissions).toContain(PERMISSIONS.WORK_LEVEL_COMPANY);
    expect(res.syncedPermissions).not.toContain(PERMISSIONS.WORK_LEVEL_BRANCH);
    expect(res.syncedPermissions).not.toContain(PERMISSIONS.WORK_LEVEL_WORKSPACE);
    expect(res.syncedPermissions).toContain(PERMISSIONS.SALE_VIEW);
    expect(res.syncedPermissions).not.toContain("nonexistent:permission");
  });

  test("canActorManageRoleSpec enforces anti-escalation for non-owner admins", () => {
    const companyOpViewActor = {
      allowedWorkModes: ["view", "operation"],
      highestWorkLevel: "company",
      allowedWorkLevels: ["company", "branch"],
    };

    const escalateLevel = canActorManageRoleSpec({
      actorIsOwner: false,
      actorWorkAccess: companyOpViewActor,
      actorPermissions: [PERMISSIONS.ROLE_CREATE, PERMISSIONS.SALE_VIEW],
      targetWorkModes: ["view"],
      targetWorkLevel: "workspace",
      targetPermissions: [PERMISSIONS.SALE_VIEW],
      targetRoleCode: "custom_ws",
    });
    expect(escalateLevel.allowed).toBe(false);

    const viewOnlyActor = {
      allowedWorkModes: ["view"],
      highestWorkLevel: "workspace",
      allowedWorkLevels: ["workspace", "company", "branch"],
    };

    const escalateMode = canActorManageRoleSpec({
      actorIsOwner: false,
      actorWorkAccess: viewOnlyActor,
      actorPermissions: [PERMISSIONS.ROLE_CREATE, PERMISSIONS.SALE_VIEW],
      targetWorkModes: ["operation"],
      targetWorkLevel: "branch",
      targetPermissions: [PERMISSIONS.SALE_VIEW],
      targetRoleCode: "custom_op",
    });
    expect(escalateMode.allowed).toBe(false);

    const ownerRoleTarget = canActorManageRoleSpec({
      actorIsOwner: false,
      actorWorkAccess: {
        allowedWorkModes: ["view", "operation"],
        highestWorkLevel: "workspace",
      },
      actorPermissions: ["*"],
      targetWorkModes: ["view", "operation"],
      targetWorkLevel: "workspace",
      targetPermissions: [],
      targetRoleCode: SYSTEM_ROLES.OWNER,
    });
    expect(ownerRoleTarget.allowed).toBe(false);
  });

  test("default role permissions contain zero undefined or invalid entries", () => {
    for (const roleCode of Object.values(SYSTEM_ROLES)) {
      const perms = DEFAULT_ROLE_PERMISSIONS[roleCode];
      expect(Array.isArray(perms)).toBe(true);
      expect(perms.every((p) => typeof p === "string" && p.includes(":"))).toBe(true);
      const normalized = resolveEffectiveWorkAccess({
        role: { code: roleCode, permissions: perms },
      });
      expect(normalized.allowedWorkModes.length).toBeGreaterThan(0);
      expect(Object.values(WORK_LEVELS)).toContain(normalized.highestWorkLevel);
      expect(normalized.allowedWorkModes.every((m) => Object.values(WORK_MODES).includes(m))).toBe(true);
    }
  });
});

