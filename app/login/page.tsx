import { hasDashboardSession, isGateConfigured } from "@/lib/auth/gate";
import { BrandMark } from "@/components/brand-mark";
import { ArrowRight, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

const errorMessages: Record<string, string> = {
  configuration:
    "This workspace is not ready for sign-in. Ask an administrator to finish setup.",
  invalid: "That password did not match. Check it and try again.",
  "rate-limit": "Too many attempts. Wait ten minutes before trying again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await hasDashboardSession()) redirect("/");

  const { error } = await searchParams;
  const configured = isGateConfigured();

  return (
    <main className="login-page">
      <div className="login-art" aria-hidden="true">
        <div className="login-orbit login-orbit-large" />
        <div className="login-orbit login-orbit-small" />
        <span className="login-node login-node-one" />
        <span className="login-node login-node-two" />
        <span className="login-node login-node-three" />
        <p className="login-art-copy">Private candidate review</p>
      </div>

      <section className="login-panel">
        <Link className="brand-lockup" href="/login" aria-label="Unfound">
          <span className="brand-mark"><BrandMark /></span>
          <span>Unfound</span>
        </Link>

        <div className="login-form-wrap">
          <div className="login-lock">
            <LockKeyhole aria-hidden="true" />
          </div>
          <p className="eyebrow">Private workspace</p>
          <h1>Enter your password.</h1>
          <p className="login-intro">
            Review candidates and the public evidence behind each record.
          </p>

          {error ? (
            <p className="form-error" role="alert">
              {errorMessages[error] ?? errorMessages.invalid}
            </p>
          ) : null}

          <form className="login-form" action="/api/auth/login" method="post">
            <label htmlFor="password">Workspace password</label>
            <div className="password-field">
              <input
                autoComplete="current-password"
                disabled={!configured}
                id="password"
                maxLength={512}
                name="password"
                placeholder="Enter password"
                required
                type="password"
              />
              <button disabled={!configured} type="submit" aria-label="Unlock dashboard">
                <ArrowRight aria-hidden="true" />
              </button>
            </div>
          </form>

          <p className="login-footnote">
            Candidate information is for internal evaluation only.
          </p>
        </div>
      </section>
    </main>
  );
}
