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

function scheduledSendOnDay(now: Date, dayOffset: number, hour: number, minute: number) {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + dayOffset,
    hour,
    minute,
  ));
}

function isInsideDispatchWindow(now: Date, windowStart: Date, dispatchWindowMinutes: number) {
  const elapsed = now.getTime() - windowStart.getTime();
  return elapsed >= 0 && elapsed < dispatchWindowMinutes * 60 * 1_000;
}

function scheduledSendForPhase(
  now: Date,
  days: number[],
  hour: number,
  minute: number,
  leadHours: number,
  dispatchWindowMinutes: number,
) {
  for (const dayOffset of [0, -1]) {
    const scheduledFor = scheduledSendOnDay(now, dayOffset, hour, minute);
    if (
      days.includes(scheduledFor.getUTCDay()) &&
      isInsideDispatchWindow(now, scheduledFor, dispatchWindowMinutes)
    ) {
      return { phase: "send" as const, scheduledFor };
    }
  }

  for (const dayOffset of [0, 1]) {
    const scheduledFor = scheduledSendOnDay(now, dayOffset, hour, minute);
    const preparationStartsAt = new Date(
      scheduledFor.getTime() - leadHours * 60 * 60 * 1_000,
    );
    if (
      days.includes(scheduledFor.getUTCDay()) &&
      isInsideDispatchWindow(now, preparationStartsAt, dispatchWindowMinutes)
    ) {
      return { phase: "prepare" as const, scheduledFor };
    }
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
  dispatchWindowMinutes = DISPATCH_INTERVAL_MINUTES,
) {
  const days = normalizeDays(daysOfWeek);
  const { hour, minute } = normalizedTime(deliveryHourUtc, deliveryMinuteUtc);
  const leadHours = Math.min(12, Math.max(1, Math.trunc(preparationLeadHours)));
  const windowMinutes = Math.min(180, Math.max(
    DISPATCH_INTERVAL_MINUTES,
    Math.trunc(dispatchWindowMinutes),
  ));
  const dispatch = scheduledSendForPhase(now, days, hour, minute, leadHours, windowMinutes);

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
