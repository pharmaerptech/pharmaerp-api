import asyncHandler from "../../../utils/asyncHandler.js";
import ApiResponse from "../../../utils/ApiResponse.js";
import doctorService from "../services/doctor.service.js";

export const createDoctor = asyncHandler(async (req, res) => {
  const doctor = await doctorService.createDoctor(
    req.workspaceId,
    req.companyId,
    req.user._id,
    req.body
  );

  return res
    .status(201)
    .json(new ApiResponse(201, "Doctor created successfully", doctor));
});

export const getDoctors = asyncHandler(async (req, res) => {
  const companyId =
    req.query.companyId && req.query.companyId !== "all"
      ? req.query.companyId
      : req.companyId;

  const result = await doctorService.getDoctors(
    req.workspaceId,
    companyId || null,
    req.query
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Doctors fetched successfully", result));
});

export const getDoctorById = asyncHandler(async (req, res) => {
  const doctor = await doctorService.getDoctorById(
    req.params.doctorId,
    req.companyId,
    req.workspaceId
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Doctor fetched successfully", doctor));
});

export const updateDoctor = asyncHandler(async (req, res) => {
  const doctor = await doctorService.updateDoctor(
    req.params.doctorId,
    req.companyId,
    req.workspaceId,
    req.user._id,
    req.body
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Doctor updated successfully", doctor));
});

export const deleteDoctor = asyncHandler(async (req, res) => {
  await doctorService.deleteDoctor(
    req.params.doctorId,
    req.companyId,
    req.workspaceId,
    req.user._id
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Doctor deleted successfully"));
});
