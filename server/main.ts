import { openDatabase } from "./database.ts";
import { createShopServer } from "./http.ts";
import { ShopRepository } from "./repository.ts";

async function main(): Promise<void> {
  const host = process.env.PRINT_SHOP_API_HOST ?? "127.0.0.1";
  const port = Number(process.env.PRINT_SHOP_API_PORT ?? "4100");
  const publicOrigin = process.env.PRINT_SHOP_PUBLIC_ORIGIN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PRINT_SHOP_API_PORT must be a valid TCP port.");
  }
  const localBinding = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (process.env.NODE_ENV === "production" && !localBinding
    && (!publicOrigin || new URL(publicOrigin).protocol !== "https:")) {
    throw new Error("Public production bindings require an HTTPS PRINT_SHOP_PUBLIC_ORIGIN.");
  }
  const db = await openDatabase({
    dataDir: process.env.PRINT_SHOP_DATA_DIR,
    connectionString: process.env.DATABASE_URL,
  });
  try {
    const repository = new ShopRepository(db);
    await repository.initialize();
    const server = createShopServer(repository, { publicOrigin });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    console.info(`Print Shop API ready on ${host.includes(":") ? `[${host}]` : host}:${port}.`);
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => server.closeAllConnections(), 5000);
      deadline.unref();
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await db.close();
      } finally {
        clearTimeout(deadline);
      }
    };
    const onSignal = () => {
      void shutdown().catch(() => {
        console.error("Print Shop API could not shut down cleanly.");
        process.exitCode = 1;
      });
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    server.on("error", () => {
      console.error("Print Shop API server error.");
      process.exitCode = 1;
      onSignal();
    });
  } catch (error) {
    await db.close();
    throw error;
  }
}

void main().catch(() => {
  // Database errors may contain connection strings; never print them.
  console.error("Print Shop API could not start. Check the database and API settings.");
  process.exitCode = 1;
});
