const DAY_MS = 24 * 60 * 60 * 1_000;
const DISPATCH_INTERVAL_MINUTES = 15;

export type DigestDispatchPhase = "idle" | "prepare" | "send";

function normalizeDays(days: number[]) {
  const normalized = [...new Set(days)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((left, right) => left - right);
  return normalized.length ? normalized : [1];
}

function normalizedTime(hour: number, minute: number) {
  return {
    hour: Math.min(23, Math.max(0, Math.trunc(hour))),
    minute: [0, 15, 30, 45].includes(Math.trunc(minute)) ? Math.trunc(minute) : 0,
  };
}

function inDispatchBucket(date: Date, hour: number, minute: number) {
  return date.getUTCHours() === hour &&
    Math.floor(date.getUTCMinutes() / DISPATCH_INTERVAL_MINUTES) * DISPATCH_INTERVAL_MINUTES === minute;
}

function scheduledSendForPhase(
  now: Date,
  days: number[],
  hour: number,
  minute: number,
  leadHours: number,
) {
  if (days.includes(now.getUTCDay()) && inDispatchBucket(now, hour, minute)) {
    return {
      phase: "send" as const,
      scheduledFor: new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        hour,
        minute,
      )),
    };
  }

  const preparationTarget = new Date(now.getTime() + leadHours * 60 * 60 * 1_000);
  if (
    days.includes(preparationTarget.getUTCDay()) &&
    inDispatchBucket(preparationTarget, hour, minute)
  ) {
    return {
      phase: "prepare" as const,
      scheduledFor: new Date(Date.UTC(
        preparationTarget.getUTCFullYear(),
        preparationTarget.getUTCMonth(),
        preparationTarget.getUTCDate(),
        hour,
        minute,
      )),
    };
  }

  return { phase: "idle" as const, scheduledFor: null };
}

function previousScheduledSend(scheduledFor: Date, days: number[], hour: number, minute: number) {
  for (let daysBack = 1; daysBack <= 7; daysBack += 1) {
    const candidate = new Date(scheduledFor.getTime() - daysBack * DAY_MS);
    if (days.includes(candidate.getUTCDay())) {
      return new Date(Date.UTC(
        candidate.getUTCFullYear(),
        candidate.getUTCMonth(),
        candidate.getUTCDate(),
        hour,
        minute,
      ));
    }
  }
  return new Date(scheduledFor.getTime() - 7 * DAY_MS);
}

export function digestScheduleWindow(
  now: Date,
  daysOfWeek: number[] = [1],
  deliveryHourUtc = 15,
  deliveryMinuteUtc = 0,
  preparationLeadHours = 3,
) {
  const days = normalizeDays(daysOfWeek);
  const { hour, minute } = normalizedTime(deliveryHourUtc, deliveryMinuteUtc);
  const leadHours = Math.min(12, Math.max(1, Math.trunc(preparationLeadHours)));
  const dispatch = scheduledSendForPhase(now, days, hour, minute, leadHours);

  if (!dispatch.scheduledFor) {
    return {
      daysOfWeek: days,
      deliveryHourUtc: hour,
      deliveryMinuteUtc: minute,
      preparationLeadHours: leadHours,
      phase: "idle" as const,
      due: false,
      dedupeKey: null,
      periodStart: null,
      periodEnd: null,
    };
  }

  const periodEnd = dispatch.scheduledFor.toISOString();
  return {
    daysOfWeek: days,
    deliveryHourUtc: hour,
    deliveryMinuteUtc: minute,
    preparationLeadHours: leadHours,
    phase: dispatch.phase as DigestDispatchPhase,
    due: true,
    dedupeKey: `digest:${periodEnd}`,
    periodStart: previousScheduledSend(dispatch.scheduledFor, days, hour, minute).toISOString(),
    periodEnd,
  };
}
