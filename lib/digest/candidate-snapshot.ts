export function digestCandidateSnapshotCopy(input: {
  name: string;
  headline: string;
  summary: string;
  facts: Array<{ text: string }>;
}) {
  const factTexts = input.facts
    .map((fact) => fact.text.trim())
    .filter(Boolean);
  const name = input.name.trim();
  const headline = input.headline.trim() || factTexts[0] || name || "Candidate profile";
  const summary = input.summary.trim() || factTexts.join("\n");

  return { headline, summary };
}
