import "server-only"

import { Resend } from "resend"

let cachedClient: Resend | null = null
let cachedApiKey: string | null = null

/**
 * Build-safe Resend access. Importing this module never reads or validates a
 * secret, which keeps Next.js builds and local preview mode operational.
 */
export function getResendClient(apiKey = process.env.RESEND_API_KEY?.trim()) {
  if (!apiKey || !apiKey.startsWith("re_")) return null

  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedClient = new Resend(apiKey)
    cachedApiKey = apiKey
  }

  return cachedClient
}
