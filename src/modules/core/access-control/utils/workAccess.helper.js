// src/modules/core/access-control/utils/workAccess.helper.js

import { SYSTEM_ROLES } from "../constants/role.constant.js";
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_WORK_ACCESS,
  PERMISSIONS,
  WORK_LEVEL_PERMISSIONS,
  WORK_MODE_PERMISSIONS,
} from "../constants/permission.constant.js";

export const WORK_MODES = Object.freeze({
  VIEW: "view",
  OPERATION: "operation",
});

export const VALID_WORK_MODES = Object.freeze([
  WORK_MODES.VIEW,
  WORK_MODES.OPERATION,
]);

export const WORK_LEVELS = Object.freeze({
  WORKSPACE: "workspace",
  COMPANY: "company",
  BRANCH: "branch",
});

export const WORK_LEVEL_RANK = Object.freeze({
  [WORK_LEVELS.BRANCH]: 1,
  [WORK_LEVELS.COMPANY]: 2,
  [WORK_LEVELS.WORKSPACE]: 3,
});

export const WORK_MODE_TO_PERMISSION = Object.freeze({
  [WORK_MODES.VIEW]: PERMISSIONS.WORK_MODE_VIEW,
  [WORK_MODES.OPERATION]: PERMISSIONS.WORK_MODE_OPERATION,
});

export const PERMISSION_TO_WORK_MODE = Object.freeze({
  [PERMISSIONS.WORK_MODE_VIEW]: WORK_MODES.VIEW,
  [PERMISSIONS.WORK_MODE_OPERATION]: WORK_MODES.OPERATION,
});

export const WORK_LEVEL_TO_PERMISSION = Object.freeze({
  [WORK_LEVELS.WORKSPACE]: PERMISSIONS.WORK_LEVEL_WORKSPACE,
  [WORK_LEVELS.COMPANY]: PERMISSIONS.WORK_LEVEL_COMPANY,
  [WORK_LEVELS.BRANCH]: PERMISSIONS.WORK_LEVEL_BRANCH,
});

export const PERMISSION_TO_WORK_LEVEL = Object.freeze({
  [PERMISSIONS.WORK_LEVEL_WORKSPACE]: WORK_LEVELS.WORKSPACE,
  [PERMISSIONS.WORK_LEVEL_COMPANY]: WORK_LEVELS.COMPANY,
  [PERMISSIONS.WORK_LEVEL_BRANCH]: WORK_LEVELS.BRANCH,
});

const ALL_PERMISSION_SET = new Set(ALL_PERMISSIONS);
const WORK_ACCESS_PERMISSION_SET = new Set([
  ...WORK_MODE_PERMISSIONS,
  ...WORK_LEVEL_PERMISSIONS,
]);

const WORKSPACE_SCOPED_MODULES = new Set([
  "workspace",
  "role",
  "member-access",
  "subscription",
  "marketplace-store",
  "marketplace-product",
  "marketplace-pricing",
]);

const COMPANY_SCOPED_MODULES = new Set([
  "company",
  "branch",
  "workspace-member",
  "purchase",
  "purchase-return",
  "supplier",
  "account-group",
  "account",
  "account-balance",
  "opening-balance",
  "financial-period",
  "journal-voucher",
  "ledger",
  "report",
  "expense",
  "payment",
  "bank-account",
  "bank-transaction",
  "fund-transfer",
  "cheque",
]);

export const isValidWorkMode = (mode) =>
  mode === WORK_MODES.VIEW || mode === WORK_MODES.OPERATION;

export const isValidWorkLevel = (level) =>
  Object.prototype.hasOwnProperty.call(WORK_LEVEL_RANK, level);

export const normalizeWorkModes = (workModes = []) => {
  const raw = Array.isArray(workModes)
    ? workModes
    : workModes
      ? [workModes]
      : [];
  const normalizedSet = new Set(
    raw
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(isValidWorkMode),
  );
  // Keep deterministic canonical order
  return VALID_WORK_MODES.filter((mode) => normalizedSet.has(mode));
};

export const normalizeWorkLevel = (level) => {
  const normalized = String(level || "").trim().toLowerCase();
  return isValidWorkLevel(normalized) ? normalized : null;
};

export const getHighestWorkLevel = (levels = []) => {
  const raw = Array.isArray(levels) ? levels : levels ? [levels] : [];
  let best = null;
  let bestRank = 0;

  for (const candidate of raw) {
    const level = normalizeWorkLevel(candidate);
    if (!level) continue;
    const rank = WORK_LEVEL_RANK[level];
    if (rank > bestRank) {
      bestRank = rank;
      best = level;
    }
  }

  return best;
};

