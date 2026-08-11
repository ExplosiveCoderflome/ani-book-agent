import { z } from "zod";

export function structuredOutputOptions<T extends z.ZodType>(schema: T) {
  return { toolChoice: "none" as const, structuredOutput: { schema } };
}

export function requireStructuredOutput<T extends z.ZodType>(schema: T, value: unknown, label: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`模型未返回有效的${label}结构化数据，请检查模型响应格式后重试。`, { cause: parsed.error });
}
