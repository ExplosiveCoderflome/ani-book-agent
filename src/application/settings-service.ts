import type { WorkbenchDependencies } from "./workbench-dependencies";

export function createSettingsService(deps: Pick<WorkbenchDependencies, "models" | "novels" | "providerCatalog" | "interactive">) {
  async function bootstrap() {
    const [models, novels] = await Promise.all([deps.models.status(), deps.novels.list()]);
    return { models, novels, service: { studio: "ready", workbench: "ready" } };
  }
  async function providers() {
    const state = await deps.models.status();
    return deps.providerCatalog(new Set(state.configuredProviders));
  }
  const testModelConnection = () => deps.interactive.testConnection();
  return { bootstrap, providers, testModelConnection };
}
