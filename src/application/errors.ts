export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly recoverable = true,
    public readonly fieldErrors?: Record<string, string[]>,
    public readonly nextAction?: "retry" | "reread" | "author_approval" | "replan",
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
