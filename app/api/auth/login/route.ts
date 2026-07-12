import {
  DASHBOARD_COOKIE,
  createDashboardSession,
  dashboardCookieOptions,
  isGateConfigured,
  verifyDashboardPassword,
} from "@/lib/auth/gate";
import { NextResponse } from "next/server";

type AttemptWindow = { count: number; resetAt: number };

const attempts = new Map<string, AttemptWindow>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_BYTES = 4_096;

function clientKey(request: Request) {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function isRateLimited(key: string) {
  const now = Date.now();
  const current = attempts.get(key);

  if (!current || current.resetAt <= now) {
    if (attempts.size > 5_000) {
      for (const [attemptKey, window] of attempts) {
        if (window.resetAt <= now) attempts.delete(attemptKey);
      }
    }
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  current.count += 1;
  return current.count > MAX_ATTEMPTS;
}

function redirectToLogin(request: Request, reason: string) {
  return NextResponse.redirect(new URL(`/login?error=${reason}`, request.url), 303);
}

async function readLimitedBody(request: Request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_LOGIN_BYTES) {
      await reader.cancel();
      throw new Error("Request too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_LOGIN_BYTES) {
    return new NextResponse("Request too large", { status: 413 });
  }

  if (!isGateConfigured()) {
    return redirectToLogin(request, "configuration");
  }

  const key = clientKey(request);
  if (isRateLimited(key)) {
    return redirectToLogin(request, "rate-limit");
  }

  const contentType = request.headers.get("content-type") ?? "";
  let password = "";
  try {
    const body = await readLimitedBody(request);
    if (contentType.includes("application/json")) {
      password = String((JSON.parse(body) as { password?: unknown }).password ?? "");
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      password = new URLSearchParams(body).get("password") ?? "";
    } else {
      return redirectToLogin(request, "invalid");
    }
  } catch {
    return redirectToLogin(request, "invalid");
  }

  if (!verifyDashboardPassword(password)) {
    return redirectToLogin(request, "invalid");
  }

  attempts.delete(key);
  const response = NextResponse.redirect(new URL("/", request.url), 303);
  response.cookies.set(
    DASHBOARD_COOKIE,
    createDashboardSession(),
    dashboardCookieOptions,
  );
  return response;
}
