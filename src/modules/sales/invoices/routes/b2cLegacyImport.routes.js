import { Router } from "express";
import {
  uploadFileController,
  startImportController,
  pauseImportController,
  resumeImportController,
  getStatusController,
  getReportController,
} from "../controllers/b2cLegacyImport.controller.js";
import authMiddleware from "../../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../../middlewares/workspaceContext.middleware.js";
import companyContextMiddleware from "../../../../middlewares/companyContext.middleware.js";
import { uploadLegacyImportFile } from "../../../../middlewares/upload.middleware.js";
import { requireMethodWorkAccess } from "../../../../middlewares/workAccess.middleware.js";

const router = Router();

// Apply auth and context middlewares
router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(companyContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

// Upload endpoint with disk storage
router.post("/upload", uploadLegacyImportFile.single("file"), uploadFileController);

// Control endpoints
router.post("/:migrationId/start", startImportController);
router.post("/:migrationId/pause", pauseImportController);
router.post("/:migrationId/resume", resumeImportController);

// Status and reporting endpoints
router.get("/:migrationId/status", getStatusController);
router.get("/:migrationId/report", getReportController);

export default router;
