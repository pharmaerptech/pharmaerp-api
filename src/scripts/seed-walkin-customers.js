/**
 * Standalone Script: Seed and Ensure Singleton Walk-in Customer for All Companies
 *
 * Ensures:
 * 1. Every existing company in the database has exactly one active Walk-in Customer.
 * 2. If any duplicates exist, keeps the primary and soft-deletes duplicates.
 * 3. Enforces the compound partial unique index: { companyId: 1, isWalkIn: 1 } (where isDeleted: false, isWalkIn: true).
 *
 * Usage:
 *   node src/scripts/seed-walkin-customers.js
 */

import mongoose from "mongoose";
import env from "../config/env.js";
import customerService from "../modules/parties/customers/services/customer.service.js";
import customerRepository from "../modules/parties/customers/repositories/customer.repository.js";
import Customer from "../modules/parties/customers/models/customer.model.js";

async function run() {
  const mongoUri = env.DB_URI || process.env.DB_URI || process.env.MONGODB_URI;

  if (!mongoUri) {
    console.error("❌ MongoDB connection string not found. Please set DB_URI in your .env file.");
    process.exit(1);
  }

  console.log("⏳ Connecting to MongoDB...");
  await mongoose.connect(mongoUri);
  console.log("✅ Connected to MongoDB\n");

  const db = mongoose.connection.db;
  const companiesCollection = db.collection("companies");
  const customersCollection = db.collection("customers");

  // Drop legacy global customerCode_1 index if present
  const existingIndexes = await customersCollection.indexes();
  const legacyCodeIndex = existingIndexes.find((i) => i.name === "customerCode_1");
  if (legacyCodeIndex) {
    console.log("⚠️ Found legacy global 'customerCode_1' index. Dropping it...");
    await customersCollection.dropIndex("customerCode_1");
    console.log("✅ Successfully dropped legacy global 'customerCode_1' index.\n");
  }

  // Ensure company-scoped customerCode index
  try {
    await customersCollection.createIndex(
      { companyId: 1, customerCode: 1 },
      {
        unique: true,
        partialFilterExpression: { isDeleted: false, customerCode: { $type: "string" } },
        name: "companyId_1_customerCode_1",
      }
    );
    console.log("✅ Ensured company-scoped unique index 'companyId_1_customerCode_1'.\n");
  } catch (idxErr) {
    console.warn("⚠️ customerCode index notice:", idxErr.message);
  }

  // 1. Fetch all active companies
  const companies = await companiesCollection.find({ isDeleted: { $ne: true } }).toArray();
  console.log(`📋 Total active companies found: ${companies.length}\n`);

  if (companies.length === 0) {
    console.log("⚠️ No active companies found in the database.");
    await mongoose.disconnect();
    process.exit(0);
  }

  const results = [];

  for (let i = 0; i < companies.length; i++) {
    const comp = companies[i];
    const companyId = comp._id;
    const workspaceId = comp.workspaceId;
    const companyName = comp.name || comp.companyName || `Company #${i + 1}`;

    console.log(`[${i + 1}/${companies.length}] Processing Company: "${companyName}" (${companyId.toString()})`);

    // Find all potential walk-in records for this company
    const walkIns = await customersCollection
      .find({
        companyId,
        isDeleted: { $ne: true },
        $or: [
          { isWalkIn: true },
          { customerType: "walk_in" },
          { customerCode: "WALK-IN" },
          { name: { $regex: /^walk-?in\s*customer$/i } },
        ],
      })
      .sort({ createdAt: 1 })
      .toArray();

    let status = "unchanged";
    let activeCustomer = null;

    if (walkIns.length === 0) {
      // Case A: Missing Walk-in Customer -> Provision one
      console.log(`  ➕ No Walk-in customer found. Creating default Walk-in customer...`);
      try {
        activeCustomer = await customerService.findOrCreateWalkInCustomer(
          workspaceId,
          companyId,
          comp.createdBy || null
        );
        status = "created";
        console.log(`  ✅ Created Walk-in Customer: ID ${activeCustomer._id || activeCustomer.id}`);
      } catch (err) {
        console.error(`  ❌ Failed to create walk-in customer for company ${companyId}:`, err.message);
        status = `error: ${err.message}`;
      }
    } else if (walkIns.length === 1) {
      // Case B: Exactly one walk-in customer exists -> Ensure required fields are set
      const single = walkIns[0];
      const needsUpdate =
        !single.isWalkIn ||
        !single.isSystemCustomer ||
        single.customerType !== "walk_in" ||
        single.customerCode !== "WALK-IN" ||
        Number(single.creditLimit || 0) > 0 ||
        Number(single.creditDays || 0) > 0;

      if (needsUpdate) {
        await customersCollection.updateOne(
          { _id: single._id },
          {
            $set: {
              name: "Walk-in Customer",
              customerCode: "WALK-IN",
              customerType: "walk_in",
              isWalkIn: true,
              isSystemCustomer: true,
              creditLimit: 0,
              creditDays: 0,
              openingBalance: 0,
              advanceBalance: 0,
              creditOutstanding: 0,
              creditNoteBalance: 0,
              status: "active",
            },
          }
        );
        status = "promoted/repaired";
        console.log(`  🔧 Repaired & normalized Walk-in Customer: ID ${single._id}`);
      } else {
        status = "already_present";
        console.log(`  ✓ Walk-in Customer already present and valid: ID ${single._id}`);
      }
      activeCustomer = single;
    } else {
      // Case C: Multiple Walk-in customers found -> Deduplicate, keep one primary, soft-delete duplicates
      console.log(`  ⚠️ Multiple Walk-in customers found (${walkIns.length}). Deduplicating to strictly ONE...`);
      // Pick primary: prefer one with ledgerAccountId or oldest
      const primary = walkIns.find((w) => w.ledgerAccountId) || walkIns[0];
      const duplicateIds = walkIns.filter((w) => w._id.toString() !== primary._id.toString()).map((w) => w._id);

      // Normalize primary
      await customersCollection.updateOne(
        { _id: primary._id },
        {
          $set: {
            name: "Walk-in Customer",
            customerCode: "WALK-IN",
            customerType: "walk_in",
            isWalkIn: true,
            isSystemCustomer: true,
            creditLimit: 0,
            creditDays: 0,
            openingBalance: 0,
            advanceBalance: 0,
            creditOutstanding: 0,
            creditNoteBalance: 0,
            status: "active",
          },
        }
      );

      // Soft delete duplicates
      if (duplicateIds.length > 0) {
        await customersCollection.updateMany(
          { _id: { $in: duplicateIds } },
          {
            $set: {
              isDeleted: true,
              deletedAt: new Date(),
              isWalkIn: false,
              name: `Walk-in Customer (Merged Duplicate)`,
            },
          }
        );
        console.log(`  🗑️ Soft-deleted ${duplicateIds.length} duplicate walk-in customer records.`);
      }

      status = `deduplicated (${duplicateIds.length} removed)`;
      activeCustomer = primary;
    }

    results.push({
      company: companyName,
      companyId: companyId.toString(),
      walkInId: activeCustomer?._id?.toString() || activeCustomer?.id?.toString() || "N/A",
      status,
    });
  }

  // 2. Ensure partial unique compound index exists: { companyId: 1, isWalkIn: 1 }
  console.log("\n🔒 Ensuring partial unique compound index on 'customers' collection...");
  try {
    await customersCollection.createIndex(
      { companyId: 1, isWalkIn: 1 },
      {
        unique: true,
        partialFilterExpression: { isDeleted: false, isWalkIn: true },
        name: "companyId_1_isWalkIn_1_unique_active",
      }
    );
    console.log("✅ Partial unique index 'companyId_1_isWalkIn_1_unique_active' confirmed and active.");
  } catch (idxErr) {
    console.warn("⚠️ Index creation notice:", idxErr.message);
  }

  // 3. Final Verification: Check every company has exactly 1 active walk-in customer
  console.log("\n🔍 Running final post-migration verification across all companies...");
  let verificationPassed = true;

  for (const comp of companies) {
    const activeCount = await customersCollection.countDocuments({
      companyId: comp._id,
      isDeleted: false,
      isWalkIn: true,
    });

    if (activeCount !== 1) {
      console.error(`❌ Verification failed for Company "${comp.name || comp.companyName}": Expected 1 Walk-in Customer, found ${activeCount}`);
      verificationPassed = false;
    }
  }

  console.log("\n========================================================");
  console.log("            WALK-IN CUSTOMER SEEDING SUMMARY            ");
  console.log("========================================================");
  console.table(results);

  if (verificationPassed) {
    console.log(`\n🎉 SUCCESS: All ${companies.length} companies now have exactly ONE active Walk-in Customer!`);
  } else {
    console.error(`\n❌ WARNING: Some companies did not pass the 1-per-company verification check.`);
  }

  await mongoose.disconnect();
  console.log("🏁 Database connection closed.");
  process.exit(verificationPassed ? 0 : 1);
}

run().catch((err) => {
  console.error("💥 Unhandled script error:", err);
  process.exit(1);
});
