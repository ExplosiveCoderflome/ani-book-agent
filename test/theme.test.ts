import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_THEME, isThemeId, THEMES } from "../src/web/themes";

test("theme registry keeps persisted theme ids valid and unique", () => {
  const ids = THEMES.map((theme) => theme.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(isThemeId(DEFAULT_THEME), true);
  assert.equal(isThemeId("minimal-white"), true);
  assert.equal(isThemeId("removed-theme"), false);
  assert.equal(isThemeId(null), false);
});
