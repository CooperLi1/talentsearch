import "server-only"

import { createElement } from "react"
import { render } from "@react-email/components"

import WeeklyDigestEmail from "@/emails/weekly-digest"
import type { WeeklyDigestEmailProps } from "@/lib/email/types"

/** Render a local/admin preview without invoking Resend. Keep its caller gated. */
export async function renderWeeklyDigest(props: WeeklyDigestEmailProps) {
  const element = createElement(WeeklyDigestEmail, props)

  const [html, text] = await Promise.all([
    render(element, { pretty: true }),
    render(element, { plainText: true }),
  ])

  return { html, text }
}
