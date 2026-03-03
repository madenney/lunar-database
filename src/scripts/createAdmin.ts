import readline from "readline";
import mongoose from "mongoose";
import { config } from "../config";
import { Admin, hashPassword } from "../models/Admin";
import { connectDb } from "../db";

function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (hidden && process.stdin.isTTY) {
      // Hide input for password
      process.stdout.write(question);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      let input = "";
      const onData = (ch: string) => {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          rl.close();
          process.stdout.write("\n");
          resolve(input);
        } else if (ch === "\u0003") {
          process.exit(1);
        } else if (ch === "\u007f" || ch === "\b") {
          if (input.length > 0) input = input.slice(0, -1);
        } else {
          input += ch;
        }
      };
      stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

const MIN_PASSWORD_LENGTH = 12;

async function main() {
  let username = process.argv[2];

  if (!username) {
    username = await prompt("Username: ");
  }
  if (!username) {
    console.error("Username is required");
    process.exit(1);
  }

  const password = await prompt("Password: ", true);
  if (!password) {
    console.error("Password is required");
    process.exit(1);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    process.exit(1);
  }
  const confirm = await prompt("Confirm password: ", true);
  if (password !== confirm) {
    console.error("Passwords do not match");
    process.exit(1);
  }

  await connectDb();

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
