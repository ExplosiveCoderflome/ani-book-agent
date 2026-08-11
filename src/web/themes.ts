export const THEMES = [
  { id: "warm-paper", label: "书卷暖色", description: "保留当前的米白与琥珀色创作氛围。" },
  { id: "minimal-white", label: "纯白简约", description: "纯白画布、克制边框和更安静的阅读界面。" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export const DEFAULT_THEME: ThemeId = "warm-paper";
const STORAGE_KEY = "ani-novel-theme";

export function isThemeId(value: string | null): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function readStoredTheme(): ThemeId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function persistTheme(theme: ThemeId) {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Theme still applies for the current session when storage is unavailable.
  }
}
