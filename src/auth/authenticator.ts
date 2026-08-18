import type { IncomingHttpHeaders } from "node:http";

import { OrchestratorError } from "../domain/errors.js";
import type { TenantContext } from "../domain/types.js";

export interface Authenticator {
  authenticate(headers: IncomingHttpHeaders): Promise<TenantContext>;
}

export class DevelopmentAuthenticator implements Authenticator {
  public constructor(environment: string) {
    if (environment !== "development" && environment !== "test") {
      throw new Error("DevelopmentAuthenticator is forbidden outside development/test");
    }
  }

  public async authenticate(headers: IncomingHttpHeaders): Promise<TenantContext> {
    const value = headers.authorization;
    if (!value?.startsWith("Bearer dev:")) {
      throw new OrchestratorError("AUTH_REQUIRED", "development bearer token required", 401);
    }

    const [tenantId, subject, extra] = value.slice("Bearer dev:".length).split(":");
    if (extra !== undefined || !isSafeIdentifier(tenantId) || !isSafeIdentifier(subject)) {
      throw new OrchestratorError("AUTH_INVALID", "invalid development bearer token", 401);
    }
    return { tenantId, subject };
  }
}

function isSafeIdentifier(value: string | undefined): value is string {
  return Boolean(value && /^[a-z0-9][a-z0-9_-]{1,62}$/i.test(value));
}
