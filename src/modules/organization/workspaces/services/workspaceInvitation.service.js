// src/modules/organization/workspaces/services/workspaceInvitation.service.js

import ApiError from "../../../../utils/ApiError.js";
import crypto from "crypto";
import mongoose from "mongoose";

import workspaceRepository from "../repositories/workspace.repository.js";
import workspaceInvitationRepository from "../repositories/workspaceInvitation.repository.js";
import subscriptionRepository from "../../../subscription/subscriptions/repositories/subscription.repository.js";
import authRepository from "../../../core/auth/repositories/auth.repository.js";
import companyRepository from "../../companies/repositories/company.repository.js";
import branchRepository from "../../branches/repositories/branch.repository.js";

import roleService from "../../../core/access-control/services/role.service.js";
import memberAccessService from "../../../core/access-control/services/memberAccess.service.js";

import { SYSTEM_ROLES } from "../../../core/access-control/constants/role.constant.js";
import { PERMISSIONS } from "../../../core/access-control/constants/permission.constant.js";
import {
  assertActorCanAssignRoleIds,
  ensureWorkspaceMemberActor,
} from "../../../core/access-control/utils/accessControlActor.helper.js";
import {
  WORKSPACE_MEMBER_STATUS,
  WORKSPACE_INVITATION_STATUS,
} from "../constants/workspace.constant.js";
import { sendEmail } from "../../../../utils/sendEmail.js";
import {
  generateAccessToken,
  buildAuthPayload,
} from "../../../../utils/jwt.js";

import WorkspaceInvitation from "../models/workspaceInvitation.model.js";

const INVITATION_EXPIRY_HOURS = 72;

const inviteMember = async (workspaceId, invitedBy, payload) => {
  const actor = await ensureWorkspaceMemberActor(workspaceId, invitedBy, {
    requiredPermissions: [PERMISSIONS.WORKSPACE_MEMBER_CREATE],
    forbiddenMessage: "Only workspace owner or authorized admin can invite members",
  });

  // Enforce prerequisite: At least 1 company and 1 branch must exist
  const totalCompanies = await companyRepository.countWorkspaceCompanies(workspaceId);
  if (totalCompanies === 0) {
    throw new ApiError(400, "Please create at least one operating company before inviting team members");
  }

  const totalBranches = await branchRepository.countWorkspaceBranches(workspaceId);
  if (totalBranches === 0) {
    throw new ApiError(400, "Please create at least one dispensary branch before inviting team members");
  }

  const email = String(payload.email).trim().toLowerCase();

  const existingInvitation =
    await workspaceInvitationRepository.findPendingInvitationByEmail(
      workspaceId,
      email,
    );

  if (existingInvitation) {
    throw new ApiError(
      400,
      "An active invitation already exists for this email",
    );
  }

  const existingUserMember =
    await workspaceRepository.findWorkspaceMemberByEmail?.(workspaceId, email);

  if (existingUserMember) {
    throw new ApiError(400, "User is already a workspace member");
  }

  const subscription =
    await subscriptionRepository.findActiveSubscriptionByWorkspace(workspaceId);

  if (!subscription) {
    throw new ApiError(400, "Active subscription not found");
  }

  const activeMembers =
    await workspaceRepository.countActiveWorkspaceMembers(workspaceId);

  const pendingInvitations =
    await workspaceInvitationRepository.countPendingInvitations(workspaceId);

  const occupiedSeats = activeMembers + pendingInvitations;

  if (occupiedSeats >= subscription.seatQuantity) {
    throw new ApiError(
      400,
      `Seat limit reached (${subscription.seatQuantity})`,
    );
  }

  let roleId = payload.roleId || payload.defaultRoleId || null;

  if (!roleId) {
    const staffRole = await roleService.getRoleByCodeForWorkspace(
      workspaceId,
      SYSTEM_ROLES.STAFF,
    );

    if (staffRole) {
      roleId = staffRole._id;
    }
  }

  const branchAccess = Array.isArray(payload.branchAccess)
    ? payload.branchAccess
    : [];

  await assertActorCanAssignRoleIds({
    workspaceId,
    actor,
    roleIds: [roleId, ...branchAccess.map((b) => b?.roleId)].filter(Boolean),
  });

  const companyIds = Array.isArray(payload.companyIds)
    ? payload.companyIds
    : [];

  const accessAllCompanies = Boolean(payload.accessAllCompanies);
  const accessAllBranches = Boolean(payload.accessAllBranches);

  const invitation = new WorkspaceInvitation({
    workspaceId,
    invitedEmail: email,
    roleId,
    accessAllCompanies,
    accessAllBranches,
    companyIds,
    branchAccess,
    invitedBy,
    notes: payload.notes,
    expiresAt: new Date(Date.now() + INVITATION_EXPIRY_HOURS * 60 * 60 * 1000),
    status: WORKSPACE_INVITATION_STATUS.PENDING,
  });

  const rawToken = invitation.createInvitationToken();

  await workspaceInvitationRepository.saveInvitation(invitation);

  const invitationLink = `${process.env.FRONTEND_URL || "http://localhost:5173"}/workspace-invitations/${rawToken}`;

  await sendEmail({
    to: email,
    subject: "You're invited to join a Workspace",
    html: `
    <div style="font-family: Arial, sans-serif; max-width: 600px;">
      <h2>Workspace Invitation</h2>
      <p>You have been invited to join a workspace.</p>
      <p>Click the button below to accept the invitation and access your assigned store facilities:</p>
      <p>
        <a
          href="${invitationLink}"
          style="
            display:inline-block;
            background:#2563eb;
            color:#ffffff;
            padding:12px 24px;
            text-decoration:none;
            border-radius:6px;
          "
        >
          Accept Invitation
        </a>
      </p>
      <p>If the button doesn't work, use this link:</p>
      <p><a href="${invitationLink}">${invitationLink}</a></p>
      <p>This invitation will expire in ${INVITATION_EXPIRY_HOURS} hours.</p>
      ${payload.notes ? `<p><strong>Message:</strong> ${payload.notes}</p>` : ""}
      <hr />
      <p style="color:#666;font-size:12px;">
        If you were not expecting this invitation, you can safely ignore this email.
      </p>
    </div>
  `,
    text: `
You have been invited to join a workspace.
Accept invitation: ${invitationLink}
This invitation expires in ${INVITATION_EXPIRY_HOURS} hours.
  `,
  });

  return invitation.toSafeObject();
};

