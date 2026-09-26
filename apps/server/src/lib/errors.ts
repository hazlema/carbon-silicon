export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500;

/** An error with an HTTP status and a stable UPPER_SNAKE code; the HTTP door renders it as {error:{code,message}}. */
export class AppError extends Error {
  constructor(
    public readonly status: ErrorStatus,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const unauthorized = (code: string, message: string) => new AppError(401, code, message);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const notFound = (code: string, message: string) => new AppError(404, code, message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooMany = (code: string, message: string) => new AppError(429, code, message);

/** Postgres unique_violation (23505), looking through Drizzle's error wrapping. */
export function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    if ((cur as { code?: unknown }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
