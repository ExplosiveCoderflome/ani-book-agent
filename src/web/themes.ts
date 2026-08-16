export const THEMES = [
  { id: "daylight", label: "白天", description: "明亮、温和，适合白天长时间创作。" },
  { id: "night", label: "夜晚", description: "降低亮度与对比度，适合夜间阅读和写作。" },
  { id: "system", label: "跟随系统", description: "根据操作系统的浅色或深色模式自动切换。" },
  // Keep the original IDs valid so existing local preferences continue to work.
  { id: "warm-paper", label: "书卷暖色", description: "兼容的暖色创作主题。" },
  { id: "minimal-white", label: "专业黑白", description: "兼容的黑白编辑主题。" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export const DEFAULT_THEME: ThemeId = "daylight";
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
