import {
  DASHBOARD_COOKIE,
  dashboardCookieOptions,
} from "@/lib/auth/gate";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.cookies.set(DASHBOARD_COOKIE, "", {
    ...dashboardCookieOptions,
    maxAge: 0,
  });
  return response;
}
