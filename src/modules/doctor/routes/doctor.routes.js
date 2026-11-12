import { Router } from "express";

import authMiddleware from "../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../middlewares/companyContext.middleware.js";
import workAccessMiddleware, {
  getMethodAwareModes,
} from "../../../middlewares/workAccess.middleware.js";
import validate from "../../../middlewares/validate.middleware.js";

import {
  createDoctor,
  getDoctors,
  getDoctorById,
  updateDoctor,
  deleteDoctor,
} from "../controllers/doctor.controller.js";

import {
  createDoctorSchema,
  updateDoctorSchema,
  doctorIdParamSchema,
  getDoctorsQuerySchema,
} from "../validations/doctor.validation.js";

const router = Router();

// Middleware chain for all doctor endpoints
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(
  workAccessMiddleware((req) => ({
    minLevel: req.method === "DELETE" ? "company" : "branch",
    modes: getMethodAwareModes(req),
  })),
);

// CRUD routes
router.post("/", validate(createDoctorSchema), createDoctor);
router.get("/", validate(getDoctorsQuerySchema, "query"), getDoctors);
router.get("/:doctorId", validate(doctorIdParamSchema, "params"), getDoctorById);
router.patch(
  "/:doctorId",
  validate(doctorIdParamSchema, "params"),
  validate(updateDoctorSchema),
  updateDoctor
);
router.delete("/:doctorId", validate(doctorIdParamSchema, "params"), deleteDoctor);

export default router;
