import { Router } from "express";

import workspaceProductModule from "./products/workspaceProduct.module.js";
import catalogGlobalProductModule from "./global-products/catalogGlobalProduct.module.js";
import catalogHsnMasterModule from "./hsn-master/catalogHsnMaster.module.js";
import catalogManufacturerMasterModule from "./manufacturer-master/catalogManufacturerMaster.module.js";
import catalogUomMasterModule from "./uom-master/catalogUomMaster.module.js";
import catalogCategoryMasterModule from "./category-master/catalogCategoryMaster.module.js";
import catalogProductFormMasterModule from "./product-form-master/catalogProductFormMaster.module.js";
import catalogSaltMasterModule from "./salt-master/catalogSaltMaster.module.js";
import catalogBankMasterModule from "./bank-master/catalogBankMaster.module.js";
import purchaseBillModule from "./purchase-bills/purchaseBill.module.js";
import purchaseReturnModule from "./purchase-returns/purchaseReturn.module.js";

const router = Router();

// ---------------------
// /catalog/products
// ---------------------
router.use(workspaceProductModule.path, workspaceProductModule.router);

// ---------------------
// /catalog/global-products
// ---------------------
router.use(catalogGlobalProductModule.path, catalogGlobalProductModule.router);

// ---------------------
// /catalog/hsn-master
// ---------------------
router.use(catalogHsnMasterModule.path, catalogHsnMasterModule.router);

// ---------------------
// /catalog/manufacturer-master
// ---------------------
router.use(catalogManufacturerMasterModule.path, catalogManufacturerMasterModule.router);

// ---------------------
// /catalog/uom-master
// ---------------------
router.use(catalogUomMasterModule.path, catalogUomMasterModule.router);

// ---------------------
// /catalog/category-master
// ---------------------
router.use(catalogCategoryMasterModule.path, catalogCategoryMasterModule.router);

// ---------------------
// /catalog/product-form-master
// ---------------------
router.use(catalogProductFormMasterModule.path, catalogProductFormMasterModule.router);

// ---------------------
// /catalog/salt-master
// ---------------------
router.use(catalogSaltMasterModule.path, catalogSaltMasterModule.router);

// ---------------------
// /catalog/bank-master
// ---------------------
router.use(catalogBankMasterModule.path, catalogBankMasterModule.router);

// ---------------------
// /catalog/purchase-bills
// ---------------------
router.use(purchaseBillModule.path, purchaseBillModule.router);

// ---------------------
// /catalog/purchase-returns
// ---------------------
router.use(purchaseReturnModule.path, purchaseReturnModule.router);

export default router;
