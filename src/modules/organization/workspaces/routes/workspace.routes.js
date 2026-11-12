import { Router } from "express";

import validate from "../../../../middlewares/validate.middleware.js";
import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workAccessMiddleware, {
  requireWorkAccess,
} from "../../../../middlewares/workAccess.middleware.js";

import {
  createWorkspace,
  getMyWorkspaces,
  getWorkspaceById,
  updateWorkspace,
  deleteWorkspace,
  getWorkspaceMembers,
  updateWorkspaceMemberStatus,
  removeWorkspaceMember,
  directCreateWorkspaceMember,
  resetMemberPassword,
  getWorkspaceSetupStatus,
} from "../controllers/workspace.controller.js";

import {
  inviteWorkspaceMember,
  getWorkspaceInvitations,
  cancelWorkspaceInvitation,
  resendWorkspaceInvitation,
  updateWorkspaceInvitation,
  getPublicInvitationDetails,
  acceptWorkspaceInvitation,
  acceptWorkspaceInvitationSignup,
  getIncomingUserInvitations,
} from "../controllers/workspaceInvitation.controller.js";

import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  updateWorkspaceMemberStatusSchema,
  directCreateWorkspaceMemberSchema,
  resetMemberPasswordSchema,
} from "../validations/workspace.validation.js";

import {
  inviteWorkspaceMemberSchema,
  updateWorkspaceInvitationSchema,
  cancelWorkspaceInvitationSchema,
  resendWorkspaceInvitationSchema,
  acceptWorkspaceInvitationSchema,
  acceptWorkspaceInvitationSignupSchema,
} from "../validations/workspaceInvitation.validation.js";

const router = Router();

// --- PUBLIC INVITATION ROUTES (No prior auth required) ---
router.get("/invitations/public/:token", getPublicInvitationDetails);
router.post(
  "/invitations/:token/accept-signup",
  validate(acceptWorkspaceInvitationSignupSchema),
  acceptWorkspaceInvitationSignup,
);

// --- PROTECTED ROUTES ---
router.use(authMiddleware);

const bootSafeWorkspaceRead = workAccessMiddleware({ allowBootDiscovery: true });
const workspaceViewOrOp = requireWorkAccess({
  minLevel: "workspace",
  modes: ["view", "operation"],
});
const workspaceOperationOnly = requireWorkAccess({
  minLevel: "workspace",
  modes: ["operation"],
});

router.post("/", validate(createWorkspaceSchema), createWorkspace);

router.get("/", getMyWorkspaces);

router.post(
  "/:workspaceId/invitations",
  workspaceOperationOnly,
  validate(inviteWorkspaceMemberSchema),
  inviteWorkspaceMember,
);

router.get("/user-inbox/invitations", getIncomingUserInvitations);

router.get("/:workspaceId/invitations", workspaceViewOrOp, getWorkspaceInvitations);

router.patch(
  "/:workspaceId/invitations/:invitationId",
  workspaceOperationOnly,
  validate(updateWorkspaceInvitationSchema),
  updateWorkspaceInvitation,
);

router.post(
  "/:workspaceId/invitations/:invitationId/resend",
  workspaceOperationOnly,
  validate(resendWorkspaceInvitationSchema),
  resendWorkspaceInvitation,
);

router.patch(
  "/:workspaceId/invitations/:invitationId/cancel",
  workspaceOperationOnly,
  validate(cancelWorkspaceInvitationSchema),
  cancelWorkspaceInvitation,
);

router.post(
  "/invitations/:token/accept",
  validate(acceptWorkspaceInvitationSchema),
  acceptWorkspaceInvitation,
);

// Setup Center & Boot-Safe Workspace Summary
router.get("/:workspaceId/setup-status", bootSafeWorkspaceRead, getWorkspaceSetupStatus);

router.get("/:workspaceId", bootSafeWorkspaceRead, getWorkspaceById);

router.patch(
  "/:workspaceId",
  workspaceOperationOnly,
  validate(updateWorkspaceSchema),
  updateWorkspace,
);

router.delete("/:workspaceId", workspaceOperationOnly, deleteWorkspace);

router.get("/:workspaceId/members", workspaceViewOrOp, getWorkspaceMembers);

router.post(
  "/:workspaceId/members/direct-create",
  workspaceOperationOnly,
  validate(directCreateWorkspaceMemberSchema),
  directCreateWorkspaceMember,
);

router.post(
  "/:workspaceId/members/:memberUserId/reset-password",
  workspaceOperationOnly,
  validate(resetMemberPasswordSchema),
  resetMemberPassword,
);

router.patch(
  "/:workspaceId/members/:memberUserId/status",
  workspaceOperationOnly,
  validate(updateWorkspaceMemberStatusSchema),
  updateWorkspaceMemberStatus,
);

router.delete(
  "/:workspaceId/members/:memberUserId",
  workspaceOperationOnly,
  removeWorkspaceMember,
);

export default router;
