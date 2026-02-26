import mongoose from "mongoose";
import { config } from "../config";
import { Admin, hashPassword } from "../models/Admin";

async function main() {
  const [username, password] = process.argv.slice(2);

  if (!username || !password) {
    console.error("Usage: ts-node src/scripts/createAdmin.ts <username> <password>");
    process.exit(1);
  }

  await mongoose.connect(config.mongoUri);

  const existing = await Admin.findOne({ username });
  if (existing) {
    console.error(`Admin "${username}" already exists`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  await Admin.create({ username, passwordHash });

  console.log(`Admin "${username}" created successfully`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
