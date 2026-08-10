import { Mastra } from "@mastra/core";
import { DefaultExporter, Observability, SensitiveDataFilter } from "@mastra/observability";
import { novelProductionAgent } from "./agents/novel-production-agent";
import { artifactWorkflows } from "./workflows/artifact-workflows";
import { chapterProductionWorkflow, chapterRangeWorkflow, novelExportWorkflow } from "./workflows/chapter-workflows";
import { novelEditor, ensureDefaultPromptBlocks } from "./prompts/prompt-blocks";
import { mastraStorage } from "./runtime-storage";
import { workbenchApiRoutes } from "./workbench-api";

export const mastra = new Mastra({
  storage: mastraStorage,
  editor: novelEditor,
  observability: new Observability({
    configs: { default: { serviceName: "ani-novel-agent", logging: { enabled: true, level: "info" }, exporters: [new DefaultExporter()], spanOutputProcessors: [new SensitiveDataFilter()] } },
  }),
  agents: { novelProductionAgent },
  workflows: {
    ...artifactWorkflows,
    chapterProductionWorkflow,
    chapterRangeWorkflow,
    novelExportWorkflow,
  },
  server: {
    port: Number(process.env.MASTRA_PORT ?? 4111),
    host: "127.0.0.1",
    cors: { origin: ["http://127.0.0.1:5175"] },
    apiRoutes: workbenchApiRoutes,
  },
});

void ensureDefaultPromptBlocks().catch((error) => console.warn("默认 Prompt Blocks 将在首次请求时重试：", error instanceof Error ? error.message : error));
