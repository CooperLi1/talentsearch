import type { CSSProperties } from "react"
import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components"

import type {
  DigestCandidate,
  DigestConfidence,
  WeeklyDigestEmailProps,
} from "@/lib/email/types"

const colors = {
  ink: "#151512",
  paper: "#F1EEE6",
  card: "#FCFBF7",
  line: "#D4CFC3",
  acid: "#DDFB53",
  muted: "#6F6C63",
  blue: "#3459F5",
  white: "#FFFFFF",
}

const fontSans =
  "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
const fontMono =
  "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace"

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined

  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

function formatDate(value: string, options?: Intl.DateTimeFormatOptions) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
    ...options,
  }).format(date)
}

function confidenceLabel(confidence: DigestConfidence) {
  return `${confidence.slice(0, 1).toUpperCase()}${confidence.slice(1)} identity confidence`
}

function candidateInitials(name: string) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("")

  return initials || "TR"
}

function CandidateCard({
  candidate,
}: {
  candidate: DigestCandidate
}) {
  const profileUrl = safeHttpUrl(candidate.profileUrl)
  const sources = candidate.sources
    .map((source) => ({ ...source, url: safeHttpUrl(source.url) }))
    .filter((source): source is typeof source & { url: string } => Boolean(source.url))
  const primarySource = sources.at(0)

  return (
    <Section className="candidate-card" style={candidateCard}>
      <Row>
        <Column style={identityColumn}>
          <Text style={initials}>{candidateInitials(candidate.name)}</Text>
        </Column>
        <Column style={candidateHeadingColumn}>
          <Heading as="h2" style={candidateName}>
            {candidate.name}
          </Heading>
          <Text style={candidateHeadline}>{candidate.headline}</Text>
        </Column>
      </Row>

      <Row>
        <Column>
          <Text style={metadata}>
            {[candidate.location, confidenceLabel(candidate.confidence)]
              .filter(Boolean)
              .join("  /  ")}
          </Text>
        </Column>
      </Row>

      {candidate.newEvent ? (
        <Section style={eventPanel}>
          <Text style={eventEyebrow}>New signal</Text>
          <Text style={eventTitle}>{candidate.newEvent.title}</Text>
          {candidate.newEvent.summary ? (
            <Text style={eventSummary}>{candidate.newEvent.summary}</Text>
          ) : null}
          {candidate.newEvent.occurredAt ? (
            <Text style={eventDate}>
              {formatDate(candidate.newEvent.occurredAt)}
            </Text>
          ) : null}
          {primarySource ? (
            <Link href={primarySource.url} style={eventSourceLink}>
              Verify at {primarySource.label}
            </Link>
          ) : null}
        </Section>
      ) : null}

      {candidate.confidence !== "high" ? (
        <Text style={identityCaution}>
          Confirm that the linked records belong to the same person before contact.
        </Text>
      ) : null}

      <Text style={summary}>{candidate.summary}</Text>

      <Section style={reasonPanel}>
        <Text style={reasonLabel}>Why now</Text>
        <Text style={reasonText}>{candidate.whyNow}</Text>
        <Hr style={reasonDivider} />
        <Text style={reasonLabel}>Why still early</Text>
        <Text style={reasonText}>{candidate.earlyness}</Text>
      </Section>

      {sources.length ? (
        <Section style={sourcesPanel}>
          <Text style={sourcesLabel}>Evidence</Text>
          {sources.slice(0, 6).map((source, sourceIndex) => (
            <span key={`${source.url}-${sourceIndex}`}>
              {sourceIndex > 0 ? <span style={sourceSeparator}> / </span> : null}
              <Link href={source.url} style={sourceLink}>
                {source.label}
              </Link>
            </span>
          ))}
        </Section>
      ) : null}

      {profileUrl ? (
        <Button href={profileUrl} style={profileButton}>
          Open candidate dossier
        </Button>
      ) : null}
    </Section>
  )
}

