export {};

const baseUrl = process.env.OPERATIONAL_TEST_URL?.trim() || "http://localhost:3001";
const configuredPassword = process.env.DASHBOARD_PASSWORD?.trim();
if (!configuredPassword) throw new Error("DASHBOARD_PASSWORD is required");
const password: string = configuredPassword;
const requestedBatches = Number(process.env.REVIEW_BATCHES ?? 1);
const batches = Number.isFinite(requestedBatches)
  ? Math.min(10, Math.max(1, Math.floor(requestedBatches)))
  : 1;

async function main() {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: baseUrl,
      "x-real-ip": "127.0.0.91",
    },
    body: new URLSearchParams({ password }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (login.status !== 303 || !cookie) throw new Error("Dashboard login failed");

  for (let index = 0; index < batches; index += 1) {
    const response = await fetch(`${baseUrl}/api/discovery/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: baseUrl },
      body: JSON.stringify({ sourceKinds: [], eventLimit: 1 }),
      signal: AbortSignal.timeout(290_000),
    });
    const payload = await response.text();
    if (!response.ok) throw new Error(`Review batch ${index + 1} failed (${response.status}): ${payload.slice(0, 300)}`);
    console.log(`Review batch ${index + 1}/${batches} completed`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Review backlog failed");
  process.exitCode = 1;
});
