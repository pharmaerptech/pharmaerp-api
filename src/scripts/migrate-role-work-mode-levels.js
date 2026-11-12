/**
 * Idempotent Migration Script: Backfill Work Mode & Work Level Permissions on Workspace Roles
 *
 * Ensures every existing workspace has:
 * 1. All 9 default SYSTEM_ROLES seeded with canonical workModes, workLevel, and work-mode:* / work-level:* permissions.
 * 2. Legacy seeded roles updated cleanly while preserving owner-customized module permissions.
 * 3. Legacy custom roles normalized with inferred workModes & workLevel and stripped of invalid/null permission keys.
 *
 * Usage:
 *   node src/scripts/migrate-role-work-mode-levels.js --dry-run
 *   node src/scripts/migrate-role-work-mode-levels.js
 *   node src/scripts/migrate-role-work-mode-levels.js --force-default-matrix
 */

import mongoose from "mongoose";
import env from "../config/env.js";

import Role from "../modules/core/access-control/models/role.model.js";
import Workspace from "../modules/organization/workspaces/models/workspace.model.js";

import {
  ROLE_STATUS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_DESCRIPTIONS,
  SYSTEM_ROLE_LABELS,
} from "../modules/core/access-control/constants/role.constant.js";
import {
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_ROLE_WORK_ACCESS,
} from "../modules/core/access-control/constants/permission.constant.js";
import {
  extractWorkLevelFromPermissions,
  extractWorkModesFromPermissions,
  normalizeRoleWorkAccess,
} from "../modules/core/access-control/utils/workAccess.helper.js";
import { WORKSPACE_STATUS } from "../modules/organization/workspaces/constants/workspace.constant.js";

const parseFlags = (argv = process.argv.slice(2)) => ({
  dryRun: argv.includes("--dry-run"),
  forceDefaultMatrix: argv.includes("--force-default-matrix"),
});

const arraysEqual = (a = [], b = []) => {
  if (a.length !== b.length) return false;
  return a.every((val, idx) => val === b[idx]);
};

