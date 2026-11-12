// tests/unit/roleWorkAccessService.test.js

import { jest } from "@jest/globals";

import Role from "../../src/modules/core/access-control/models/role.model.js";
import roleService from "../../src/modules/core/access-control/services/role.service.js";
import roleRepository from "../../src/modules/core/access-control/repositories/role.repository.js";
import workspaceRepository from "../../src/modules/organization/workspaces/repositories/workspace.repository.js";
import { SYSTEM_ROLES } from "../../src/modules/core/access-control/constants/role.constant.js";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
} from "../../src/modules/core/access-control/constants/permission.constant.js";
import {
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_STATUS,
} from "../../src/modules/organization/workspaces/constants/workspace.constant.js";

describe("role.service Work Mode & Work Level enforcement", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("allows permitted admin to create branch-level operation role but blocks workspace-level escalation", async () => {
    const workspaceId = "660000000000000000000001";
    const userId = "660000000000000000000002";

    jest.spyOn(workspaceRepository, "findWorkspaceById").mockResolvedValue({
      _id: workspaceId,
      status: WORKSPACE_STATUS.ACTIVE,
    });

    jest.spyOn(workspaceRepository, "findWorkspaceMember").mockResolvedValue({
      _id: "660000000000000000000003",
      workspaceId,
      userId,
      status: WORKSPACE_MEMBER_STATUS.ACTIVE,
      isOwner: false,
      roleId: {
        _id: "660000000000000000000004",
        code: SYSTEM_ROLES.MANAGER,
        workModes: ["view", "operation"],
        workLevel: "company",
        permissions: [
          ...DEFAULT_ROLE_PERMISSIONS[SYSTEM_ROLES.MANAGER],
          PERMISSIONS.ROLE_CREATE,
          PERMISSIONS.ROLE_UPDATE,
        ],
      },
    });

    jest.spyOn(roleRepository, "findRoleByCode").mockResolvedValue(null);
    jest.spyOn(roleRepository, "createRole").mockImplementation(async (doc) => ({
      ...doc,
      _id: "660000000000000000000099",
      toSafeObject() {
        return { ...this };
      },
    }));

    // Escalating to workspace level should throw 403
    await expect(
      roleService.createRole(workspaceId, userId, {
        name: "Illegal Escalation",
        workModes: ["view"],
        workLevel: "workspace",
        permissions: [PERMISSIONS.DASHBOARD_VIEW],
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // Branch role inside manager's company hierarchy should succeed with synced permissions
    const created = await roleService.createRole(workspaceId, userId, {
      name: "Counter Operator",
      workModes: ["operation"],
      workLevel: "branch",
      permissions: [PERMISSIONS.SALE_CREATE, PERMISSIONS.DASHBOARD_VIEW],
    });

    expect(created.workModes).toEqual(["operation"]);
    expect(created.workLevel).toBe("branch");
    expect(created.allowedWorkLevels).toEqual(["branch"]);
    expect(created.permissions).toContain(PERMISSIONS.WORK_MODE_OPERATION);
    expect(created.permissions).toContain(PERMISSIONS.WORK_LEVEL_BRANCH);
  });

  test("createDefaultRolesForWorkspace seeds all 9 system roles with workModes & workLevel", async () => {
    const workspaceId = "660000000000000000000001";
    const userId = "660000000000000000000002";

    jest.spyOn(roleRepository, "findRoleByCode").mockResolvedValue(null);
    const createSpy = jest
      .spyOn(roleRepository, "createRole")
      .mockImplementation(async (doc) => ({
        ...doc,
        _id: `role_${doc.code}`,
        toSafeObject() {
          return { ...this };
        },
      }));

    const seeded = await roleService.createDefaultRolesForWorkspace(
      workspaceId,
      userId,
    );

    expect(seeded).toHaveLength(Object.values(SYSTEM_ROLES).length);
    const byCode = Object.fromEntries(seeded.map((r) => [r.code, r]));

    expect(byCode.owner.isEditable).toBe(false);
    expect(byCode.admin.isEditable).toBe(true);
    expect(byCode.admin.workLevel).toBe("workspace");
    expect(byCode.manager.workLevel).toBe("company");
    expect(byCode.cashier.workModes).toEqual(["operation"]);
    expect(byCode.cashier.workLevel).toBe("branch");
    expect(byCode.staff.workModes).toEqual(["view"]);
    expect(byCode.staff.workLevel).toBe("branch");
    expect(createSpy).toHaveBeenCalledTimes(9);
  });

  test("Role model pre-validate hook normalizes workModes, workLevel & synced permissions cleanly", async () => {
    const doc = new Role({
      workspaceId: "660000000000000000000001",
      name: "Branch Operator",
      code: "branch_operator",
      workModes: ["operation"],
      workLevel: "branch",
      permissions: [PERMISSIONS.SALE_CREATE],
    });

    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.workModes).toEqual(["operation"]);
    expect(doc.workLevel).toBe("branch");
    expect(doc.permissions).toContain(PERMISSIONS.WORK_MODE_OPERATION);
    expect(doc.permissions).toContain(PERMISSIONS.WORK_LEVEL_BRANCH);
    expect(doc.permissions).not.toContain(PERMISSIONS.WORK_MODE_VIEW);
  });
});