export const expandWorkLevelHierarchy = (highestLevel) => {
  const level = normalizeWorkLevel(highestLevel);
  if (!level) return [];
  const rank = WORK_LEVEL_RANK[level];
  return [
    WORK_LEVELS.WORKSPACE,
    WORK_LEVELS.COMPANY,
    WORK_LEVELS.BRANCH,
  ].filter((candidate) => WORK_LEVEL_RANK[candidate] <= rank);
};

export const sanitizePermissions = (permissions = []) => {
  const list = Array.isArray(permissions) ? permissions : [];
  const seen = new Set();
  const result = [];

  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const clean = entry.trim();
    if (!clean || !ALL_PERMISSION_SET.has(clean) || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }

  return result;
};

export const stripWorkAccessPermissions = (permissions = []) =>
  sanitizePermissions(permissions).filter(
    (permission) => !WORK_ACCESS_PERMISSION_SET.has(permission),
  );

export const extractWorkModesFromPermissions = (permissions = []) => {
  const rawSet = new Set(
    Array.isArray(permissions)
      ? permissions.filter((item) => typeof item === "string")
      : [],
  );
  return VALID_WORK_MODES.filter(
    (mode) => rawSet.has(WORK_MODE_TO_PERMISSION[mode]),
  );
};

export const extractWorkLevelFromPermissions = (permissions = []) => {
  const foundLevels = [];
  for (const permission of Array.isArray(permissions) ? permissions : []) {
    if (typeof permission !== "string") continue;
    const level = PERMISSION_TO_WORK_LEVEL[permission];
    if (level) {
      foundLevels.push(level);
    }
  }
  return getHighestWorkLevel(foundLevels);
};

export const inferLegacyCustomRoleWorkAccess = (
  permissions = [],
  roleCode = null,
) => {
  const code = String(roleCode || "").trim().toLowerCase();
  if (code && DEFAULT_ROLE_WORK_ACCESS[code]) {
    return {
      workModes: [...DEFAULT_ROLE_WORK_ACCESS[code].workModes],
      workLevel: DEFAULT_ROLE_WORK_ACCESS[code].workLevel,
    };
  }

  const clean = sanitizePermissions(permissions);
  let inferredLevel = WORK_LEVELS.BRANCH;
  let hasWritePermission = false;

  for (const perm of clean) {
    const [mod, action] = perm.split(":");
    if (WORKSPACE_SCOPED_MODULES.has(mod)) {
      inferredLevel = WORK_LEVELS.WORKSPACE;
    } else if (
      COMPANY_SCOPED_MODULES.has(mod) &&
      WORK_LEVEL_RANK[inferredLevel] < WORK_LEVEL_RANK[WORK_LEVELS.COMPANY]
    ) {
      inferredLevel = WORK_LEVELS.COMPANY;
    }

    if (["create", "update", "delete", "post"].includes(action)) {
      hasWritePermission = true;
    }
  }

  return {
    workModes: hasWritePermission
      ? [WORK_MODES.VIEW, WORK_MODES.OPERATION]
      : [WORK_MODES.VIEW],
    workLevel: inferredLevel,
  };
};

export const normalizeRoleWorkAccess = ({
  permissions = [],
  workModes,
  workLevel,
  roleCode = null,
  useLegacyInference = false,
} = {}) => {
  const normalizedCode = String(roleCode || "").trim().toLowerCase();

  if (normalizedCode === SYSTEM_ROLES.OWNER) {
    const base = stripWorkAccessPermissions(permissions);
    const syncedPermissions = [
      WORK_MODE_TO_PERMISSION[WORK_MODES.VIEW],
      WORK_MODE_TO_PERMISSION[WORK_MODES.OPERATION],
      WORK_LEVEL_TO_PERMISSION[WORK_LEVELS.WORKSPACE],
      ...base,
    ];
    return {
      workModes: [WORK_MODES.VIEW, WORK_MODES.OPERATION],
      workLevel: WORK_LEVELS.WORKSPACE,
      syncedPermissions,
    };
  }

  const explicitModes = normalizeWorkModes(workModes);
  const explicitLevel = normalizeWorkLevel(workLevel);

  const permModes = extractWorkModesFromPermissions(permissions);
  const permLevel = extractWorkLevelFromPermissions(permissions);

  const systemDefault =
    normalizedCode && DEFAULT_ROLE_WORK_ACCESS[normalizedCode]
      ? DEFAULT_ROLE_WORK_ACCESS[normalizedCode]
      : null;

  const legacyFallback = useLegacyInference
    ? inferLegacyCustomRoleWorkAccess(permissions, normalizedCode)
    : null;

  let resolvedModes = explicitModes;
  if (resolvedModes.length === 0) {
    if (permModes.length > 0) {
      resolvedModes = permModes;
    } else if (systemDefault) {
      resolvedModes = [...systemDefault.workModes];
    } else if (legacyFallback) {
      resolvedModes = [...legacyFallback.workModes];
    } else {
      resolvedModes = [WORK_MODES.VIEW];
    }
  }

  let resolvedLevel = explicitLevel || permLevel;
  if (!resolvedLevel) {
    if (systemDefault) {
      resolvedLevel = systemDefault.workLevel;
    } else if (legacyFallback) {
      resolvedLevel = legacyFallback.workLevel;
    } else {
      resolvedLevel = WORK_LEVELS.BRANCH;
    }
  }

  const workAccessPermissions = [
    ...resolvedModes.map((mode) => WORK_MODE_TO_PERMISSION[mode]),
    WORK_LEVEL_TO_PERMISSION[resolvedLevel],
  ];

  const basePermissions = stripWorkAccessPermissions(permissions);
  const syncedPermissions = Array.from(
    new Set([...workAccessPermissions, ...basePermissions]),
  );

  return {
    workModes: resolvedModes,
    workLevel: resolvedLevel,
    syncedPermissions,
  };
};

