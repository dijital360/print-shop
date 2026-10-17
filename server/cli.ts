import { openDatabase } from "./database.ts";
import { hashPassword } from "./http.ts";
import { ShopRepository } from "./repository.ts";

function hiddenPrompt(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("Use a terminal or supply PRINT_SHOP_STAFF_PASSWORD through the environment.");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    const finish = (error?: Error) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onEnd = () => finish(new Error("Password entry was interrupted."));
    const onData = (data: Buffer) => {
      // Ignore terminal escape sequences such as cursor keys.
      const text = data.toString("utf8").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
      for (const character of text) {
        if (character === "\u0003" || character === "\u0004") {
          finish(new Error("Password entry was cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u007f" || character === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (character >= " " && value.length < 1025) value += character;
      }
    };
    process.stderr.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "staff:create") args.shift();
  const email = args[0]?.trim().toLowerCase();
  if (args.length !== 1 || !email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Usage: npm run shop:staff -- person@example.com");
  }
  const injectedPassword = process.env.PRINT_SHOP_STAFF_PASSWORD;
  const password = injectedPassword ?? await hiddenPrompt("Staff password (at least 12 characters): ");
  if (injectedPassword === undefined && password !== await hiddenPrompt("Confirm password: ")) {
    throw new Error("Passwords do not match.");
  }
  const passwordHash = await hashPassword(password);
  const db = await openDatabase({
    dataDir: process.env.PRINT_SHOP_DATA_DIR,
    connectionString: process.env.DATABASE_URL,
  });
  try {
    const repository = new ShopRepository(db);
    await repository.initialize();
    await repository.createStaff(email, passwordHash);
    console.info("Staff account created. Sign in through the staff screen.");
  } finally {
    await db.close();
  }
}

void main().catch((error: unknown) => {
  const safeMessages = [
    "Use a terminal or supply PRINT_SHOP_STAFF_PASSWORD through the environment.",
    "Password entry was interrupted.",
    "Password entry was cancelled.",
    "Usage: npm run shop:staff -- person@example.com",
    "Passwords do not match.",
    "Password must contain between 12 and 1024 characters.",
  ];
  console.error(error instanceof Error && safeMessages.includes(error.message)
    ? error.message : "Staff account could not be created. Check the database and account settings.");
  process.exitCode = 1;
});
