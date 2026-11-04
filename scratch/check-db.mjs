import mongoose from "mongoose";

async function main() {
  await mongoose.connect("mongodb+srv://dev:dev%401234@erp-cluster.tqgbpyi.mongodb.net/erp?retryWrites=true&w=majority");
  const collection = mongoose.connection.collection("purchasebills");
  const ws = new mongoose.Types.ObjectId("6ab77b681fba63d384f9542d");
  const comp = new mongoose.Types.ObjectId("6ab7830e1fba63d384f95439");

  const latestBills = await collection.find({ workspaceId: ws, companyId: comp }).sort({ createdAt: -1 }).limit(3).toArray();
  console.log("Latest 3 bills:", JSON.stringify(latestBills, null, 2));

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