const getWorkspaceInvitations = async (workspaceId, userId) => {
  const member = await workspaceRepository.findWorkspaceMember(
    workspaceId,
    userId,
  );

  if (!member) {
    throw new ApiError(403, "Access denied");
  }

  const invitations =
    await workspaceInvitationRepository.getWorkspaceInvitations(workspaceId, {
      populate: "roleId invitedBy acceptedBy cancelledBy branchAccess.branchId branchAccess.roleId",
    });

  return invitations.map((item) => item.toSafeObject());
};

const getIncomingUserInvitations = async (userEmail) => {
  const email = String(userEmail).trim().toLowerCase();

  await workspaceInvitationRepository.markExpiredInvitations();

  const invitations =
    await workspaceInvitationRepository.findPendingInvitationsByEmailOnly(
      email,
      { populate: "workspaceId invitedBy roleId branchAccess.branchId branchAccess.roleId" },
    );

  return invitations.map((item) => item.toSafeObject());
};

const cancelInvitation = async (workspaceId, userId, invitationId) => {
  await ensureWorkspaceMemberActor(workspaceId, userId, {
    requiredPermissions: [
      PERMISSIONS.WORKSPACE_MEMBER_UPDATE,
      PERMISSIONS.WORKSPACE_MEMBER_DELETE,
    ],
    forbiddenMessage: "Only workspace owner or authorized admin can cancel invitations",
  });

  const invitation =
    await workspaceInvitationRepository.findInvitationById(invitationId);

  if (!invitation) {
    throw new ApiError(404, "Invitation not found");
  }

  if (invitation.workspaceId.toString() !== workspaceId.toString()) {
    throw new ApiError(403, "Invitation does not belong to workspace");
  }

  const cancelledInvitation =
    await workspaceInvitationRepository.cancelInvitationById(
      invitationId,
      userId,
    );

  return cancelledInvitation.toSafeObject();
};

