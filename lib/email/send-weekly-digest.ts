import "server-only"

import { createHash } from "node:crypto"
import { createElement } from "react"
import type { CreateBatchOptions, ErrorResponse } from "resend"

import WeeklyDigestEmail from "@/emails/weekly-digest"
import { getResendClient } from "@/lib/email/resend"
import type {
  DigestDeliveryError,
  DigestRecipient,
  FailedDigestBatch,
  SentDigestBatch,
  WeeklyDigestDeliveryResult,
  WeeklyDigestInput,
} from "@/lib/email/types"

const RESEND_BATCH_LIMIT = 100
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function toDeliveryError(error: ErrorResponse): DigestDeliveryError {
  return {
    name: error.name,
    message: error.message,
    statusCode: error.statusCode,
  }
}

function toUnknownDeliveryError(error: unknown): DigestDeliveryError {
  return {
    name: "unexpected_delivery_error",
    message: error instanceof Error ? error.message : "Unknown email delivery failure",
    statusCode: null,
  }
}

function inputError(message: string): DigestDeliveryError {
  return {
    name: "invalid_digest_input",
    message,
    statusCode: null,
  }
}

function normalizeRecipients(recipients: DigestRecipient[]) {
  const unique = new Map<string, DigestRecipient>()
  const invalidIndexes: number[] = []

  recipients.forEach((recipient, index) => {
    const email = recipient.email.trim()
    if (!EMAIL_PATTERN.test(email)) {
      invalidIndexes.push(index)
      return
    }

    const key = email.toLocaleLowerCase("en-US")
    const normalized = {
      email: key,
      name: recipient.name?.trim() || undefined,
    }
    const existing = unique.get(key)
    if (
      !existing ||
      (!existing.name && normalized.name) ||
      (existing.name &&
        normalized.name &&
        normalized.name.localeCompare(existing.name, "en-US") < 0)
    ) {
      unique.set(key, normalized)
    }
  })

  return {
    invalidIndexes,
    recipients: [...unique.values()].sort((left, right) =>
      left.email.localeCompare(right.email, "en-US", { sensitivity: "base" }),
    ),
  }
}

function chunkRecipients(recipients: DigestRecipient[]) {
  const chunks: DigestRecipient[][] = []

  for (let index = 0; index < recipients.length; index += RESEND_BATCH_LIMIT) {
    chunks.push(recipients.slice(index, index + RESEND_BATCH_LIMIT))
  }

  return chunks
}

function digestFingerprint(digestId: string) {
  return createHash("sha256").update(digestId).digest("hex").slice(0, 24)
}

export function weeklyDigestIdempotencyKey(digestId: string, batchIndex: number) {
  return `unfound/weekly/${digestFingerprint(digestId)}/batch-${batchIndex}`
}

function formatSubjectDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 32)

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date)
}

function buildSubject(input: WeeklyDigestInput) {
  const requestedSubject = input.subject?.trim()
  if (requestedSubject) {
    const safeSubject = requestedSubject
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160)
    if (safeSubject) return safeSubject
  }

  return `Unfound: ${input.candidates.length} signals for ${formatSubjectDate(input.periodEnd)}`
}

function buildDashboardUrl(input: WeeklyDigestInput) {
  const configuredUrl = input.dashboardUrl?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (!configuredUrl) return null

  try {
    const url = new URL(configuredUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") return null

    if (!input.dashboardUrl) {
      url.pathname = "/"
      url.search = ""
      url.hash = ""
    }

    return url.toString()
  } catch {
    return null
  }
}

function safeTagValue(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 256) || "weekly"
}

function deliveryBase(
  input: WeeklyDigestInput,
  recipientCount: number,
  subject: string,
) {
  return {
    digestId: input.digestId,
    subject,
    recipientCount,
    candidateCount: input.candidates.length,
  }
}

