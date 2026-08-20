import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TEMPLATE_URL = new URL("../deploy/nginx/fireball.conf.template", import.meta.url);

export function renderNginxConfig(environment, template = readFileSync(TEMPLATE_URL, "utf8")) {
  const publicHost = validatePublicHost(required(environment, "FIREBALL_PUBLIC_HOST"));
  const certificate = validateAbsolutePath(required(environment, "FIREBALL_TLS_CERTIFICATE"), "certificate");
  const certificateKey = validateAbsolutePath(
    required(environment, "FIREBALL_TLS_CERTIFICATE_KEY"),
    "certificate key",
  );
  if (certificate === certificateKey) throw new Error("TLS certificate and key paths must differ");
  const upstreamPort = validatePort(environment.FIREBALL_UPSTREAM_PORT ?? "8787");
  const replacements = new Map([
    ["{{PUBLIC_HOST}}", publicHost],
    ["{{TLS_CERTIFICATE}}", certificate],
    ["{{TLS_CERTIFICATE_KEY}}", certificateKey],
    ["{{UPSTREAM_PORT}}", upstreamPort],
  ]);
  let result = template;
  for (const [token, value] of replacements) result = result.replaceAll(token, value);
  if (/\{\{[A-Z_]+\}\}/.test(result)) throw new Error("nginx template contains an unresolved token");
  return result;
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validatePublicHost(value) {
  if (
    value.length > 253
    || value !== value.toLowerCase()
    || !value.includes(".")
    || !value.split(".").every((label) => (
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    ))
  ) {
    throw new Error("FIREBALL_PUBLIC_HOST must be a lowercase DNS hostname");
  }
  return value;
}

function validateAbsolutePath(value, label) {
  if (
    value.length > 4_096
    || !value.startsWith("/")
    || !/^\/[A-Za-z0-9._/-]+$/.test(value)
    || value.split("/").includes("..")
  ) {
    throw new Error(`TLS ${label} path is unsafe`);
  }
  return value;
}

function validatePort(value) {
  if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new Error("FIREBALL_UPSTREAM_PORT must be a TCP port");
  const port = Number(value);
  if (port > 65_535) throw new Error("FIREBALL_UPSTREAM_PORT must be a TCP port");
  return String(port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(renderNginxConfig(process.env));
  } catch (error) {
    process.stderr.write(`fireball nginx config: ${error.message}\n`);
    process.exitCode = 1;
  }
}
