import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const DASHBOARD_COOKIE = "unfound_session";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const DEVELOPMENT_PASSWORD = "signal";
const DEVELOPMENT_SECRET = "local-development-only-unfound-secret";

type SessionPayload = {
  exp: number;
  iat: number;
  version: 1;
};

export class DashboardAuthError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "DashboardAuthError";
  }
}

function getDashboardPassword() {
  const configured = process.env.DASHBOARD_PASSWORD;
  if (configured && (process.env.NODE_ENV === "development" || configured.length >= 12)) {
    return configured;
  }
  if (process.env.NODE_ENV === "development") return DEVELOPMENT_PASSWORD;
  return null;
}

function getSessionSecret() {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "development") return DEVELOPMENT_SECRET;
  return null;
}

function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function isGateConfigured() {
  return Boolean(getDashboardPassword() && getSessionSecret());
}

export function verifyDashboardPassword(password: string) {
  const expected = getDashboardPassword();
  if (!expected) return false;
  const submittedDigest = createHash("sha256").update(password).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(submittedDigest, expectedDigest);
}

export function createDashboardSession() {
  const secret = getSessionSecret();
  if (!secret) throw new DashboardAuthError("Dashboard gate is not configured");

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    exp: issuedAt + SESSION_TTL_SECONDS,
    iat: issuedAt,
    version: 1,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");

  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyDashboardSession(token: string | undefined | null) {
  const secret = getSessionSecret();
  if (!token || !secret) return false;

  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra || !safeEqual(signature, sign(encoded, secret))) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>;

    return (
      payload.version === 1 &&
      typeof payload.exp === "number" &&
      typeof payload.iat === "number" &&
      payload.exp > Math.floor(Date.now() / 1000) &&
      payload.iat <= Math.floor(Date.now() / 1000) + 30
    );
  } catch {
    return false;
  }
}

function getCookieFromRequest(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader
    .split(";")
    .map((entry) => entry.trim().split("="))
    .find(([name]) => name === DASHBOARD_COOKIE);

  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(1).join("="));
  } catch {
    return null;
  }
}

export async function hasDashboardSession() {
  const cookieStore = await cookies();
  return verifyDashboardSession(cookieStore.get(DASHBOARD_COOKIE)?.value);
}

export async function requireDashboardSession() {
  if (!(await hasDashboardSession())) redirect("/login");
}

export function isDashboardRequestAuthorized(request: Request) {
  return verifyDashboardSession(getCookieFromRequest(request));
}

export function assertDashboardRequest(request: Request) {
  if (!isDashboardRequestAuthorized(request)) throw new DashboardAuthError();
}

export const dashboardCookieOptions = {
  httpOnly: true,
  maxAge: SESSION_TTL_SECONDS,
  path: "/",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};
