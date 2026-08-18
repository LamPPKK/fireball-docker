import type { IncomingHttpHeaders } from "node:http";

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

import { OrchestratorError } from "../domain/errors.js";
import type { TenantContext } from "../domain/types.js";
import type { Authenticator } from "./authenticator.js";

const DEFAULT_ALGORITHMS = ["RS256", "PS256", "ES256"] as const;

export interface OidcAuthenticatorOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly tenantClaim?: string;
  readonly algorithms?: readonly string[];
  readonly clockToleranceSeconds?: number;
}

export class OidcAuthenticator implements Authenticator {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly tenantClaim: string;
  private readonly algorithms: string[];
  private readonly clockToleranceSeconds: number;
  private readonly keyResolver: JWTVerifyGetKey;

  public constructor(options: OidcAuthenticatorOptions, keyResolver?: JWTVerifyGetKey) {
    requireHttpsURL(options.issuer, "OIDC issuer");
    this.issuer = options.issuer;
    this.audience = requireNonEmpty(options.audience, "OIDC audience");
    this.tenantClaim = requireClaimName(options.tenantClaim ?? "tenant_id");
    this.algorithms = validateAlgorithms(options.algorithms ?? DEFAULT_ALGORITHMS);
    this.clockToleranceSeconds = nonNegativeInteger(options.clockToleranceSeconds ?? 5, "clock tolerance");
    const jwksURL = requireHttpsURL(options.jwksUrl, "OIDC JWKS URL");
    this.keyResolver = keyResolver ?? createRemoteJWKSet(jwksURL, {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }

  public async authenticate(headers: IncomingHttpHeaders): Promise<TenantContext> {
    const token = bearerToken(headers.authorization);
    try {
      const { payload } = await jwtVerify(token, this.keyResolver, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: this.algorithms,
        requiredClaims: ["sub", this.tenantClaim],
        clockTolerance: this.clockToleranceSeconds,
      });
      const tenantId = payload[this.tenantClaim];
      if (!isSafeTenantId(tenantId) || !isSafeSubject(payload.sub)) throw invalidToken();
      return { tenantId, subject: payload.sub };
    } catch (error) {
      if (error instanceof OrchestratorError) throw error;
      throw invalidToken();
    }
  }
}

function bearerToken(authorization: string | undefined): string {
  if (!authorization) {
    throw new OrchestratorError("AUTH_REQUIRED", "bearer token required", 401);
  }
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  if (!match?.[1]) throw invalidToken();
  return match[1];
}

function isSafeTenantId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{1,62}$/i.test(value);
}

function isSafeSubject(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function invalidToken(): OrchestratorError {
  return new OrchestratorError("AUTH_INVALID", "bearer token is invalid", 401);
}

function requireHttpsURL(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  return url;
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) throw new Error(`${name} must be non-empty`);
  return normalized;
}

function requireClaimName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error("OIDC tenant claim is invalid");
  return value;
}

function validateAlgorithms(values: readonly string[]): string[] {
  const allowed = new Set(DEFAULT_ALGORITHMS);
  if (values.length === 0 || values.some((value) => !allowed.has(value as (typeof DEFAULT_ALGORITHMS)[number]))) {
    throw new Error("OIDC algorithms must be a non-empty subset of RS256, PS256, and ES256");
  }
  return [...new Set(values)];
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
