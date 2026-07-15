import assert from "node:assert/strict";

const baseUrl = process.env.OPERATIONAL_TEST_URL?.trim() || "http://localhost:3001";
const configuredPassword = process.env.DASHBOARD_PASSWORD?.trim();
if (!configuredPassword) throw new Error("DASHBOARD_PASSWORD is required");
const password: string = configuredPassword;
const absentSourceId = 2_147_483_647;
const expectedQueueMinimum = Number(process.env.EXPECTED_QUEUE_MINIMUM ?? 0);

async function main() {
  const unauthorized = await fetch(`${baseUrl}/api/sources`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ id: absentSourceId, enabled: false }),
  });
  assert.equal(unauthorized.status, 401, "source mutation must require a dashboard session");

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: baseUrl,
      "x-real-ip": "127.0.0.77",
    },
    body: new URLSearchParams({ password }),
  });
  assert.equal(login.status, 303, "valid dashboard login should redirect");
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie?.startsWith("unfound_session="), "login must set the protected session cookie");
  if (!cookie) throw new Error("Dashboard login did not return a session cookie");

  const limiterProbe = `operational-${Date.now()}`;
  let limitedLocation = "";
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const invalidLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: baseUrl,
        "x-real-ip": limiterProbe,
      },
      body: new URLSearchParams({ password: "invalid-operational-probe" }),
    });
    assert.equal(invalidLogin.status, 303);
    if (attempt === 9) limitedLocation = invalidLogin.headers.get("location") ?? "";
  }
  assert.match(limitedLocation, /error=rate-limit/u, "login must enforce the shared request limit");

  const crossOrigin = await fetch(`${baseUrl}/api/sources`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "https://example.invalid",
    },
    body: JSON.stringify({ id: absentSourceId, enabled: false }),
  });
  assert.equal(crossOrigin.status, 403, "cross-origin mutations must be rejected");

  const schemaReadiness = await fetch(`${baseUrl}/api/sources`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie, origin: baseUrl },
    body: JSON.stringify({ id: absentSourceId, enabled: false }),
  });
  assert.ok(
    [404, 503].includes(schemaReadiness.status),
    `source mutation returned unexpected status ${schemaReadiness.status}`,
  );
  if (schemaReadiness.status === 503) {
    const payload = (await schemaReadiness.json()) as { readiness?: string };
    assert.equal(payload.readiness, "unconfigured");
  }

  const home = await fetch(`${baseUrl}/`, { headers: { cookie } });
  assert.equal(home.status, 200, "dashboard should render even before schema setup");
  const html = await home.text();
  assert.match(html, /Candidate queue|Setup required/u);
  const queueCount = Number(html.match(/(\d+) people/u)?.[1] ?? 0);
  if (Number.isFinite(expectedQueueMinimum) && expectedQueueMinimum > 0) {
    assert.ok(
      queueCount >= expectedQueueMinimum,
      `candidate queue contains ${queueCount}; expected at least ${expectedQueueMinimum}`,
    );
  }

  console.log(
    JSON.stringify({
      auth: "passed",
      csrf: "passed",
      dashboard: "passed",
      queueCount,
      rateLimit: "passed",
      sourceMutation: schemaReadiness.status,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Operational verification failed");
  process.exitCode = 1;
});
