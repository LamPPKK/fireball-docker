import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import type { Authenticator } from "./auth/authenticator.js";
import { OrchestratorError } from "./domain/errors.js";
import { SessionService } from "./domain/session-service.js";
import { SignalingGateway } from "./signaling/signaling-gateway.js";

export interface AppDependencies {
  readonly authenticator: Authenticator;
  readonly sessions: SessionService;
  readonly logger?: boolean;
  readonly signaling?: SignalingGateway;
  readonly signalingAllowedOrigins?: ReadonlySet<string>;
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: dependencies.logger ?? false, bodyLimit: 16 * 1024 });
  app.register(fastifyWebsocket, {
    errorHandler: (_error, socket) => socket.terminate(),
    options: { maxPayload: 64 * 1024, perMessageDeflate: false },
  });

  const signaling = dependencies.signaling;
  const allowedOrigins = dependencies.signalingAllowedOrigins;
  if (signaling && (!allowedOrigins || allowedOrigins.size === 0)) {
    throw new Error("signaling origin allowlist is required");
  }

  app.register(async (routes) => {
    routes.get("/healthz", async (_request, reply) => reply.code(204).send());

    routes.post("/orchestrator/v1/sessions", async (request, reply) => {
      const context = await dependencies.authenticator.authenticate(request.headers);
      const result = await dependencies.sessions.create(context);
      return reply.code(201).send(result);
    });

    routes.post<{ Body: { ticket: string } }>(
      "/orchestrator/v1/signaling/tickets/exchange",
      { schema: { body: signalingTicketSchema } },
      async (request) => dependencies.sessions.exchangeSignalingTicket(request.body.ticket),
    );

    if (signaling && allowedOrigins) {
      routes.get(
        "/orchestrator/v1/signaling",
        {
          websocket: true,
          preValidation: async (request, reply) => {
            const origin = request.headers.origin;
            if (typeof origin !== "string" || !allowedOrigins.has(origin)) {
              return reply.code(403).send();
            }
          },
        },
        (socket) => signaling.handle(socket),
      );
    }

    routes.get<{ Params: { id: string } }>(
      "/orchestrator/v1/sessions/:id",
      { schema: { params: sessionIdSchema } },
      async (request) => {
        const context = await dependencies.authenticator.authenticate(request.headers);
        return { session: dependencies.sessions.get(context, request.params.id) };
      },
    );

    routes.post<{ Params: { id: string } }>(
      "/orchestrator/v1/sessions/:id/signaling/tickets",
      { schema: { params: sessionIdSchema } },
      async (request, reply) => {
        const context = await dependencies.authenticator.authenticate(request.headers);
        const ticket = dependencies.sessions.issueSignalingTicket(context, request.params.id);
        return reply.code(201).send(ticket);
      },
    );

    routes.delete<{ Params: { id: string } }>(
      "/orchestrator/v1/sessions/:id",
      { schema: { params: sessionIdSchema } },
      async (request, reply) => {
        const context = await dependencies.authenticator.authenticate(request.headers);
        await dependencies.sessions.burn(context, request.params.id);
        return reply.code(204).send();
      },
    );
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof OrchestratorError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if (isValidationError(error)) {
      return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "request validation failed" } });
    }
    app.log.error(error);
    return reply.code(500).send({ error: { code: "RUNTIME_FAILURE", message: "internal orchestrator failure" } });
  });

  return app;
}

const sessionIdSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

const signalingTicketSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ticket"],
  properties: {
    ticket: { type: "string", minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]+$" },
  },
} as const;

function isValidationError(error: unknown): error is Error & { validation: unknown } {
  return error instanceof Error && "validation" in error;
}
