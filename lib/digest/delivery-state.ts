import type { DigestStatus } from "@/lib/data/contracts";
import type { WeeklyDigestDeliveryResult } from "@/lib/email/types";

export function digestStatusAfterDelivery(
  delivery: WeeklyDigestDeliveryResult,
): Extract<DigestStatus, "ready" | "sent" | "failed" | "cancelled"> {
  switch (delivery.status) {
    case "sent":
      return "sent";
    case "failed":
      return "failed";
    case "skipped":
      return "cancelled";
    case "preview":
      return "ready";
  }
}
