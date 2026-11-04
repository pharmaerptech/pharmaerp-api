import invoiceRoutes from "./invoices/routes/invoice.routes.js";
import b2cLegacyImportRoutes from "./invoices/routes/b2cLegacyImport.routes.js";
import returnRoutes from "./returns/routes/return.routes.js";
import creditNoteRoutes from "./credit-notes/routes/creditNote.routes.js";
import { Router } from "express";

const router = Router();

router.use("/invoices", invoiceRoutes);
router.use("/legacy-b2c-import", b2cLegacyImportRoutes);
router.use("/returns", returnRoutes);
router.use("/credit-notes", creditNoteRoutes);

export default {
  path: "/sales",
  router,
};
