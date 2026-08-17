import { Mastra } from "@mastra/core";
import { DefaultExporter, Observability, SensitiveDataFilter } from "@mastra/observability";
import { novelAgent, novelCritic } from "./agents/novel-agent";
import { mastraStorage } from "./runtime-storage";
import { workbenchApiRoutes } from "./workbench-api";
import { novelProductionWorkflow } from "./workflows/novel-production-workflow";

export const mastra = new Mastra({
  storage: mastraStorage,
  observability: new Observability({ configs: { default: { serviceName: "ani-novel-agent", requestContextKeys: ["novelId", "taskType", "modelProfile"], logging: { enabled: true, level: "info" }, exporters: [new DefaultExporter()], spanOutputProcessors: [new SensitiveDataFilter()] } } }),
  agents: { novelAgent, novelCritic }, workflows: { novelProductionWorkflow },
  server: { port: Number(process.env.MASTRA_PORT ?? 4111), host: "127.0.0.1", cors: { origin: ["http://127.0.0.1:5175"] }, apiRoutes: workbenchApiRoutes },
});
