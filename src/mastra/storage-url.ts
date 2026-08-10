import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function resolveMastraStorageUrl(options: {
  databaseUrl?: string;
  dataDirectory?: string;
  projectDirectory?: string;
} = {}): string {
  const databaseUrl = options.databaseUrl ?? process.env.MASTRA_DB_URL;
  if (databaseUrl) return databaseUrl;

  const projectDirectory = options.projectDirectory ?? process.env.INIT_CWD ?? process.cwd();
  const dataDirectory = path.resolve(
    options.dataDirectory ?? process.env.ANI_NOVEL_DATA_DIR ?? path.join(projectDirectory, ".runtime"),
  );
  mkdirSync(dataDirectory, { recursive: true });
  return pathToFileURL(path.join(dataDirectory, "mastra.db")).href;
}

export function resolveRuntimeDatabaseUrl(fileName: string, environmentVariable?: string): string {
  const configured = environmentVariable ? process.env[environmentVariable] : undefined;
  if (configured) return configured;
  const projectDirectory = process.env.INIT_CWD ?? process.cwd();
  const dataDirectory = path.resolve(process.env.ANI_NOVEL_DATA_DIR ?? path.join(projectDirectory, ".runtime"));
  mkdirSync(dataDirectory, { recursive: true });
  return pathToFileURL(path.join(dataDirectory, fileName)).href;
}

export function resolveRuntimeDatabasePath(fileName: string, environmentVariable?: string): string {
  const configured = environmentVariable ? process.env[environmentVariable] : undefined;
  if (configured) return configured.startsWith("file:") ? fileURLToPath(configured) : path.resolve(configured);
  const projectDirectory = process.env.INIT_CWD ?? process.cwd();
  const dataDirectory = path.resolve(process.env.ANI_NOVEL_DATA_DIR ?? path.join(projectDirectory, ".runtime"));
  mkdirSync(dataDirectory, { recursive: true });
  return path.join(dataDirectory, fileName);
}
