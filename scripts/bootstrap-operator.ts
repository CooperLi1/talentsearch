import { createClient } from "@supabase/supabase-js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

async function main() {
  const url = process.env.SUPABASE_URL?.trim() || required("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const email = required("INITIAL_DIGEST_SUBSCRIBER_EMAIL").toLocaleLowerCase("en-US");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 320) {
    throw new Error("INITIAL_DIGEST_SUBSCRIBER_EMAIL is invalid");
  }

  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });

  const workspace = await client
    .from("workspaces")
    .select("id")
    .eq("slug", "unfound")
    .maybeSingle();

  if (workspace.error) {
    if (
      workspace.error.code === "PGRST205" ||
      /schema cache|could not find the table/i.test(workspace.error.message)
    ) {
      throw new Error("Supabase migrations must be applied before operator setup");
    }
    throw new Error(workspace.error.message);
  }
  if (!workspace.data) {
    throw new Error("The unfound workspace is missing; apply the bootstrap migration");
  }

  const existing = await client
    .from("digest_subscribers")
    .select("id")
    .eq("workspace_id", workspace.data.id)
    .ilike("email", email)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  const mutation = existing.data
    ? await client
        .from("digest_subscribers")
        .update({ status: "active" })
        .eq("workspace_id", workspace.data.id)
        .eq("id", existing.data.id)
    : await client.from("digest_subscribers").insert({
        workspace_id: workspace.data.id,
        email,
        status: "active",
      });

  if (mutation.error) throw new Error(mutation.error.message);
  console.log(`Digest subscriber ready: ${maskEmail(email)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Operator setup failed");
  process.exitCode = 1;
});
