import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelSettingsStore } from "../src/infrastructure/model-settings";

test("analysis model profile survives persistence and is selected independently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ani-model-settings-"));
  try {
    const store = new ModelSettingsStore(root);
    await store.save("openai", "default-model", {});
    await store.saveProfiles({ profiles: { analysis: { providerId: "openai", modelId: "analysis-model", parameters: { maxOutputTokens: 12_000 } } } });
    const profiles = await store.profiles();
    assert.equal(profiles.profiles.analysis?.modelId, "analysis-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
