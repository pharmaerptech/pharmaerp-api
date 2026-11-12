// src/middlewares/permission.middleware.js

import ApiError from "../utils/ApiError.js";

import workspaceRepository from "../modules/organization/workspaces/repositories/workspace.repository.js";
import roleRepository from "../modules/core/access-control/repositories/role.repository.js";
import memberAccessRepository from "../modules/core/access-control/repositories/memberAccess.repository.js";

import { WORKSPACE_MEMBER_STATUS } from "../modules/organization/workspaces/constants/workspace.constant.js";
import { ROLE_STATUS } from "../modules/core/access-control/constants/role.constant.js";
import { resolveEffectiveWorkAccess } from "../modules/core/access-control/utils/workAccess.helper.js";

const normalizePermissions = (permissions) => {
  if (!permissions) return [];

  if (Array.isArray(permissions)) {
    return permissions;
  }

  return [permissions];
};

const hasRequiredPermission = (
  memberPermissions = [],
  requiredPermissions = [],
  requireAll = false,
) => {
  if (memberPermissions.includes("*")) {
    return true;
  }

  if (requireAll) {
    return requiredPermissions.every((permission) =>
      memberPermissions.includes(permission),
    );
  }

  return requiredPermissions.some((permission) =>
    memberPermissions.includes(permission),
  );
};

const getScopedId = (req, key) => {
  return req.params?.[key] || req.query?.[key] || req.body?.[key] || null;
};

const checkCompanyScope = async (req, userId) => {
  const companyId =
    req.companyId || req.company?._id || getScopedId(req, "companyId");

  if (!companyId) {
    return true;
  }

  return memberAccessRepository.hasCompanyAccess(
    req.workspaceId,
    userId,
    companyId,
  );
};

const checkBranchScope = async (req, userId) => {
  const branchId =
    req.branchId || req.branch?._id || getScopedId(req, "branchId");

  if (!branchId) {
    return true;
  }

  return memberAccessRepository.hasBranchAccess(
    req.workspaceId,
    userId,
    branchId,
  );
};

const permissionMiddleware = (permissions, options = {}) => {
  const requiredPermissions = normalizePermissions(permissions);

  return async (req, res, next) => {
    try {
      if (!req.user?._id) {
        throw new ApiError(401, "Authentication required");
      }

      if (!req.workspaceId) {
        throw new ApiError(400, "Workspace context is required");
      }

      const member =
        req.workspaceMember ||
        (await workspaceRepository.findWorkspaceMember(
          req.workspaceId,
          req.user._id,
          {
            populate: "roleId",
          },
        ));

      if (!member) {
        throw new ApiError(403, "You are not a member of this workspace");
      }

      if (member.status !== WORKSPACE_MEMBER_STATUS.ACTIVE) {
        throw new ApiError(403, "Workspace member is not active");
      }

      if (member.isOwner && options.skipOwnerCheck !== true) {
        req.workspaceMember = member;
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

      const primaryWorkAccess = resolveEffectiveWorkAccess({
        role: primaryRole,
        permissions: primaryRole?.permissions || [],
        isOwner: false,
      });
      req.workAccess = primaryWorkAccess;

      if (requiredPermissions.length) {
        let role = primaryRole;

        // Dynamic branch-specific role override (level hierarchy stays capped by primaryRole)
        const activeBranchId =
          req.branchId || req.branch?._id || getScopedId(req, "branchId");

        if (activeBranchId) {
          const accessRecord =
            await memberAccessRepository.findMemberAccessByUserAndWorkspace(
              req.workspaceId,
              req.user._id,
              { populate: "branchAccess.roleId" },
            );

          if (accessRecord && Array.isArray(accessRecord.branchAccess)) {
            const branchMatch = accessRecord.branchAccess.find(
              (ba) =>
                ba.branchId?.toString() === activeBranchId.toString() &&
                ba.roleId,
            );

            if (branchMatch && branchMatch.roleId) {
              role = branchMatch.roleId;
            }
          }
        }

        if (!role) {
          throw new ApiError(403, "Role is not assigned to this member");
        }

        if (!role.permissions) {
          role = await roleRepository.findRoleByIdAndWorkspace(
            role,
            req.workspaceId,
          );
        }

        if (!role) {
          throw new ApiError(403, "Role not found");
        }

        if (role.status !== ROLE_STATUS.ACTIVE) {
          throw new ApiError(403, "Role is not active");
        }

        const allowed = hasRequiredPermission(
          role.permissions,
          requiredPermissions,
          options.requireAll === true,
        );

        if (!allowed) {
          throw new ApiError(403, "You do not have required permission");
        }

        req.role = role;
        req.permissions = role.permissions || [];
      }

      if (options.checkCompanyAccess === true) {
        const hasCompanyAccess = await checkCompanyScope(req, req.user._id);

        if (!hasCompanyAccess) {
          throw new ApiError(403, "You do not have access to this company");
        }
      }

      if (options.checkBranchAccess === true) {
        const hasBranchAccess = await checkBranchScope(req, req.user._id);

        if (!hasBranchAccess) {
          throw new ApiError(403, "You do not have access to this branch");
        }
      }

      req.workspaceMember = member;

      next();
    } catch (error) {
      next(error);
    }
  };
};

export default permissionMiddleware;
