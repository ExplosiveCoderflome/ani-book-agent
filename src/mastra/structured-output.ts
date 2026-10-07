import { z } from "zod";

type StructuredGenerationMode = "native" | "json-text";
type StructuredGenerationResult = { object?: unknown; text?: string };

type GenerateStructuredOutputOptions<T extends z.ZodType> = {
  schema: T;
  label: string;
  prompt: string;
  generate: (prompt: string, mode: StructuredGenerationMode) => Promise<StructuredGenerationResult>;
};

export function structuredOutputOptions<T extends z.ZodType>(schema: T) {
  return { toolChoice: "none" as const, structuredOutput: { schema } };
}

export function requireStructuredOutput<T extends z.ZodType>(schema: T, value: unknown, label: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`模型未返回有效的${label}结构化数据，请检查模型响应格式后重试。`, { cause: parsed.error });
}

export function jsonObject(text: string | undefined) {
  const value = text?.trim();
  if (!value) return undefined;
  const candidates = [
    value,
    ...[...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]!.trim()),
  ];
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(value.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* 尝试下一个候选片段 */ }
  }
  return undefined;
}

function errorMessages(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || seen.has(error)) return [];
  seen.add(error);
  if (error instanceof AggregateError) return [error.message, ...error.errors.flatMap((item) => errorMessages(item, seen))];
  if (error instanceof Error) return [error.message, ...errorMessages(error.cause, seen)];
  return [String(error)];
}

export function isNativeStructuredOutputUnsupported(error: unknown) {
  return errorMessages(error).some((message) => /(?:structured output|response[_ -]?format|json[_ -]?schema).*(?:not supported|unsupported)|(?:not supported|unsupported).*(?:structured output|response[_ -]?format|json[_ -]?schema)/i.test(message));
}

function jsonTextPrompt<T extends z.ZodType>(prompt: string, schema: T, label: string) {
  return `${prompt}\n\n## JSON 结构化输出\n请只输出一个符合下列 JSON Schema 的 ${label} JSON 对象，不要输出 Markdown 代码围栏、解释、思考过程或对象以外的文字。\n${JSON.stringify(z.toJSONSchema(schema))}`;
}

export async function generateStructuredOutput<T extends z.ZodType>({ schema, label, prompt, generate }: GenerateStructuredOutputOptions<T>): Promise<z.output<T>> {
  const generated = await generate(jsonTextPrompt(prompt, schema, label), "json-text");
  return requireStructuredOutput(schema, generated.object ?? jsonObject(generated.text), label);
}
