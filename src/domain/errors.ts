export type ErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "SESSION_NOT_FOUND"
  | "SESSION_LIMIT_REACHED"
  | "SIGNALING_CREDENTIAL_INVALID"
  | "SIGNALING_UNAVAILABLE"
  | "RUNTIME_FAILURE"
  | "VALIDATION_FAILED";

export class OrchestratorError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}
