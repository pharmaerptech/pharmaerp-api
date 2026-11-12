// tests/unit/workAccessMiddleware.test.js

import { jest } from "@jest/globals";

import workAccessMiddleware, {
  getMethodAwareModes,
} from "../../src/middlewares/workAccess.middleware.js";
import workspaceRepository from "../../src/modules/organization/workspaces/repositories/workspace.repository.js";
import memberAccessRepository from "../../src/modules/core/access-control/repositories/memberAccess.repository.js";
import {
  ROLE_STATUS,
  SYSTEM_ROLES,
} from "../../src/modules/core/access-control/constants/role.constant.js";
import { PERMISSIONS } from "../../src/modules/core/access-control/constants/permission.constant.js";
import { WORKSPACE_MEMBER_STATUS } from "../../src/modules/organization/workspaces/constants/workspace.constant.js";

const mockNext = () => jest.fn();

const createReq = ({
  method = "GET",
  headers = {},
  workspaceId = "ws1",
  userId = "user1",
} = {}) => ({
  method,
  headers,
  workspaceId,
  user: { _id: userId },
  params: {},
  query: {},
  body: {},
});

const mockMemberWithRole = ({
  isOwner = false,
  code = SYSTEM_ROLES.STAFF,
  workModes = ["view"],
  workLevel = "branch",
  permissions = [PERMISSIONS.DASHBOARD_VIEW],
} = {}) => {
  jest.spyOn(workspaceRepository, "findWorkspaceMember").mockResolvedValue({
    _id: "mem1",
    workspaceId: "ws1",
    userId: "user1",
    status: WORKSPACE_MEMBER_STATUS.ACTIVE,
    isOwner,
    roleId: {
      _id: "role1",
      code,
      status: ROLE_STATUS.ACTIVE,
      workModes,
      workLevel,
      permissions,
    },
  });
};

describe("workAccess.middleware", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("Owner bypasses work mode and work level restrictions", async () => {
    mockMemberWithRole({ isOwner: true, code: SYSTEM_ROLES.OWNER });
    const req = createReq({
      method: "POST",
      headers: { "x-work-level": "workspace", "x-work-mode": "operation" },
    });
    const next = mockNext();

    await workAccessMiddleware({ minLevel: "workspace", modes: ["operation"] })(
      req,
      {},
      next,
    );

    expect(next).toHaveBeenCalledWith();
    expect(req.workAccess.isOwner).toBe(true);
    expect(req.workAccess.allowedWorkLevels).toEqual([
      "workspace",
      "company",
      "branch",
    ]);
  });

  test("branch-only operation role is allowed at branch+operation and blocked at company/workspace or view", async () => {
    mockMemberWithRole({
      code: SYSTEM_ROLES.CASHIER,
      workModes: ["operation"],
      workLevel: "branch",
      permissions: [PERMISSIONS.WORK_MODE_OPERATION, PERMISSIONS.WORK_LEVEL_BRANCH],
    });
    jest
      .spyOn(memberAccessRepository, "findMemberAccessByUserAndWorkspace")
      .mockResolvedValue(null);

    // Allowed at branch + operation
    const nextOk = mockNext();
    await workAccessMiddleware({ minLevel: "branch", modes: ["operation"] })(
      createReq({
        method: "POST",
        headers: { "x-work-level": "branch", "x-work-mode": "operation" },
      }),
      {},
      nextOk,
    );
    expect(nextOk).toHaveBeenCalledWith();

    // Blocked on company level route (even with operation mode)
    const nextCoErr = mockNext();
    await workAccessMiddleware({ minLevel: "company", modes: ["operation"] })(
      createReq({
        method: "POST",
        headers: { "x-work-level": "branch", "x-work-mode": "operation" },
      }),
      {},
      nextCoErr,
    );
    expect(nextCoErr.mock.calls[0][0]).toMatchObject({
      statusCode: 403,
      code: "WORK_LEVEL_DENIED",
    });

    // Blocked when forging view mode even at branch
    const nextViewErr = mockNext();
    await workAccessMiddleware({ minLevel: "branch", modes: ["view"] })(
      createReq({
        method: "GET",
        headers: { "x-work-level": "branch", "x-work-mode": "view" },
      }),
      {},
      nextViewErr,
    );
    expect(nextViewErr.mock.calls[0][0]).toMatchObject({
      statusCode: 403,
      code: "WORK_MODE_DENIED",
    });
  });

  test("workspace + view-only role can read workspace/company/branch view routes but cannot run operation endpoints", async () => {
    mockMemberWithRole({
      code: "workspace_auditor",
      workModes: ["view"],
      workLevel: "workspace",
      permissions: [PERMISSIONS.WORK_MODE_VIEW, PERMISSIONS.WORK_LEVEL_WORKSPACE],
    });

    const nextView = mockNext();
    await workAccessMiddleware({
      minLevel: "company",
      modes: ["view", "operation"],
    })(
      createReq({
        method: "GET",
        headers: { "x-work-level": "company", "x-work-mode": "view" },
      }),
      {},
      nextView,
    );
    expect(nextView).toHaveBeenCalledWith();

    const nextOp = mockNext();
    await workAccessMiddleware((req) => ({
      minLevel: "workspace",
      modes: getMethodAwareModes(req),
    }))(
      createReq({
        method: "POST",
        headers: { "x-work-level": "workspace", "x-work-mode": "view" },
      }),
      {},
      nextOp,
    );
    expect(nextOp.mock.calls[0][0]).toMatchObject({
      statusCode: 403,
      code: "WORK_MODE_DENIED",
    });
  });

  test("allowBootDiscovery attaches workAccess without rejecting stale workspace headers on boot", async () => {
    mockMemberWithRole({
      code: SYSTEM_ROLES.STAFF,
      workModes: ["view"],
      workLevel: "branch",
      permissions: [PERMISSIONS.WORK_MODE_VIEW, PERMISSIONS.WORK_LEVEL_BRANCH],
    });

    const req = createReq({
      method: "GET",
      headers: { "x-work-level": "workspace", "x-work-mode": "operation" },
    });
    const next = mockNext();

    await workAccessMiddleware({ allowBootDiscovery: true })(req, {}, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.workAccess.highestWorkLevel).toBe("branch");
  });
});

