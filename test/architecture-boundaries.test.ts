import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const sourceRoot = path.resolve("src");

async function sourceFiles(directory = sourceRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : [];
  }));
  return nested.flat();
}

function importSpecifiers(source: string) {
  return [...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]!);
}

function resolveLocal(from: string, specifier: string, files: Set<string>) {
  if (!specifier.startsWith(".")) return undefined;
  const stem = path.resolve(path.dirname(from), specifier).replace(/\.js$/, "");
  return [stem, `${stem}.ts`, `${stem}.tsx`, path.join(stem, "index.ts"), path.join(stem, "index.tsx")].find((candidate) => files.has(candidate));
}

test("source dependency graph has no cycles", async () => {
  const files = await sourceFiles();
  const fileSet = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    graph.set(file, importSpecifiers(source).map((specifier) => resolveLocal(file, specifier, fileSet)).filter((item): item is string => Boolean(item)));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (file: string) => {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      cycles.push([...stack.slice(start), file].map((item) => path.relative(sourceRoot, item)));
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file); stack.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    stack.pop(); visiting.delete(file); visited.add(file);
  };
  for (const file of files) visit(file);
  assert.deepEqual(cycles, []);
});

test("domain and application imports point inward", async () => {
  const files = await sourceFiles();
  const fileSet = new Set(files);
  const violations: string[] = [];
  for (const file of files) {
    const relative = path.relative(sourceRoot, file).replaceAll("\\", "/");
    if (!relative.startsWith("domain/") && !relative.startsWith("application/")) continue;
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      const target = resolveLocal(file, specifier, fileSet);
      if (!target) continue;
      const targetRelative = path.relative(sourceRoot, target).replaceAll("\\", "/");
      const forbidden = relative.startsWith("domain/")
        ? ["application/", "infrastructure/", "mastra/", "web/"]
        : ["infrastructure/", "mastra/", "web/"];
      if (forbidden.some((prefix) => targetRelative.startsWith(prefix))) violations.push(`${relative} -> ${targetRelative}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("Mastra adapters cannot construct or import repositories outside composition", async () => {
  const files = (await sourceFiles(path.join(sourceRoot, "mastra"))).filter((file) => path.basename(file) !== "composition.ts");
  const violations: string[] = [];
  for (const file of files) {
    const relative = path.relative(sourceRoot, file).replaceAll("\\", "/");
    const source = await readFile(file, "utf8");
    if (/from\s+["'][^"']*infrastructure\//.test(source)) violations.push(`${relative}: infrastructure import`);
    if (/new\s+(?:Novel|Reference|ModelSettings|AuthorPreference|MarketRadar)Repository\b/.test(source)) violations.push(`${relative}: repository construction`);
    if (relative.startsWith("mastra/workflows/") && /from\s+["'][^"']*repository/.test(source)) violations.push(`${relative}: workflow repository import`);
  }
  assert.deepEqual(violations, []);
});

test("composition is the single construction root and binds runtime before routes", async () => {
  const source = await readFile(path.join(sourceRoot, "mastra", "composition.ts"), "utf8");
  for (const constructor of ["NovelRepository", "ReferenceRepository", "ModelSettingsStore", "AuthorPreferenceRepository", "MarketRadarRepository", "SkillRegistryService"]) {
    assert.equal((source.match(new RegExp(`new ${constructor}\\b`, "g")) ?? []).length, 1, `${constructor} must have one process instance`);
  }
  const lastBindingAssertion = source.lastIndexOf(".assertBound()");
  assert.ok(lastBindingAssertion > 0);
  assert.ok(lastBindingAssertion < source.lastIndexOf("const apiRoutes = createWorkbenchApiRoutes"), "routes must be created only after all runtime ports are bound");
  const contracts = await readFile(path.join(sourceRoot, "shared", "contracts.ts"), "utf8");
  assert.doesNotMatch(contracts, /export\s+\*\s+from/);
});
