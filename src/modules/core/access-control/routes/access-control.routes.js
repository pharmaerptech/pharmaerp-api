// src/modules/core/access-control/routes/access-control.routes.js

import { Router } from "express";

import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import workAccessMiddleware, {
  requireWorkAccess,
} from "../../../../middlewares/workAccess.middleware.js";
import permissionMiddleware from "../../../../middlewares/permission.middleware.js";
import validate from "../../../../middlewares/validate.middleware.js";

import { PERMISSIONS } from "../constants/permission.constant.js";

import {
  createRole,
  getWorkspaceRoles,
  getRoleById,
  updateRole,
  deleteRole,
  assignRoleToMember,
  getAvailablePermissions,
} from "../controllers/role.controller.js";

import {
  getMemberAccess,
  getWorkspaceMemberAccessList,
  updateMemberAccess,
  checkCompanyAccess,
  checkBranchAccess,
} from "../controllers/memberAccess.controller.js";

import {
  createRoleSchema,
  updateRoleSchema,
  assignRoleToMemberParamsSchema,
  assignRoleToMemberBodySchema,
} from "../validations/role.validation.js";

import { updateMemberAccessSchema } from "../validations/memberAccess.validation.js";

const router = Router();

router.use(authMiddleware);
router.use(workspaceContextMiddleware);

const bootSafeDiscovery = workAccessMiddleware({ allowBootDiscovery: true });
const workspaceViewOrOp = requireWorkAccess({
  minLevel: "workspace",
  modes: ["view", "operation"],
});
const workspaceOperationOnly = requireWorkAccess({
  minLevel: "workspace",
  modes: ["operation"],
});

// Boot-safe discovery & own access checks
router.get("/permissions", bootSafeDiscovery, getAvailablePermissions);
router.get("/member-access/me", bootSafeDiscovery, getMemberAccess);
router.get("/check/company/:companyId", bootSafeDiscovery, checkCompanyAccess);
router.get("/check/branch/:branchId", bootSafeDiscovery, checkBranchAccess);

// Roles
router.post(
  "/roles",
  workspaceOperationOnly,
  permissionMiddleware(PERMISSIONS.ROLE_CREATE),
  validate(createRoleSchema),
  createRole,
);

router.get("/roles", workspaceViewOrOp, getWorkspaceRoles);

router.get("/roles/:roleId", workspaceViewOrOp, getRoleById);

router.patch(
  "/roles/:roleId",
  workspaceOperationOnly,
  permissionMiddleware(PERMISSIONS.ROLE_UPDATE),
  validate(updateRoleSchema),
  updateRole,
);

router.delete(
  "/roles/:roleId",
  workspaceOperationOnly,
  permissionMiddleware(PERMISSIONS.ROLE_DELETE),
  deleteRole,
);

// Member Role Assignment
router.patch(
  "/members/:memberUserId/role",
  workspaceOperationOnly,
  permissionMiddleware([
    PERMISSIONS.ROLE_UPDATE,
    PERMISSIONS.MEMBER_ACCESS_UPDATE,
    PERMISSIONS.WORKSPACE_MEMBER_UPDATE,
  ]),
  validate(assignRoleToMemberParamsSchema, "params"),
  validate(assignRoleToMemberBodySchema, "body"),
  assignRoleToMember,
);

// Member Access Management
router.get(
  "/member-access",
  workspaceViewOrOp,
  permissionMiddleware([
    PERMISSIONS.MEMBER_ACCESS_VIEW,
    PERMISSIONS.WORKSPACE_MEMBER_VIEW,
  ]),
  getWorkspaceMemberAccessList,
);

router.get(
  "/member-access/:memberUserId",
  workspaceViewOrOp,
  getMemberAccess,
);

router.patch(
  "/member-access/:memberUserId",
  workspaceOperationOnly,
  permissionMiddleware([
    PERMISSIONS.MEMBER_ACCESS_UPDATE,
    PERMISSIONS.WORKSPACE_MEMBER_UPDATE,
  ]),
  validate(updateMemberAccessSchema),
  updateMemberAccess,
);

export default router;
