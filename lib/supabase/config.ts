export interface BrowserSupabaseConfig {
  url: string;
  publishableKey: string;
}

export function getBrowserSupabaseConfig(): BrowserSupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url?.trim() || !publishableKey?.trim()) return null;
  return { url: url.trim(), publishableKey: publishableKey.trim() };
}

export function hasSupabasePublicEnv(): boolean {
  return getBrowserSupabaseConfig() !== null;
}
