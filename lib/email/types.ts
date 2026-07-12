export type DigestConfidence = "high" | "medium" | "low"
export type DigestSection =
  | "top_discoveries"
  | "fast_movers"
  | "network_edge"
  | "wildcard"
  | "watchlist_update"

export interface DigestSource {
  label: string
  url: string
  publishedAt?: string
}

export interface DigestEvent {
  title: string
  summary?: string
  occurredAt?: string
}

export interface DigestCandidate {
  id: string
  name: string
  headline: string
  summary: string
  whyNow: string
  earlyness: string
  confidence: DigestConfidence
  section?: DigestSection
  sources: DigestSource[]
  score?: number
  location?: string
  profileUrl?: string
  newEvent?: DigestEvent
  highlights?: string[]
  connections?: string[]
}

export interface DigestRecipient {
  email: string
  name?: string
}

export interface WeeklyDigestInput {
  digestId: string
  idempotencyKey?: string
  periodStart: string
  periodEnd: string
  recipients: DigestRecipient[]
  candidates: DigestCandidate[]
  dashboardUrl?: string
  subject?: string
  preview?: boolean
}

export interface SentDigestBatch {
  status: "sent"
  batchIndex: number
  idempotencyKey: string
  recipientCount: number
  emailIds: string[]
}

export interface FailedDigestBatch {
  status: "failed"
  batchIndex: number
  idempotencyKey: string
  recipientCount: number
  error: DigestDeliveryError
}

export interface DigestDeliveryError {
  name: string
  message: string
  statusCode: number | null
}

interface DigestDeliveryBase {
  digestId: string
  subject: string
  recipientCount: number
  candidateCount: number
}

export type WeeklyDigestDeliveryResult =
  | (DigestDeliveryBase & {
      status: "sent"
      batches: SentDigestBatch[]
    })
  | (DigestDeliveryBase & {
      status: "preview"
      reason: "preview-requested" | "delivery-disabled" | "missing-api-key"
    })
  | (DigestDeliveryBase & {
      status: "skipped"
      reason: "no-recipients" | "no-candidates"
    })
  | (DigestDeliveryBase & {
      status: "failed"
      error: DigestDeliveryError
      batches: Array<SentDigestBatch | FailedDigestBatch>
    })

export interface WeeklyDigestEmailProps {
  digestId: string
  periodStart: string
  periodEnd: string
  recipientName?: string
  candidates: DigestCandidate[]
  dashboardUrl: string
}
