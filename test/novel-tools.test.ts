import assert from "node:assert/strict";
import test from "node:test";
import { writeWorkspaceFileInputSchema } from "../src/mastra/tools/novel-tools";

test("workspace writes default omitted paths to the non-authoritative ideas file", () => {
  assert.deepEqual(writeWorkspaceFileInputSchema.parse({ content: "# 开书想法\n" }), {
    path: "ideas.md",
    content: "# 开书想法\n",
  });
  const jsonSchema = writeWorkspaceFileInputSchema.toJSONSchema();
  assert.equal(jsonSchema.required?.includes("path"), false);
  assert.equal(writeWorkspaceFileInputSchema.safeParse({ path: "", content: "越界" }).success, false);
});
