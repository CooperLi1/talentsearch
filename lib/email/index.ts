import "server-only"

export { getResendClient } from "@/lib/email/resend"
export { renderWeeklyDigest } from "@/lib/email/render-weekly-digest"
export {
  sendWeeklyDigest,
  weeklyDigestIdempotencyKey,
} from "@/lib/email/send-weekly-digest"
export type {
  DigestCandidate,
  DigestConfidence,
  DigestDeliveryError,
  DigestEvent,
  DigestRecipient,
  DigestSection,
  DigestSource,
  FailedDigestBatch,
  SentDigestBatch,
  WeeklyDigestDeliveryResult,
  WeeklyDigestEmailProps,
  WeeklyDigestInput,
} from "@/lib/email/types"