export const resolveEffectiveWorkAccess = ({
  role = null,
  permissions = [],
  isOwner = false,
} = {}) => {
  const roleCode = String(role?.code || "").trim().toLowerCase();

  if (isOwner || roleCode === SYSTEM_ROLES.OWNER) {
    return {
      allowedWorkModes: [WORK_MODES.VIEW, WORK_MODES.OPERATION],
      highestWorkLevel: WORK_LEVELS.WORKSPACE,
      allowedWorkLevels: expandWorkLevelHierarchy(WORK_LEVELS.WORKSPACE),
      defaultWorkMode: WORK_MODES.VIEW,
      defaultWorkLevel: WORK_LEVELS.WORKSPACE,
      isOwner: true,
    };
  }

  const effectivePermissions =
    Array.isArray(role?.permissions) && role.permissions.length > 0
      ? role.permissions
      : Array.isArray(permissions)
        ? permissions
        : [];

  const explicitModes = normalizeWorkModes(role?.workModes);
  const permModes = extractWorkModesFromPermissions(effectivePermissions);
  const systemDefault =
    roleCode && DEFAULT_ROLE_WORK_ACCESS[roleCode]
      ? DEFAULT_ROLE_WORK_ACCESS[roleCode]
      : null;

  let allowedWorkModes = explicitModes.length > 0 ? explicitModes : permModes;
  if (allowedWorkModes.length === 0) {
    allowedWorkModes = systemDefault
      ? [...systemDefault.workModes]
      : [WORK_MODES.VIEW];
  }

  const explicitLevel = normalizeWorkLevel(role?.workLevel);
  const permLevel = extractWorkLevelFromPermissions(effectivePermissions);
  const highestWorkLevel =
    explicitLevel ||
    permLevel ||
    systemDefault?.workLevel ||
    WORK_LEVELS.BRANCH;

  const allowedWorkLevels = expandWorkLevelHierarchy(highestWorkLevel);
  const defaultWorkMode = allowedWorkModes.includes(WORK_MODES.VIEW)
    ? WORK_MODES.VIEW
    : allowedWorkModes[0] || WORK_MODES.VIEW;

  return {
    allowedWorkModes,
    highestWorkLevel,
    allowedWorkLevels,
    defaultWorkMode,
    defaultWorkLevel: highestWorkLevel,
    isOwner: false,
  };
};

export const isWorkModeAllowed = (workAccess, requiredModes) => {
  const allowedModes = normalizeWorkModes(workAccess?.allowedWorkModes);
  if (!requiredModes || (Array.isArray(requiredModes) && requiredModes.length === 0)) {
    return allowedModes.length > 0;
  }

  const requiredList = normalizeWorkModes(requiredModes);
  if (requiredList.length === 0) {
    return allowedModes.length > 0;
  }

  return requiredList.some((mode) => allowedModes.includes(mode));
};

export const isWorkLevelAllowed = (workAccess, minLevel) => {
  const normalizedMin = normalizeWorkLevel(minLevel);
  if (!normalizedMin) return true;
  const highest = normalizeWorkLevel(workAccess?.highestWorkLevel);
  if (!highest) return false;
  return WORK_LEVEL_RANK[highest] >= WORK_LEVEL_RANK[normalizedMin];
};