export function WeeklyDigestEmail({
  periodStart,
  periodEnd,
  recipientName,
  candidates,
  dashboardUrl,
}: WeeklyDigestEmailProps) {
  const safeDashboardUrl = safeHttpUrl(dashboardUrl)
  const previewText = candidates.length
    ? `${candidates.length} candidates ready for review, with source links.`
    : "No candidates are waiting for review."
  const dateRange = `${formatDate(periodStart, {
    year: undefined,
  })} to ${formatDate(periodEnd)}`

  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        <style>{responsiveStyles}</style>
      </Head>
      <Preview>{previewText}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Section style={masthead}>
            <Row>
              <Column>
                <Text style={wordmark}>UNFOUND</Text>
              </Column>
              <Column align="right">
                <Text style={issueDate}>{dateRange}</Text>
              </Column>
            </Row>
            <Hr style={mastheadRule} />
            <Heading as="h1" style={heroHeading} className="hero-heading">
              Candidates for this week&apos;s review.
            </Heading>
            <Text style={heroCopy}>
              {recipientName ? `${recipientName}, this week's` : "This week's"} brief covers
              new work from research, open-source projects, competitions, and trusted networks.
            </Text>
          </Section>

          <Section style={editorialIntro}>
            <Text style={editorialKicker}>Before you decide</Text>
            <Text style={editorialCopy}>
              Open the linked evidence and confirm identity before making contact.
            </Text>
          </Section>

          {candidates.length ? (
            candidates.map((candidate) => (
              <CandidateCard key={candidate.id} candidate={candidate} />
            ))
          ) : (
            <Section style={emptyDigest}>
              <Heading as="h2" style={emptyDigestHeading}>Nothing to review this week.</Heading>
              <Text style={emptyDigestCopy}>No candidate crossed the current review criteria.</Text>
            </Section>
          )}

          {safeDashboardUrl ? (
            <Section style={actionPanel}>
              <Text style={actionKicker}>Review actions</Text>
              <Heading as="h2" style={actionHeading}>
                Shortlist, watch, pass, or correct a record.
              </Heading>
              <Text style={actionCopy}>
                Save a decision after checking the linked evidence.
              </Text>
              <Button href={safeDashboardUrl} style={dashboardButton}>
                Open the review queue
              </Button>
            </Section>
          ) : null}

          <Section style={footer}>
            <Text style={footerBrand}>UNFOUND</Text>
            <Text style={footerTagline}>Internal candidate brief.</Text>
            <Text style={footerText}>
              Built from public sources. Verify identity and context before outreach,
              especially when a candidate may be under 18.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const responsiveStyles = `
  @media only screen and (max-width: 620px) {
    .hero-heading { font-size: 42px !important; line-height: 43px !important; }
    .candidate-card { padding-left: 22px !important; padding-right: 22px !important; }
  }
`

const body: CSSProperties = {
  margin: 0,
  padding: "24px 0",
  backgroundColor: colors.paper,
  color: colors.ink,
  fontFamily: fontSans,
}

const container: CSSProperties = {
  width: "100%",
  maxWidth: "600px",
  margin: "0 auto",
}

const masthead: CSSProperties = {
  padding: "38px 36px 46px",
  backgroundColor: colors.ink,
  color: colors.white,
  borderRadius: "2px 2px 0 0",
}

const wordmark: CSSProperties = {
  margin: 0,
  color: colors.white,
  fontFamily: fontMono,
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "1.1px",
}

const issueDate: CSSProperties = {
  margin: 0,
  color: "#B6B3AA",
  fontFamily: fontMono,
  fontSize: "10px",
  lineHeight: "16px",
}

const mastheadRule: CSSProperties = {
  margin: "28px 0 34px",
  borderColor: "#3F3F39",
}

const heroHeading: CSSProperties = {
  maxWidth: "540px",
  margin: 0,
  color: colors.white,
  fontSize: "54px",
  fontWeight: 500,
  letterSpacing: "-2.7px",
  lineHeight: "54px",
}

const heroCopy: CSSProperties = {
  maxWidth: "470px",
  margin: "26px 0 0",
  color: "#CBC8BF",
  fontSize: "16px",
  lineHeight: "25px",
}

const editorialIntro: CSSProperties = {
  padding: "44px 36px 30px",
}

const editorialKicker: CSSProperties = {
  margin: "0 0 12px",
  color: colors.blue,
  fontFamily: fontMono,
  fontSize: "10px",
  fontWeight: 700,
  letterSpacing: "0.8px",
  textTransform: "uppercase",
}

const editorialCopy: CSSProperties = {
  margin: 0,
  color: colors.ink,
  fontSize: "20px",
  letterSpacing: "-0.4px",
  lineHeight: "30px",
}

const candidateCard: CSSProperties = {
  margin: "18px 0",
  padding: "30px 30px 32px",
  backgroundColor: colors.card,
  border: `1px solid ${colors.line}`,
  borderRadius: "2px",
}

const identityColumn: CSSProperties = {
  width: "52px",
  verticalAlign: "top",
}

const initials: CSSProperties = {
  width: "42px",
  height: "42px",
  margin: 0,
  border: `1px solid ${colors.ink}`,
  borderRadius: "50%",
  color: colors.ink,
  fontFamily: fontMono,
  fontSize: "11px",
  fontWeight: 700,
  lineHeight: "42px",
  textAlign: "center",
}

const candidateHeadingColumn: CSSProperties = {
  padding: "0 10px",
  verticalAlign: "top",
}

const candidateName: CSSProperties = {
  margin: 0,
  color: colors.ink,
  fontSize: "25px",
  fontWeight: 600,
  letterSpacing: "-0.8px",
  lineHeight: "29px",
}

const candidateHeadline: CSSProperties = {
  margin: "5px 0 0",
  color: colors.muted,
  fontSize: "13px",
  lineHeight: "19px",
}

const metadata: CSSProperties = {
  margin: "18px 0 0",
  color: colors.muted,
  fontFamily: fontMono,
  fontSize: "9px",
  letterSpacing: "0.3px",
  lineHeight: "15px",
  textTransform: "uppercase",
}

const eventPanel: CSSProperties = {
  margin: "22px 0 0",
  padding: "18px 20px",
  backgroundColor: colors.acid,
}

const eventEyebrow: CSSProperties = {
  margin: "0 0 6px",
  color: colors.ink,
  fontFamily: fontMono,
  fontSize: "9px",
  fontWeight: 700,
  letterSpacing: "0.7px",
  textTransform: "uppercase",
}

const eventTitle: CSSProperties = {
  margin: 0,
  color: colors.ink,
  fontSize: "17px",
  fontWeight: 650,
  letterSpacing: "-0.25px",
  lineHeight: "23px",
}

const eventSummary: CSSProperties = {
  margin: "8px 0 0",
  color: "#36372D",
  fontSize: "13px",
  lineHeight: "20px",
}

const eventDate: CSSProperties = {
  margin: "10px 0 0",
  color: "#535541",
  fontFamily: fontMono,
  fontSize: "9px",
  lineHeight: "14px",
}

const eventSourceLink: CSSProperties = {
  display: "inline-block",
  marginTop: "9px",
  color: colors.ink,
  fontSize: "11px",
  fontWeight: 700,
  textDecoration: "underline",
  textUnderlineOffset: "2px",
}

const identityCaution: CSSProperties = {
  margin: "18px 0 0",
  padding: "12px 14px",
  backgroundColor: "#FFF3C4",
  borderLeft: `3px solid ${colors.ink}`,
  color: colors.ink,
  fontSize: "12px",
  lineHeight: "18px",
}

const summary: CSSProperties = {
  margin: "24px 0 0",
  color: colors.ink,
  fontSize: "15px",
  lineHeight: "24px",
}

const reasonPanel: CSSProperties = {
  margin: "24px 0 0",
  padding: "20px",
  backgroundColor: "#EAE7DE",
}

const reasonLabel: CSSProperties = {
  margin: 0,
  color: colors.muted,
  fontFamily: fontMono,
  fontSize: "9px",
  fontWeight: 700,
  letterSpacing: "0.7px",
  textTransform: "uppercase",
}

const reasonText: CSSProperties = {
  margin: "7px 0 0",
  color: colors.ink,
  fontSize: "13px",
  lineHeight: "20px",
}

const reasonDivider: CSSProperties = {
  margin: "17px 0",
  borderColor: "#CECAC0",
}

const sourcesPanel: CSSProperties = {
  margin: "22px 0 0",
  paddingTop: "16px",
  borderTop: `1px solid ${colors.line}`,
}

const sourcesLabel: CSSProperties = {
  margin: "0 0 8px",
  color: colors.muted,
  fontFamily: fontMono,
  fontSize: "9px",
  fontWeight: 700,
  letterSpacing: "0.7px",
  textTransform: "uppercase",
}

const sourceLink: CSSProperties = {
  color: colors.blue,
  fontSize: "11px",
  fontWeight: 650,
  lineHeight: "18px",
  textDecoration: "underline",
  textUnderlineOffset: "2px",
}

const sourceSeparator: CSSProperties = {
  color: "#A5A197",
  fontSize: "11px",
}

const profileButton: CSSProperties = {
  marginTop: "24px",
  padding: "12px 17px",
  backgroundColor: colors.ink,
  borderRadius: "1px",
  color: colors.white,
  fontSize: "11px",
  fontWeight: 700,
  textDecoration: "none",
}

const actionPanel: CSSProperties = {
  margin: "48px 0 0",
  padding: "44px 36px 46px",
  backgroundColor: colors.blue,
  color: colors.white,
}

const actionKicker: CSSProperties = {
  margin: "0 0 13px",
  color: "#C7D0FF",
  fontFamily: fontMono,
  fontSize: "9px",
  fontWeight: 700,
  letterSpacing: "0.8px",
  textTransform: "uppercase",
}

const actionHeading: CSSProperties = {
  margin: 0,
  color: colors.white,
  fontSize: "32px",
  fontWeight: 550,
  letterSpacing: "-1.2px",
  lineHeight: "35px",
}

const actionCopy: CSSProperties = {
  margin: "18px 0 0",
  color: "#DCE1FF",
  fontSize: "14px",
  lineHeight: "22px",
}

const dashboardButton: CSSProperties = {
  marginTop: "26px",
  padding: "14px 19px",
  backgroundColor: colors.white,
  borderRadius: "1px",
  color: colors.ink,
  fontSize: "12px",
  fontWeight: 750,
  textDecoration: "none",
}

const footer: CSSProperties = {
  padding: "32px 36px 12px",
}

const footerBrand: CSSProperties = {
  margin: 0,
  color: colors.ink,
  fontFamily: fontMono,
  fontSize: "10px",
  fontWeight: 700,
  letterSpacing: "0.8px",
}

const footerText: CSSProperties = {
  margin: "12px 0 0",
  color: colors.muted,
  fontSize: "10px",
  lineHeight: "16px",
}

const footerTagline: CSSProperties = {
  margin: "7px 0 0",
  color: colors.ink,
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "-0.15px",
  lineHeight: "18px",
}

const emptyDigest: CSSProperties = {
  margin: "18px 0 42px",
  padding: "34px 30px",
  backgroundColor: colors.card,
  border: `1px solid ${colors.line}`,
}

const emptyDigestHeading: CSSProperties = {
  margin: 0,
  color: colors.ink,
  fontSize: "24px",
  lineHeight: "30px",
}

const emptyDigestCopy: CSSProperties = {
  margin: "8px 0 0",
  color: colors.muted,
  fontSize: "13px",
  lineHeight: "20px",
}

WeeklyDigestEmail.PreviewProps = {
  digestId: "preview",
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-01-08T00:00:00.000Z",
  dashboardUrl: "http://localhost:3000/",
  candidates: [],
} satisfies WeeklyDigestEmailProps

export default WeeklyDigestEmail
