import crypto from "crypto";

import ApiError from "../../../../utils/ApiError.js";
import env from "../../../../config/env.js";
import { sendEmail } from "../../../../utils/sendEmail.js";

import authRepository from "../repositories/auth.repository.js";

import {
  generateAccessToken,
  buildAuthPayload,
} from "../../../../utils/jwt.js";

const hashValue = (value) => {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
};

const generateOtp = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const register = async (payload) => {
  const { email, password, fullName, phone } = payload;

  const existingEmail = await authRepository.findUserByEmail(email);

  if (existingEmail) {
    throw new ApiError(400, "Email already exists");
  }

  const user = await authRepository.createUser({
    email,
    password,
    fullName,
    phone,
  });

  const token = generateAccessToken(
    buildAuthPayload({
      userId: user._id,
    }),
  );

  return {
    user: user.toSafeObject(),
    token,
  };
};

const login = async ({ email, phone, identifier, password }) => {
  const loginInput = identifier || email || phone;

  if (!loginInput) {
    throw new ApiError(400, "Email or phone number is required");
  }

  const user = await authRepository.findUserByIdentifier(loginInput, {
    select: "+password",
  });

  if (!user) {
    throw new ApiError(401, "Invalid credentials");
  }

  if (!user.isActive) {
    throw new ApiError(403, "Account is disabled");
  }

  const isPasswordMatched = await user.comparePassword(password);

  if (!isPasswordMatched) {
    throw new ApiError(401, "Invalid credentials");
  }

  user.lastLoginAt = new Date();

  await authRepository.saveUser(user);

  const token = generateAccessToken(
    buildAuthPayload({
      userId: user._id,
    }),
  );

  return {
    user: user.toSafeObject(),
    token,
  };
};

const forgotPassword = async ({ email, clientOrigin }) => {
  const user = await authRepository.findUserByEmail(email);

  if (!user) {
    throw new ApiError(404, "User is not present with this email address");
  }

  if (!user.isActive) {
    throw new ApiError(400, "This user account is inactive or deactivated");
  }

  const resetToken = user.createPasswordResetToken();
  await authRepository.saveUser(user);

  let baseUrl = env.FRONTEND_URL || "http://localhost:5173";
  if (clientOrigin) {
    const originClean = clientOrigin.replace(/\/+$/, "");
    const allowedList = Array.isArray(env.ALLOWED_FRONTEND_URLS)
      ? env.ALLOWED_FRONTEND_URLS
      : [baseUrl];

    const isAllowed = allowedList.some((u) => u.replace(/\/+$/, "") === originClean);
    if (isAllowed) {
      baseUrl = originClean;
    }
  }

  const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

  let emailSent = false;
  let emailDeliveryError = null;

  try {
    await sendEmail({
      to: user.email,
      subject: "Password Reset Request - PharmaERP",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; color: #1e293b;">
          <div style="margin-bottom: 20px;">
            <span style="font-size: 20px; font-weight: 800; color: #0284c7;">Pharma<span style="color: #0f172a;">ERP</span></span>
          </div>
          <h2 style="font-size: 18px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px;">Reset Your Password</h2>
          <p style="font-size: 14px; line-height: 1.6; color: #475569; margin-bottom: 20px;">
            Hello${user.name || user.fullName ? ` ${user.name || user.fullName}` : ""},<br/>
            We received a request to reset your password. Click the button below to choose a new password:
          </p>
          <div style="margin: 28px 0;">
            <a href="${resetUrl}" style="background-color: #0284c7; color: #ffffff; font-size: 14px; font-weight: 700; text-decoration: none; padding: 12px 28px; border-radius: 8px; display: inline-block;">
              Reset Password
            </a>
          </div>
          <p style="font-size: 13px; line-height: 1.5; color: #64748b; margin-bottom: 16px;">
            This link is valid for <strong>30 minutes</strong>. If you did not make this request, you can safely ignore this email — your password will not be changed.
          </p>
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="font-size: 11px; color: #94a3b8; word-break: break-all;">
            If the button doesn't work, copy and paste this link in your browser:<br/>
            <a href="${resetUrl}" style="color: #0284c7;">${resetUrl}</a>
          </p>
        </div>
      `,
      text: `Reset your PharmaERP password here: ${resetUrl} (Valid for 30 minutes). If you didn't request this, please ignore.`,
    });
    emailSent = true;
  } catch (emailError) {
    emailDeliveryError = emailError?.message || String(emailError);
    console.error(
      "[AUTH] Failed to send password reset email:",
      emailDeliveryError,
    );
  }

  // In production, failure to send email is a fatal 500 error
  if (!emailSent && process.env.NODE_ENV === "production") {
    throw new ApiError(
      500,
      `Failed to dispatch password reset email: ${emailDeliveryError}`,
    );
  }

  // In development / testing, do not block testing if external API key is disabled
  if (!emailSent) {
    console.warn("==================================================================");
    console.warn("[AUTH DEV NOTICE] External email dispatch failed (e.g. API key not enabled).");
    console.warn(`Reason: ${emailDeliveryError}`);
    console.warn("Direct Reset Link generated for development testing:");
    console.warn(`==> ${resetUrl}`);
    console.warn("==================================================================");
  }

  return {
    success: true,
    emailSent,
    message: emailSent
      ? "Password reset link has been sent to your email"
      : `Email dispatch failed (${emailDeliveryError}), but you can use the direct link below.`,
    resetUrl,
    resetToken,
    warning: !emailSent ? emailDeliveryError : undefined,
  };
};

const resetPassword = async ({ token, password }) => {
  const tokenHash = hashValue(token);

  const user = await authRepository.findUserByResetToken(tokenHash);

  if (!user) {
    throw new ApiError(400, "Invalid or expired reset token");
  }

  user.password = password;

  user.clearPasswordResetToken();

  await authRepository.saveUser(user);

  return {
    success: true,
  };
};

const changePassword = async ({ userId, oldPassword, newPassword }) => {
  const user = await authRepository.findUserById(userId, {
    select: "+password",
  });

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const isPasswordMatched = await user.comparePassword(oldPassword);

  if (!isPasswordMatched) {
    throw new ApiError(400, "Old password is incorrect");
  }

  user.password = newPassword;

  await authRepository.saveUser(user);

  return {
    success: true,
  };
};

const sendEmailOtp = async ({ email }) => {
  const user = await authRepository.findUserByEmail(email, {
    select: "+emailOtpHash +emailOtpExpiresAt",
  });

  if (!user || !user.isActive) {
    return {
      success: true,
    };
  }

  const otp = generateOtp();

  user.emailOtpHash = hashValue(otp);
  user.emailOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await authRepository.saveUser(user);

  return {
    success: true,
    otp,
  };
};

const verifyEmailOtp = async ({ email, otp }) => {
  const otpHash = hashValue(otp);

  const user = await authRepository.findUserByEmailOtp(email, otpHash);

  if (!user) {
    throw new ApiError(400, "Invalid or expired OTP");
  }

  user.emailVerified = true;
  user.emailOtpHash = null;
  user.emailOtpExpiresAt = null;

  await authRepository.saveUser(user);

  return {
    success: true,
    user: user.toSafeObject(),
  };
};

export default {
  register,
  login,
  forgotPassword,
  resetPassword,
  changePassword,
  sendEmailOtp,
  verifyEmailOtp,
};
