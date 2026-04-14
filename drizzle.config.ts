import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Prefer TCP URLs — Railway sets DATABASE_URL to a socket path when MySQL is linked as plugin.
const connectionString =
  process.env.MYSQL_PUBLIC_URL?.startsWith("mysql://") ? process.env.MYSQL_PUBLIC_URL :
  process.env.MYSQL_URL?.startsWith("mysql://")        ? process.env.MYSQL_URL :
  process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("No database URL found. Set MYSQL_PUBLIC_URL, MYSQL_URL, or DATABASE_URL.");
}

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: connectionString,
  },
});