export async function sendWeeklyDigest(
  input: WeeklyDigestInput,
): Promise<WeeklyDigestDeliveryResult> {
  const subject = buildSubject(input)
  const { recipients, invalidIndexes } = normalizeRecipients(input.recipients)
  const base = deliveryBase(input, recipients.length, subject)

  if (!input.digestId.trim()) {
    return {
      ...base,
      status: "failed",
      error: inputError("digestId is required"),
      batches: [],
    }
  }

  if (invalidIndexes.length > 0) {
    return {
      ...base,
      status: "failed",
      error: inputError(
        `${invalidIndexes.length} recipient address${invalidIndexes.length === 1 ? " is" : "es are"} invalid`,
      ),
      batches: [],
    }
  }

  if (recipients.length === 0) {
    return { ...base, status: "skipped", reason: "no-recipients" }
  }

  if (input.candidates.length === 0) {
    return { ...base, status: "skipped", reason: "no-candidates" }
  }

  if (input.preview) {
    return { ...base, status: "preview", reason: "preview-requested" }
  }

  if (process.env.EMAIL_DELIVERY_MODE !== "send") {
    return { ...base, status: "preview", reason: "delivery-disabled" }
  }

  const resend = getResendClient()
  if (!resend) {
    return {
      ...base,
      status: "failed",
      error: inputError("A valid RESEND_API_KEY is required in send mode"),
      batches: [],
    }
  }

  const from = process.env.RESEND_FROM?.trim()
  const dashboardUrl = buildDashboardUrl(input)
  const replyTo = process.env.RESEND_REPLY_TO?.trim() || undefined
  if (
    !from ||
    /[\r\n]/.test(from) ||
    !dashboardUrl ||
    (replyTo !== undefined && (!EMAIL_PATTERN.test(replyTo) || /[\r\n]/.test(replyTo)))
  ) {
    return {
      ...base,
      status: "failed",
      error: inputError(
        "A safe RESEND_FROM, optional RESEND_REPLY_TO, and valid application URL (HTTPS in production) are required in send mode",
      ),
      batches: [],
    }
  }

  const digestTag = safeTagValue(input.digestId)
  const digestDeliveryKey = input.idempotencyKey?.trim() || input.digestId
  const batches: Array<SentDigestBatch | FailedDigestBatch> = []

  for (const [batchIndex, recipientBatch] of chunkRecipients(recipients).entries()) {
    const idempotencyKey = weeklyDigestIdempotencyKey(digestDeliveryKey, batchIndex)
    const payload: CreateBatchOptions = recipientBatch.map((recipient) => ({
      from,
      to: [recipient.email],
      subject,
      replyTo,
      react: createElement(WeeklyDigestEmail, {
        digestId: input.digestId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        recipientName: recipient.name,
        candidates: input.candidates,
        dashboardUrl,
      }),
      tags: [
        { name: "message_type", value: "weekly-digest" },
        { name: "digest_id", value: digestTag },
      ],
    }))

    try {
      const response = await resend.batch.send(payload, { idempotencyKey })

      if (response.error) {
        batches.push({
          status: "failed",
          batchIndex,
          idempotencyKey,
          recipientCount: recipientBatch.length,
          error: toDeliveryError(response.error),
        })
      } else {
        batches.push({
          status: "sent",
          batchIndex,
          idempotencyKey,
          recipientCount: recipientBatch.length,
          emailIds: response.data.data.map((email) => email.id),
        })
      }
    } catch (error) {
      batches.push({
        status: "failed",
        batchIndex,
        idempotencyKey,
        recipientCount: recipientBatch.length,
        error: toUnknownDeliveryError(error),
      })
    }
  }

  const failedBatch = batches.find(
    (batch): batch is FailedDigestBatch => batch.status === "failed",
  )

  if (failedBatch) {
    return {
      ...base,
      status: "failed",
      error: failedBatch.error,
      batches,
    }
  }

  return {
    ...base,
    status: "sent",
    batches: batches as SentDigestBatch[],
  }
}
