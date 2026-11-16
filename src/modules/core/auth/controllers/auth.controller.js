import asyncHandler from "../../../../utils/asyncHandler.js";
import ApiResponse from "../../../../utils/ApiResponse.js";

import authService from "../services/auth.service.js";
import onboardingService from "../services/onboarding.service.js";

import { setAuthCookie, clearAuthCookie } from "../../../../utils/cookies.js";

export const register = asyncHandler(async (req, res) => {
  const result = await onboardingService.registerWithOnboarding(req.body);

  setAuthCookie(res, result.token);

  return res.status(201).json(
    new ApiResponse(201, "Registration successful. Your workspace and free trial are ready!", {
      user: result.user,
      workspace: result.workspace,
      subscription: result.subscription,
      token: result.token,
    }),
  );
});

export const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body);

  setAuthCookie(res, result.token);

  return res.status(200).json(
    new ApiResponse(200, "Login successful", {
      user: result.user,
      token: result.token,
    }),
  );
});

export const logout = asyncHandler(async (req, res) => {
  clearAuthCookie(res);

  return res.status(200).json(new ApiResponse(200, "Logout successful"));
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const clientOrigin = req.get("origin") || req.headers.referer;
  const result = await authService.forgotPassword({
    ...req.body,
    clientOrigin,
  });

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        result.message || "Password reset link has been sent to your email",
        result,
      ),
    );
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body);

  return res
    .status(200)
    .json(new ApiResponse(200, "Password reset successful"));
});

export const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword({
    userId: req.user._id,
    oldPassword: req.body.oldPassword,
    newPassword: req.body.newPassword,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Password changed successfully"));
});

export const sendEmailOtp = asyncHandler(async (req, res) => {
  const result = await authService.sendEmailOtp(req.body);

  return res
    .status(200)
    .json(new ApiResponse(200, "OTP sent successfully", result));
});

export const verifyEmailOtp = asyncHandler(async (req, res) => {
  const result = await authService.verifyEmailOtp(req.body);

  return res
    .status(200)
    .json(new ApiResponse(200, "Email verified successfully", result));
});
