// An API error with its HTTP status (and extra fields for the JSON body). The routes in
// index.ts turn it into the response; the request handlers throw it.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
