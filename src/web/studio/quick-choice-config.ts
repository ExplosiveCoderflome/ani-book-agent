export const quickChoiceConfig = Object.freeze({
  minimumSequentialChoices: 3,
  minimumExplicitChoices: 2,
  maximumChoices: 8,
  minimumHeadingLength: 2,
  maximumHeadingLength: 36,
  maximumLabelLength: 42,
  patterns: Object.freeze({
    fencedCode: /(?:```|~~~)[\s\S]*?(?:```|~~~)/g,
    numberedLine: /^ {0,3}(?:(?:\*\*|__)\s*)?(\d{1,2})(?:\.\s+|[)）、．]\s*)(.+)$/gm,
    explicitSchemeLine: /^ {0,3}(?:(?:\*\*|__)\s*)?(?:#{1,6}\s*)?(?:方案|选项|蓝图)\s*([一二三四五六七八九十]|\d{1,2}|[A-Ha-h])(?:(?:\s*(?:[：:、.)）．-]|—+)\s*)|\s+|(?=[《【「]))(.+)$/gm,
    emphasizedHeading: /^(?:\*\*|__)?(.+?)(?:\*\*|__)(?=\s|[：:，,。]|$)/,
    markdownImage: /!\[([^\]]*)\]\([^)]*\)/g,
    markdownLink: /\[([^\]]+)\]\([^)]*\)/g,
    markdownDecoration: /[*_`~#]/g,
    headingSeparator: /[：:]/,
  }),
  ordinals: Object.freeze({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8 } as Record<string, number>),
});

export type QuickChoiceConfig = typeof quickChoiceConfig;
