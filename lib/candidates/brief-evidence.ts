import type { TalentEvent } from "@/lib/domain/types";

/**
 * Keep model-written event copy out of later grounding prompts whenever the
 * connector's extracted page text is available.
 */
export function briefEvidenceDescription(
  event: Pick<TalentEvent, "evidenceExcerpt" | "summaryMarkdown">,
) {
  return event.evidenceExcerpt || event.summaryMarkdown;
}