export const isRequestedWorkContextCompatible = ({
  workAccess,
  requestedLevel = null,
  requestedMode = null,
  minLevel = null,
  allowedRouteModes = null,
  strictActiveLevel = false,
} = {}) => {
  const levelDeniedResult = { allowed: false, reason: "WORK_LEVEL_DENIED" };
  const modeDeniedResult = { allowed: false, reason: "WORK_MODE_DENIED" };

  if (workAccess?.isOwner) {
    return { allowed: true, reason: null };
  }

  if (minLevel && !isWorkLevelAllowed(workAccess, minLevel)) {
    return levelDeniedResult;
  }

  if (requestedLevel) {
    const cleanReqLevel = normalizeWorkLevel(requestedLevel);
    if (!cleanReqLevel) {
      return levelDeniedResult;
    }
    if (!workAccess?.allowedWorkLevels?.includes(cleanReqLevel)) {
      return levelDeniedResult;
    }
    if (
      strictActiveLevel &&
      minLevel &&
      WORK_LEVEL_RANK[cleanReqLevel] < WORK_LEVEL_RANK[minLevel]
    ) {
      return levelDeniedResult;
    }
  }

  if (allowedRouteModes && !isWorkModeAllowed(workAccess, allowedRouteModes)) {
    return modeDeniedResult;
  }

  if (requestedMode) {
    const cleanReqMode = String(requestedMode).trim().toLowerCase();
    if (!isValidWorkMode(cleanReqMode)) {
      return modeDeniedResult;
    }
    if (!workAccess?.allowedWorkModes?.includes(cleanReqMode)) {
      return modeDeniedResult;
    }
    if (allowedRouteModes) {
      const normalizedRouteModes = normalizeWorkModes(allowedRouteModes);
      if (
        normalizedRouteModes.length > 0 &&
        !normalizedRouteModes.includes(cleanReqMode)
      ) {
        return modeDeniedResult;
      }
    }
  }

  return { allowed: true, reason: null };
};

export const canActorManageRoleSpec = ({
  actorIsOwner = false,
  actorWorkAccess,
  actorPermissions = [],
  targetWorkModes = [],
  targetWorkLevel = WORK_LEVELS.BRANCH,
  targetPermissions = [],
  targetRoleCode = null,
}) => {
  const normalizedTargetCode = String(targetRoleCode || "").trim().toLowerCase();
  if (actorIsOwner) {
    return { allowed: true, message: null };
  }

  if (normalizedTargetCode === SYSTEM_ROLES.OWNER) {
    return {
      allowed: false,
      message: "Only the workspace owner can manage or assign the Owner role",
    };
  }

  const normalizedTargetLevel = normalizeWorkLevel(targetWorkLevel);
  const actorRank = WORK_LEVEL_RANK[actorWorkAccess?.highestWorkLevel] || 0;
  const targetRank = WORK_LEVEL_RANK[normalizedTargetLevel] || 0;

  if (targetRank > actorRank) {
    return {
      allowed: false,
      message: `You cannot grant "${normalizedTargetLevel}" level access higher than your own "${actorWorkAccess?.highestWorkLevel}" level`,
    };
  }

  const normalizedTargetModes = normalizeWorkModes(targetWorkModes);
  const actorModes = new Set(actorWorkAccess?.allowedWorkModes || []);
  const disallowedModes = normalizedTargetModes.filter((m) => !actorModes.has(m));
  if (disallowedModes.length > 0) {
    return {
      allowed: false,
      message: `You cannot grant work mode(s) you do not have: ${disallowedModes.join(", ")}`,
    };
  }

  const actorPermSet = new Set(actorPermissions || []);
  if (!actorPermSet.has("*")) {
    const cleanTargetPerms = stripWorkAccessPermissions(targetPermissions);
    const escalatedPerms = cleanTargetPerms.filter((p) => !actorPermSet.has(p));
    if (escalatedPerms.length > 0) {
      return {
        allowed: false,
        message: "You cannot grant permissions that you do not possess",
      };
    }
  }

  return { allowed: true, message: null };
};

export default {
  WORK_MODES,
  VALID_WORK_MODES,
  WORK_LEVELS,
  WORK_LEVEL_RANK,
  WORK_MODE_TO_PERMISSION,
  PERMISSION_TO_WORK_MODE,
  WORK_LEVEL_TO_PERMISSION,
  PERMISSION_TO_WORK_LEVEL,
  isValidWorkMode,
  isValidWorkLevel,
  normalizeWorkModes,
  normalizeWorkLevel,
  getHighestWorkLevel,
  expandWorkLevelHierarchy,
  sanitizePermissions,
  stripWorkAccessPermissions,
  extractWorkModesFromPermissions,
  extractWorkLevelFromPermissions,
  inferLegacyCustomRoleWorkAccess,
  normalizeRoleWorkAccess,
  resolveEffectiveWorkAccess,
  isWorkModeAllowed,
  isWorkLevelAllowed,
  isRequestedWorkContextCompatible,
  canActorManageRoleSpec,
};
