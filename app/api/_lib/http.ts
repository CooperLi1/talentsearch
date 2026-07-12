import { timingSafeEqual } from "node:crypto";

import { DashboardAuthError, assertDashboardRequest } from "@/lib/auth/gate";
import { ZodError, type ZodType } from "zod";

const MAX_JSON_BYTES = 128_000;

export function getWorkspaceId() {
  return (
    process.env.UNFOUND_WORKSPACE_ID?.trim() ||
    process.env.TALENT_RADAR_WORKSPACE_ID?.trim() ||
    process.env.TALENT_WORKSPACE_ID?.trim() ||
    "1"
  );
}

export function assertCronRequest(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization?.startsWith("Bearer ")) {
    throw new DashboardAuthError("Unauthorized cron request");
  }
  const supplied = authorization.slice("Bearer ".length);
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    throw new DashboardAuthError("Unauthorized cron request");
  }
}

export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_JSON_BYTES) throw new ApiError(413, "Request body is too large");
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) {
    throw new ApiError(413, "Request body is too large");
  }
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "Request body must be valid JSON");
  }
  return schema.parse(value);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiErrorResponse(error: unknown) {
  if (error instanceof DashboardAuthError) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (error instanceof ZodError) {
    return Response.json(
      {
        error: "Invalid request",
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
      { status: 400 },
    );
  }
  if (error instanceof ApiError) {
    return Response.json(
      { error: error.message, ...(error.details ? { details: error.details } : {}) },
      { status: error.status },
    );
  }
  if (error instanceof Error && error.name === "DataNotConfiguredError") {
    return Response.json(
      { error: "Data storage is not configured", readiness: "unconfigured" },
      { status: 503 },
    );
  }
  console.error("API route failed", error);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}

export function withDashboard(
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    assertDashboardRequest(request);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const origin = request.headers.get("origin");
      if (origin && origin !== new URL(request.url).origin) {
        throw new ApiError(403, "Cross-origin mutation rejected");
      }
    }
    return handler().catch((error) => apiErrorResponse(error));
  } catch (error) {
    return Promise.resolve(apiErrorResponse(error));
  }
}
