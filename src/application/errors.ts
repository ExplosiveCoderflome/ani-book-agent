import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly recoverable = true,
    public readonly fieldErrors?: Record<string, string[]>,
    public readonly nextAction?:
      | "retry"
      | "reread"
      | "author_approval"
      | "replan",
  ) {
    super(message);
  }
}

export function errorBody(error: unknown) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          recoverable: error.recoverable,
          ...(error.nextAction ? { nextAction: error.nextAction } : {}),
          ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        },
      },
    };
  }

  if (error instanceof ZodError) {
    const first = error.issues[0];
    const field = first?.path[0];
    return {
      status: 400,
      body: {
        error: {
          code: "INVALID_INPUT",
          message: first?.message ?? "请求参数不正确。",
          recoverable: true,
          ...(typeof field === "string"
            ? {
                fieldErrors: {
                  [field]: error.issues
                    .filter((issue) => issue.path[0] === field)
                    .map((issue) => issue.message),
                },
              }
            : {}),
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "操作没有完成，请稍后重试。",
        recoverable: true,
      },
    },
  };
}
