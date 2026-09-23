/** Application errors carry the HTTP status the transport should use. */
export class AppError extends Error {
  readonly status: number;
  readonly fields: Record<string, string> | undefined;

  constructor(status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.fields = fields;
  }
}

export const badRequest = (message: string, fields?: Record<string, string>): AppError =>
  new AppError(400, message, fields);
export const unauthorized = (message = "Sign in to continue"): AppError =>
  new AppError(401, message);
export const forbidden = (message = "Not allowed"): AppError => new AppError(403, message);
export const notFound = (message = "Not found"): AppError => new AppError(404, message);
export const conflict = (message: string): AppError => new AppError(409, message);
export const tooMany = (message: string): AppError => new AppError(429, message);
