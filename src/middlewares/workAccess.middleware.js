// src/middlewares/workAccess.middleware.js

import ApiError from "../utils/ApiError.js";

import workspaceRepository from "../modules/organization/workspaces/repositories/workspace.repository.js";
import roleRepository from "../modules/core/access-control/repositories/role.repository.js";
import memberAccessRepository from "../modules/core/access-control/repositories/memberAccess.repository.js";

import { WORKSPACE_MEMBER_STATUS } from "../modules/organization/workspaces/constants/workspace.constant.js";
import { ROLE_STATUS } from "../modules/core/access-control/constants/role.constant.js";
import {
  WORK_LEVELS,
  WORK_MODES,
  isRequestedWorkContextCompatible,
  resolveEffectiveWorkAccess,
} from "../modules/core/access-control/utils/workAccess.helper.js";

const getScopedId = (req, headerName, key) =>
  req.headers?.[headerName] ||
  req.params?.[key] ||
  req.query?.[key] ||
  req.body?.[key] ||
  null;

export const getMethodAwareModes = (
  req,
  { readModes = [WORK_MODES.VIEW, WORK_MODES.OPERATION], writeModes = [WORK_MODES.OPERATION] } = {},
) => {
  const method = String(req.method || "GET").toUpperCase();
  return method === "GET" || method === "HEAD" ? readModes : writeModes;
};

const createForbiddenError = (reason, requestedLevel, requestedMode, policy) => {
  const message =
    reason === "WORK_LEVEL_DENIED"
      ? `Your role does not permit "${requestedLevel || policy?.minLevel || "requested"}" level access`
      : `Your role does not permit "${requestedMode || (Array.isArray(policy?.modes) ? policy.modes.join("/") : "requested")}" work mode access`;

  const error = new ApiError(403, message);
  error.code = reason;
  return error;
};

const workAccessMiddleware = (optionsOrResolver = {}) => {
  return async (req, res, next) => {
    try {
      if (!req.user?._id) {
        throw new ApiError(401, "Authentication required");
      }

      const workspaceId =
        req.workspaceId ||
        req.params?.workspaceId ||
        req.headers?.["x-workspace-id"] ||
        req.body?.workspaceId ||
        null;

      if (!workspaceId) {
        throw new ApiError(400, "Workspace context is required");
      }

      req.workspaceId = workspaceId;

      const policy =
        typeof optionsOrResolver === "function"
          ? optionsOrResolver(req) || {}
          : optionsOrResolver || {};

      let member = req.workspaceMember;
      if (!member || !member.roleId?.permissions) {
        member = await workspaceRepository.findWorkspaceMember(
          req.workspaceId,
          req.user._id,
          { populate: "roleId" },
        );
      }

      if (!member) {
        throw new ApiError(403, "You are not a member of this workspace");
      }

      if (member.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
        throw new ApiError(403, "Workspace member is not active");
      }

      req.workspaceMember = member;

      if (member.isOwner) {
        req.workAccess = resolveEffectiveWorkAccess({ isOwner: true });
        return next();
      }

      let primaryRole = member.roleId;
      if (primaryRole && !primaryRole.permissions) {
        primaryRole = await roleRepository.findRoleByIdAndWorkspace(
          primaryRole,
          req.workspaceId,
        );
      }

      if (!primaryRole) {
        throw new ApiError(403, "Role is not assigned to this member");
      }

      if (primaryRole.status && primaryRole.status !== ROLE_STATUS.ACTIVE) {
        throw new ApiError(403, "Role is not active");
      }

      let workAccess = resolveEffectiveWorkAccess({
        role: primaryRole,
        permissions: primaryRole.permissions || [],
        isOwner: false,
      });

      // Branch-specific role override may adjust branch workModes/permissions,
      // while NEVER escalating highestWorkLevel above primary role's ceiling.
      const activeBranchId =
        req.branchId ||
        req.branch?._id ||
        getScopedId(req, "x-branch-id", "branchId");

      if (activeBranchId && policy.minLevel === WORK_LEVELS.BRANCH) {
        const accessRecord =
          await memberAccessRepository.findMemberAccessByUserAndWorkspace(
            req.workspaceId,
            req.user._id,
            { populate: "branchAccess.roleId" },
          );

        const branchMatch = accessRecord?.branchAccess?.find(
          (ba) =>
            ba?.branchId &&
            String(ba.branchId._id || ba.branchId) === String(activeBranchId) &&
            ba.roleId,
        );

        if (branchMatch?.roleId) {
          let branchRole = branchMatch.roleId;
          if (!branchRole.permissions) {
            branchRole = await roleRepository.findRoleByIdAndWorkspace(
              branchRole,
              req.workspaceId,
            );
          }
          if (branchRole && branchRole.status === ROLE_STATUS.ACTIVE) {
            const branchWorkAccess = resolveEffectiveWorkAccess({
              role: branchRole,
              permissions: branchRole.permissions || [],
              isOwner: false,
            });
            workAccess = {
              ...workAccess,
              allowedWorkModes: branchWorkAccess.allowedWorkModes,
              defaultWorkMode: branchWorkAccess.defaultWorkMode,
            };
          }
        }
      }

      req.workAccess = workAccess;

      if (policy.allowBootDiscovery === true) {
        return next();
      }

      const requestedLevel = req.headers?.["x-work-level"] || null;
      const requestedMode = req.headers?.["x-work-mode"] || null;

      const check = isRequestedWorkContextCompatible({
        workAccess,
        requestedLevel,
        requestedMode,
        minLevel: policy.minLevel || null,
        allowedRouteModes: policy.modes || null,
        strictActiveLevel: policy.strictActiveLevel === true,
      });

      if (!check.allowed) {
        throw createForbiddenError(
          check.reason,
          requestedLevel,
          requestedMode,
          policy,
        );
      }

      req.workLevel = requestedLevel || workAccess.highestWorkLevel;
      req.workMode = requestedMode || workAccess.defaultWorkMode;

      return next();
    } catch (error) {
      return next(error);
    }
  };
};

export const requireWorkAccess = (policy) => workAccessMiddleware(policy);

export const requireMethodWorkAccess = ({
  minLevel = null,
  readModes = [WORK_MODES.VIEW, WORK_MODES.OPERATION],
  writeModes = [WORK_MODES.OPERATION],
} = {}) =>
  workAccessMiddleware((req) => ({
    minLevel,
    modes: getMethodAwareModes(req, { readModes, writeModes }),
  }));

export default workAccessMiddleware;
