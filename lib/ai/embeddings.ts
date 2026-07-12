import { openai } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";

import type { DiscoveryEvent, PersonObservation } from "@/lib/discovery/types";
import { sanitizePlainText } from "@/lib/discovery/security";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

function embeddingModel() {
  return openai.embedding(process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL);
}

export function embeddingsAvailable() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function buildCandidateEmbeddingText(input: {
  person: PersonObservation;
  events: DiscoveryEvent[];
  summary?: string;
}) {
  const { person, events, summary } = input;
  return sanitizePlainText(
    [
      `Name: ${person.displayName}`,
      person.headline ? `Headline: ${person.headline}` : "",
      person.biography ? `Biography: ${person.biography}` : "",
      person.location ? `Location: ${person.location}` : "",
      person.affiliations?.length ? `Affiliations: ${person.affiliations.join(", ")}` : "",
      summary ? `Research summary: ${summary}` : "",
      ...events.slice(0, 30).map(
        (event) =>
          `${event.type.replaceAll("_", " ")}: ${event.title}. ${event.description ?? ""} Tags: ${(event.tags ?? []).join(", ")}`,
      ),
    ]
      .filter(Boolean)
      .join("\n"),
    24_000,
  );
}

export async function embedQuery(value: string): Promise<number[] | null> {
  if (!embeddingsAvailable()) return null;
  const clean = sanitizePlainText(value, 8_000);
  if (!clean) return null;
  const { embedding } = await embed({
    model: embeddingModel(),
    value: clean,
    maxRetries: 2,
    abortSignal: AbortSignal.timeout(20_000),
  });
  return embedding;
}

export async function embedCandidateTexts(values: string[]): Promise<Array<number[] | null>> {
  if (!values.length) return [];
  if (!embeddingsAvailable()) return values.map(() => null);
  const cleaned = values.map((value) => sanitizePlainText(value, 24_000));
  const output: Array<number[] | null> = [];
  for (let index = 0; index < cleaned.length; index += 64) {
    const batch = cleaned.slice(index, index + 64);
    const { embeddings } = await embedMany({
      model: embeddingModel(),
      values: batch,
      maxParallelCalls: 2,
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(45_000),
    });
    output.push(...embeddings);
  }
  return output;
}
