import { defineConfig } from "drizzle-kit";

// Only used to generate SQL. Tend applies migrations with its own runner (src/db/migrate.ts).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