export async function runMigration({
  dryRun = false,
  forceDefaultMatrix = false,
} = {}) {
  const workspaces = await Workspace.find({
    status: { $ne: WORKSPACE_STATUS.DELETED },
  }).lean();

  const summaryRows = [];
  let totalUpdated = 0;
  let totalSeeded = 0;
  let totalUnchanged = 0;

  for (const ws of workspaces) {
    const workspaceId = ws._id;
    const workspaceName = ws.name || ws.workspaceCode || String(workspaceId);
    const existingRoles = await Role.find({
      workspaceId,
      isDeleted: false,
    }).lean();

    const byCode = new Map(
      existingRoles.map((r) => [
        String(r.code || "")
          .trim()
          .toLowerCase(),
        r,
      ]),
    );

    let wsSeeded = 0;
    let wsUpdated = 0;
    let wsUnchanged = 0;

    // 1. Ensure all 9 system roles exist and have workModes + workLevel
    for (const roleCode of Object.values(SYSTEM_ROLES)) {
      const existing = byCode.get(roleCode);
      const defaultSpec = DEFAULT_ROLE_WORK_ACCESS[roleCode];

      if (!existing) {
        wsSeeded += 1;
        totalSeeded += 1;
        if (!dryRun) {
          const normalized = normalizeRoleWorkAccess({
            permissions: DEFAULT_ROLE_PERMISSIONS[roleCode] || [],
            workModes: defaultSpec?.workModes,
            workLevel: defaultSpec?.workLevel,
            roleCode,
          });
          await Role.create({
            workspaceId,
            name: SYSTEM_ROLE_LABELS[roleCode],
            code: roleCode,
            description: SYSTEM_ROLE_DESCRIPTIONS[roleCode],
            workModes: normalized.workModes,
            workLevel: normalized.workLevel,
            permissions: normalized.syncedPermissions,
            isSystem: true,
            isEditable: roleCode !== SYSTEM_ROLES.OWNER,
            status: ROLE_STATUS.ACTIVE,
            createdBy: ws.ownerId || null,
          });
        }
        continue;
      }

      const currentModes = Array.isArray(existing.workModes)
        ? existing.workModes
        : [];
      const currentLevel = existing.workLevel || null;
      const currentPerms = Array.isArray(existing.permissions)
        ? existing.permissions
        : [];
      const permModes = extractWorkModesFromPermissions(currentPerms);
      const permLevel = extractWorkLevelFromPermissions(currentPerms);

      const useDefaults =
        forceDefaultMatrix ||
        (currentModes.length === 0 && permModes.length === 0) ||
        (!currentLevel && !permLevel);

      const normalized = normalizeRoleWorkAccess({
        permissions: currentPerms,
        workModes: useDefaults ? defaultSpec?.workModes : currentModes,
        workLevel: useDefaults ? defaultSpec?.workLevel : currentLevel,
        roleCode,
      });

      const expectedEditable =
        roleCode === SYSTEM_ROLES.OWNER ? false : existing.isEditable !== false;

      const needsUpdate =
        !arraysEqual(currentModes, normalized.workModes) ||
        currentLevel !== normalized.workLevel ||
        !arraysEqual(currentPerms, normalized.syncedPermissions) ||
        existing.isEditable !== expectedEditable ||
        existing.isSystem !== true;

      if (needsUpdate) {
        wsUpdated += 1;
        totalUpdated += 1;
        if (!dryRun) {
          await Role.updateOne(
            { _id: existing._id },
            {
              $set: {
                workModes: normalized.workModes,
                workLevel: normalized.workLevel,
                permissions: normalized.syncedPermissions,
                isEditable: expectedEditable,
                isSystem: true,
              },
            },
          );
        }
      } else {
        wsUnchanged += 1;
        totalUnchanged += 1;
      }
    }

    // 2. Normalize custom roles (isSystem: false or non-system codes)
    for (const customRole of existingRoles) {
      const code = String(customRole.code || "")
        .trim()
        .toLowerCase();
      if (Object.values(SYSTEM_ROLES).includes(code)) continue;

      const currentModes = Array.isArray(customRole.workModes)
        ? customRole.workModes
        : [];
      const currentLevel = customRole.workLevel || null;
      const currentPerms = Array.isArray(customRole.permissions)
        ? customRole.permissions
        : [];

      const normalized = normalizeRoleWorkAccess({
        permissions: currentPerms,
        workModes: currentModes.length > 0 ? currentModes : undefined,
        workLevel: currentLevel || undefined,
        roleCode: null,
        useLegacyInference: true,
      });

      const needsUpdate =
        !arraysEqual(currentModes, normalized.workModes) ||
        currentLevel !== normalized.workLevel ||
        !arraysEqual(currentPerms, normalized.syncedPermissions);

      if (needsUpdate) {
        wsUpdated += 1;
        totalUpdated += 1;
        if (!dryRun) {
          await Role.updateOne(
            { _id: customRole._id },
            {
              $set: {
                workModes: normalized.workModes,
                workLevel: normalized.workLevel,
                permissions: normalized.syncedPermissions,
              },
            },
          );
        }
      } else {
        wsUnchanged += 1;
        totalUnchanged += 1;
      }
    }

    summaryRows.push({
      workspaceId: String(workspaceId),
      workspaceName,
      seededMissing: wsSeeded,
      updated: wsUpdated,
      unchanged: wsUnchanged,
    });
  }

  let incompleteCount = 0;
  if (!dryRun) {
    incompleteCount = await Role.countDocuments({
      isDeleted: false,
      $or: [
        { workModes: { $exists: false } },
        { workModes: { $size: 0 } },
        { workLevel: { $exists: false } },
        { workLevel: null },
      ],
    });
  }

  return {
    dryRun,
    forceDefaultMatrix,
    workspaceCount: workspaces.length,
    totalSeeded,
    totalUpdated,
    totalUnchanged,
    incompleteCount,
    summaryRows,
  };
}

async function main() {
  const { dryRun, forceDefaultMatrix } = parseFlags();
  const mongoUri = env.DB_URI || process.env.DB_URI || process.env.MONGODB_URI;

  if (!mongoUri) {
    console.error("MongoDB connection string (DB_URI) not configured.");
    process.exit(1);
  }

  console.log(
    `\n🚀 Starting Role Work-Mode & Work-Level Migration (${dryRun ? "DRY RUN" : "LIVE"}${forceDefaultMatrix ? " + FORCE DEFAULTS" : ""})...`,
  );

  await mongoose.connect(mongoUri);
  try {
    const result = await runMigration({ dryRun, forceDefaultMatrix });
    console.log(`\n📋 Workspaces scanned: ${result.workspaceCount}`);
    if (result.summaryRows.length > 0) {
      console.table(result.summaryRows);
    }
    console.log(
      `\n✅ Done (${dryRun ? "DRY RUN — no DB writes made" : "LIVE DB UPDATED"}): seeded=${result.totalSeeded}, updated=${result.totalUpdated}, unchanged=${result.totalUnchanged}, incompleteRemaining=${result.incompleteCount}`,
    );

    if (!dryRun && result.incompleteCount > 0) {
      throw new Error(
        `Verification failed: ${result.incompleteCount} roles still lack valid workModes/workLevel`,
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

const isDirectExecution =
  process.argv[1] &&
  import.meta.url.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").pop(),
  );

if (isDirectExecution) {
  main().catch((err) => {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  });
}