const resendInvitation = async (workspaceId, userId, invitationId) => {
  await ensureWorkspaceMemberActor(workspaceId, userId, {
    requiredPermissions: [
      PERMISSIONS.WORKSPACE_MEMBER_CREATE,
      PERMISSIONS.WORKSPACE_MEMBER_UPDATE,
    ],
    forbiddenMessage: "Only workspace owner or authorized admin can resend invitations",
  });

  const invitation =
    await workspaceInvitationRepository.findInvitationById(invitationId);

  if (!invitation || invitation.status !== WORKSPACE_INVITATION_STATUS.PENDING) {
    throw new ApiError(404, "Active pending invitation not found");
  }

  if (invitation.workspaceId.toString() !== workspaceId.toString()) {
    throw new ApiError(403, "Invitation does not belong to workspace");
  }

  const rawToken = invitation.createInvitationToken();
  invitation.expiresAt = new Date(
    Date.now() + INVITATION_EXPIRY_HOURS * 60 * 60 * 1000,
  );
  invitation.resendCount = (invitation.resendCount || 0) + 1;
  invitation.lastResentAt = new Date();

  await workspaceInvitationRepository.saveInvitation(invitation);

  const invitationLink = `${process.env.FRONTEND_URL || "http://localhost:5173"}/workspace-invitations/${rawToken}`;

  await sendEmail({
    to: invitation.invitedEmail,
    subject: "Reminder: You're invited to join a Workspace",
    html: `
    <div style="font-family: Arial, sans-serif; max-width: 600px;">
      <h2>Workspace Invitation Reminder</h2>
      <p>This is a reminder that you have been invited to join a workspace.</p>
      <p>Click below to accept and access your assigned store facilities:</p>
      <p>
        <a
          href="${invitationLink}"
          style="
            display:inline-block;
            background:#2563eb;
            color:#ffffff;
            padding:12px 24px;
            text-decoration:none;
            border-radius:6px;
          "
        >
          Accept Invitation
        </a>
      </p>
      <p>This invitation will expire in ${INVITATION_EXPIRY_HOURS} hours.</p>
    </div>
  `,
    text: `
Workspace invitation reminder.
Accept invitation: ${invitationLink}
This invitation expires in ${INVITATION_EXPIRY_HOURS} hours.
  `,
  });

  return invitation.toSafeObject();
};

const updateInvitation = async (workspaceId, userId, invitationId, payload) => {
  const actor = await ensureWorkspaceMemberActor(workspaceId, userId, {
    requiredPermissions: [PERMISSIONS.WORKSPACE_MEMBER_UPDATE],
    forbiddenMessage: "Only workspace owner or authorized admin can update invitations",
  });

  const invitation =
    await workspaceInvitationRepository.findInvitationById(invitationId);

  if (!invitation || invitation.status !== WORKSPACE_INVITATION_STATUS.PENDING) {
    throw new ApiError(404, "Active pending invitation not found");
  }

  if (invitation.workspaceId.toString() !== workspaceId.toString()) {
    throw new ApiError(403, "Invitation does not belong to workspace");
  }

  const candidateRoleIds = [
    ...(payload.roleId !== undefined ? [payload.roleId] : []),
    ...(Array.isArray(payload.branchAccess)
      ? payload.branchAccess.map((b) => b?.roleId)
      : []),
  ].filter(Boolean);

  if (candidateRoleIds.length > 0) {
    await assertActorCanAssignRoleIds({
      workspaceId,
      actor,
      roleIds: candidateRoleIds,
    });
  }

  if (payload.roleId !== undefined) invitation.roleId = payload.roleId;
  if (payload.accessAllCompanies !== undefined)
    invitation.accessAllCompanies = payload.accessAllCompanies;
  if (payload.accessAllBranches !== undefined)
    invitation.accessAllBranches = payload.accessAllBranches;
  if (payload.companyIds !== undefined)
    invitation.companyIds = payload.companyIds;
  if (payload.branchAccess !== undefined)
    invitation.branchAccess = payload.branchAccess;
  if (payload.notes !== undefined) invitation.notes = payload.notes;

  await workspaceInvitationRepository.saveInvitation(invitation);

  return invitation.toSafeObject();
};

const getPublicInvitationDetails = async (token) => {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const invitation = await workspaceInvitationRepository.findInvitationByTokenHash(
    tokenHash,
    {
      populate: "workspaceId invitedBy roleId branchAccess.branchId branchAccess.roleId",
    },
  );

  if (!invitation) {
    throw new ApiError(404, "Invitation not found or no longer active");
  }

  if (invitation.isExpired()) {
    throw new ApiError(400, "Invitation has expired");
  }

  const workspace = invitation.workspaceId || {};
  const inviter = invitation.invitedBy || {};

  return {
    invitationId: invitation._id,
    workspaceName: workspace.name || "Pharmacy Workspace",
    workspaceCode: workspace.workspaceCode || "-",
    invitedEmail: invitation.invitedEmail,
    invitedByName: inviter.fullName || inviter.name || "Workspace Admin",
    roleName: invitation.roleId?.name || "Staff",
    branchAccess: invitation.branchAccess || [],
    accessAllBranches: invitation.accessAllBranches,
    accessAllCompanies: invitation.accessAllCompanies,
    expiresAt: invitation.expiresAt,
  };
};

