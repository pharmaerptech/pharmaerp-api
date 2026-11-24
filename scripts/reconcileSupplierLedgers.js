import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import connectDB from "../src/config/database.js";
import logger from "../src/config/logger.js";

// Ensure all models are loaded
import "../src/modules/finance/chart-of-accounts/models/accountGroup.model.js";
import "../src/modules/finance/chart-of-accounts/models/account.model.js";
import "../src/modules/finance/journal-vouchers/models/journalVoucher.model.js";
import "../src/modules/finance/journal-vouchers/models/journalLine.model.js";
import "../src/modules/finance/ledger/models/ledger.model.js";
import "../src/modules/finance/account-balances/models/accountBalance.model.js";
import "../src/modules/parties/suppliers/models/supplier.model.js";
import "../src/modules/catalog/purchase-returns/models/purchaseReturn.model.js";
import "../src/modules/finance/financial-periods/models/financialPeriod.model.js";
import "../src/modules/core/users/models/user.model.js";
import "../src/routes/index.routes.js";

import { syncPurchaseReturnLedger } from "../src/modules/catalog/purchase-returns/services/purchaseReturn.service.js";
import { computeSupplierOutstanding } from "../src/modules/parties/suppliers/services/supplier.service.js";

const run = async () => {
  try {
    await connectDB();
    logger.info("Connected to database. Starting reconciliation...");

    const PurchaseReturn = mongoose.model("PurchaseReturn");
    const Supplier = mongoose.model("Supplier");
    const Ledger = mongoose.model("Ledger");
    const JournalVoucher = mongoose.model("JournalVoucher");

    // Find all purchase returns that are dispatched / in-transit / delivered or have a creditNoteNo
    const returns = await PurchaseReturn.find({
      $or: [
        { "shippingDetails.transitStatus": { $in: ["IN_TRANSIT", "DELIVERED", "DISPATCHED"] } },
        { status: { $in: ["DISPATCHED", "CONFIRMED", "COMPLETED"] } },
        { creditNoteNo: { $exists: true, $ne: null } },
      ],
    });

    console.log(`Found ${returns.length} candidate purchase returns for reconciliation.`);

    let reconciledCount = 0;
    for (const ret of returns) {
      console.log(`Processing Purchase Return: ${ret.returnNo} (DN: ${ret.debitNoteNo}, CN: ${ret.creditNoteNo || "none"}, Total: ${ret.grandTotal})`);
      try {
        const jvId = await syncPurchaseReturnLedger(ret, ret.creditNoteNo);
        console.log(`Resulting JV ID: ${jvId}`);
        reconciledCount++;
      } catch (err) {
        console.error(`Error processing ${ret.returnNo}:`, err.message);
      }
    }

    // Now verify supplier ledgers for suppliers
    const suppliers = await Supplier.find({}).lean();
    console.log(`\nVerifying balances for ${suppliers.length} suppliers:`);
    for (const supp of suppliers) {
      if (supp.ledgerAccountId) {
        const ledgerCount = await Ledger.countDocuments({ accountId: supp.ledgerAccountId });
        const outstanding = await computeSupplierOutstanding(supp, supp.companyId, supp.workspaceId);
        console.log(`- Supplier: "${supp.businessName || supp.name}" (${supp.supplierCode || supp._id}) | Ledger Lines: ${ledgerCount} | Outstanding: ₹ ${outstanding.outstandingAmount} ${outstanding.balanceType}`);
      }
    }

    console.log(`\nReconciliation completed successfully. Processed ${reconciledCount} purchase returns.`);
    process.exit(0);
  } catch (err) {
    console.error("Reconciliation failed:", err);
    process.exit(1);
  }
};

run();
