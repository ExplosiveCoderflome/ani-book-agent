import { Mastra } from "@mastra/core";
import { DefaultExporter, Observability, SensitiveDataFilter } from "@mastra/observability";
import { createComposition } from "./composition";

const composition = createComposition();

export const mastra = new Mastra({
  storage: composition.storage,
  observability: new Observability({ configs: { default: { serviceName: "ani-novel-agent", requestContextKeys: ["novelId", "taskType", "modelProfile", "runId", "stage", "traceId", "preferenceVersion", "novelStateHash"], logging: { enabled: true, level: "info" }, exporters: [new DefaultExporter()], spanOutputProcessors: [new SensitiveDataFilter()] } } }),
  agents: composition.agents,
  workflows: composition.workflows,
  server: { port: Number(process.env.MASTRA_PORT ?? 4111), host: "127.0.0.1", cors: { origin: ["http://127.0.0.1:5175"] }, apiRoutes: composition.apiRoutes },
});