const acceptInvitation = async (tokenOrId, userId) => {
  let invitation;

  if (mongoose.Types.ObjectId.isValid(tokenOrId)) {
    invitation = await workspaceInvitationRepository.findInvitationById(
      tokenOrId,
      {
        populate: "roleId",
      },
    );
  } else {
    const tokenHash = crypto
      .createHash("sha256")
      .update(tokenOrId)
      .digest("hex");

    invitation = await workspaceInvitationRepository.findInvitationByTokenHash(
      tokenHash,
      {
        populate: "roleId",
      },
    );
  }

  if (!invitation) {
    throw new ApiError(404, "Invitation not found or no longer active");
  }

  if (invitation.isExpired()) {
    throw new ApiError(400, "Invitation has expired");
  }

  const existingMember = await workspaceRepository.findWorkspaceMember(
    invitation.workspaceId,
    userId,
  );

  if (existingMember) {
    throw new ApiError(400, "Already a member of this workspace");
  }

  // 1. Create Workspace Member
  const newMember = await workspaceRepository.createWorkspaceMember({
    workspaceId: invitation.workspaceId,
    userId,
    roleId: invitation.roleId,
    joinedViaInvitationId: invitation._id,
    createdBy: invitation.invitedBy,
    status: WORKSPACE_MEMBER_STATUS.ACTIVE,
    isOwner: false,
    isPrimary: false,
  });

  // 2. AUTOMATICALLY CREATE MemberAccess with pre-configured Branch Roles & Facilities
  await memberAccessService.createDefaultAccessForMember({
    workspaceId: invitation.workspaceId,
    workspaceMemberId: newMember._id,
    userId,
    createdBy: invitation.invitedBy,
    accessAllCompanies: invitation.accessAllCompanies ?? false,
    accessAllBranches: invitation.accessAllBranches ?? false,
    companyIds: invitation.companyIds || [],
    branchAccess: invitation.branchAccess || [],
  });

  // 3. Mark Invitation Accepted
  await workspaceInvitationRepository.markInvitationAccepted(
    invitation._id,
    userId,
  );

  return {
    success: true,
    workspaceId: invitation.workspaceId,
  };
};

const acceptInvitationWithSignup = async (token, payload) => {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const invitation = await workspaceInvitationRepository.findInvitationByTokenHash(
    tokenHash,
    {
      populate: "roleId",
    },
  );

  if (!invitation) {
    throw new ApiError(404, "Invitation not found or no longer active");
  }

  if (invitation.isExpired()) {
    throw new ApiError(400, "Invitation has expired");
  }

  const email = invitation.invitedEmail;
  let user = await authRepository.findUserByEmail(email);

  if (!user) {
    user = await authRepository.createUser({
      email,
      fullName: payload.fullName,
      password: payload.password,
      phone: payload.phone,
    });
  }

  const existingMember = await workspaceRepository.findWorkspaceMember(
    invitation.workspaceId,
    user._id,
  );

  if (existingMember) {
    throw new ApiError(400, "User is already a member of this workspace");
  }

  // 1. Create Workspace Member
  const newMember = await workspaceRepository.createWorkspaceMember({
    workspaceId: invitation.workspaceId,
    userId: user._id,
    roleId: invitation.roleId,
    joinedViaInvitationId: invitation._id,
    createdBy: invitation.invitedBy,
    status: WORKSPACE_MEMBER_STATUS.ACTIVE,
    isOwner: false,
    isPrimary: false,
  });

  // 2. Provision MemberAccess with PBAC branch-specific role scoping
  await memberAccessService.createDefaultAccessForMember({
    workspaceId: invitation.workspaceId,
    workspaceMemberId: newMember._id,
    userId: user._id,
    createdBy: invitation.invitedBy,
    accessAllCompanies: invitation.accessAllCompanies ?? false,
    accessAllBranches: invitation.accessAllBranches ?? false,
    companyIds: invitation.companyIds || [],
    branchAccess: invitation.branchAccess || [],
  });

  // 3. Mark Invitation Accepted
  await workspaceInvitationRepository.markInvitationAccepted(
    invitation._id,
    user._id,
  );

  // 4. Generate Access Token
  const authToken = generateAccessToken(buildAuthPayload({ userId: user._id }));

  return {
    success: true,
    user: user.toSafeObject(),
    token: authToken,
    workspaceId: invitation.workspaceId,
  };
};

export default {
  inviteMember,
  getWorkspaceInvitations,
  cancelInvitation,
  resendInvitation,
  updateInvitation,
  getPublicInvitationDetails,
  acceptInvitation,
  acceptInvitationWithSignup,
  getIncomingUserInvitations,
};
