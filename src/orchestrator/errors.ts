export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export const badRequest = (m: string) => new HttpError(400, m);
export const notFound = (m: string) => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);
