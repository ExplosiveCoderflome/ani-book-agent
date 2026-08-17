import { MastraCompositeStore } from "@mastra/core/storage";
import { DuckDBStore } from "@mastra/duckdb";
import { LibSQLStore } from "@mastra/libsql";
import { resolveRuntimeDatabasePath, resolveRuntimeDatabaseUrl } from "./storage-url";

const runtimeStore = new LibSQLStore({ id: "ani-novel-runtime", url: resolveRuntimeDatabaseUrl("mastra.db", "MASTRA_DB_URL") });
const observabilityStore = new DuckDBStore({
  id: "ani-novel-observability",
  path: resolveRuntimeDatabasePath("observability.duckdb", "MASTRA_OBSERVABILITY_DB_PATH"),
  memoryLimit: "512MB",
  threads: 2,
});

export const mastraStorage = new MastraCompositeStore({
  id: "ani-novel-composite-storage",
  default: runtimeStore,
  domains: { observability: observabilityStore.observability },
  retention: { observability: { spans: { maxAge: "30d" }, logs: { maxAge: "30d" }, metrics: { maxAge: "30d" }, scores: { maxAge: "30d" }, feedback: { maxAge: "30d" } } },
});
