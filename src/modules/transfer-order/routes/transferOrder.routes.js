import { Router } from "express";
import {
  createTransferOrder,
  receiveTransferOrder,
  cancelTransferOrder,
  updateTransferOrder,
  getTransferOrders,
  getTransferOrderById,
} from "../controllers/transferOrder.controller.js";
import authMiddleware from "../../../middlewares/auth.middleware.js";
import workspaceContextMiddleware from "../../../middlewares/workspaceContext.middleware.js";
import { requireMethodWorkAccess } from "../../../middlewares/workAccess.middleware.js";

const router = Router();

router.use(authMiddleware);
router.use(workspaceContextMiddleware);
router.use(requireMethodWorkAccess({ minLevel: "company" }));

router.post("/", createTransferOrder);
router.get("/", getTransferOrders);
router.get("/:id", getTransferOrderById);
router.put("/:id", updateTransferOrder);
router.post("/:id/receive", receiveTransferOrder);
router.post("/:id/cancel", cancelTransferOrder);

export default router;
