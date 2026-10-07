import { quickChoiceConfig } from "./quick-choice-config";

export type QuickChoice = { number: number; label: string };

function choiceLabel(value: string) {
  const { patterns } = quickChoiceConfig;
  const emphasized = value.match(patterns.emphasizedHeading)?.[1];
  const clean = (emphasized ?? value)
    .replace(patterns.markdownImage, "$1")
    .replace(patterns.markdownLink, "$1")
    .replace(patterns.markdownDecoration, "")
    .trim();
  const heading = clean.split(patterns.headingSeparator, 1)[0]?.trim();
  const label = heading && heading.length >= quickChoiceConfig.minimumHeadingLength && heading.length <= quickChoiceConfig.maximumHeadingLength ? heading : clean;
  return label.length > quickChoiceConfig.maximumLabelLength ? `${label.slice(0, quickChoiceConfig.maximumLabelLength - 1)}…` : label;
}

type ChoiceMarker = QuickChoice & { index: number };

function bestSequential(markers: ChoiceMarker[]) {
  let group: typeof markers = [];
  let best: typeof markers = [];
  for (const marker of markers) {
    if (marker.number === 1) group = [marker];
    else if (group.length && marker.number === group.at(-1)!.number + 1) group.push(marker);
    else group = [];
    if (group.length > best.length) best = [...group];
  }
  return best;
}

function ordinal(value: string) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : quickChoiceConfig.ordinals[value.toUpperCase()];
}

function choices(markers: ChoiceMarker[], minimum: number): QuickChoice[] {
  const best = bestSequential(markers);
  return best.length >= minimum ? best.slice(0, quickChoiceConfig.maximumChoices).map(({ number, label }) => ({ number, label })) : [];
}

export function quickChoices(markdown: string): QuickChoice[] {
  const visible = markdown.replace(quickChoiceConfig.patterns.fencedCode, "");
  const explicit = [...visible.matchAll(quickChoiceConfig.patterns.explicitSchemeLine)].flatMap((match) => {
    const number = ordinal(match[1]!);
    return number ? [{ number, label: choiceLabel(match[2]!), index: match.index ?? 0 }] : [];
  });
  const explicitChoices = choices(explicit, quickChoiceConfig.minimumExplicitChoices);
  if (explicitChoices.length) return explicitChoices;
  const numbered = [...visible.matchAll(quickChoiceConfig.patterns.numberedLine)].map((match) => ({ number: Number(match[1]), label: choiceLabel(match[2]!), index: match.index ?? 0 }));
  return choices(numbered, quickChoiceConfig.minimumSequentialChoices);
}
