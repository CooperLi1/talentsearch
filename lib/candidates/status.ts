export const CANDIDATE_STATUS_LABELS: Record<string, string> = {
  archived: "Archived",
  contacted: "Contacted",
  fellow: "Accepted",
  interviewing: "Interviewing",
  new: "New",
  passed: "Passed",
  saved: "Shortlisted",
  watching: "Watching",
};

export function candidateStatusLabel(status: string) {
  return CANDIDATE_STATUS_LABELS[status] ?? status;
}
