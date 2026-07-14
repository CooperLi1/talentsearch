import assert from "node:assert/strict";
import test from "node:test";

import { digestScheduleWindow } from "../lib/digest/schedule";

test("selected delivery days send only in the configured quarter-hour window", () => {
  const monday = digestScheduleWindow(new Date("2026-07-13T15:34:00Z"), [1, 4], 15, 30, 3);
  const tuesday = digestScheduleWindow(new Date("2026-07-14T15:34:00Z"), [1, 4], 15, 30, 3);
  assert.equal(monday.phase, "send");
  assert.equal(monday.periodEnd, "2026-07-13T15:30:00.000Z");
  assert.equal(tuesday.phase, "idle");
});

test("the dispatcher prepares the exact send cohort three hours early", () => {
  const preparation = digestScheduleWindow(new Date("2026-07-13T12:31:00Z"), [1], 15, 30, 3);
  assert.equal(preparation.phase, "prepare");
  assert.equal(preparation.periodEnd, "2026-07-13T15:30:00.000Z");
  assert.equal(preparation.dedupeKey, "digest:2026-07-13T15:30:00.000Z");
});

test("prepare and send phases share one durable digest key", () => {
  const preparation = digestScheduleWindow(new Date("2026-07-13T12:30:00Z"), [1], 15, 30, 3);
  const delivery = digestScheduleWindow(new Date("2026-07-13T15:30:00Z"), [1], 15, 30, 3);
  assert.equal(preparation.dedupeKey, delivery.dedupeKey);
  assert.equal(preparation.periodStart, delivery.periodStart);
});

test("period start follows the prior selected send day", () => {
  const thursday = digestScheduleWindow(new Date("2026-07-16T15:00:00Z"), [1, 4], 15, 0, 3);
  assert.equal(thursday.periodStart, "2026-07-13T15:00:00.000Z");
});

test("invalid or duplicate day settings normalize safely", () => {
  const window = digestScheduleWindow(new Date("2026-07-13T15:00:00Z"), [1, 1, -1, 8], 99, 7, 0);
  assert.deepEqual(window.daysOfWeek, [1]);
  assert.equal(window.deliveryHourUtc, 23);
  assert.equal(window.deliveryMinuteUtc, 0);
  assert.equal(window.preparationLeadHours, 1);
});

test("hourly Hobby dispatchers catch up after Vercel timing jitter", () => {
  const delayedSend = digestScheduleWindow(
    new Date("2026-07-13T16:42:00Z"),
    [1],
    15,
    30,
    3,
    120,
  );
  const delayedPreparation = digestScheduleWindow(
    new Date("2026-07-13T13:41:00Z"),
    [1],
    15,
    30,
    3,
    120,
  );
  assert.equal(delayedSend.phase, "send");
  assert.equal(delayedSend.periodEnd, "2026-07-13T15:30:00.000Z");
  assert.equal(delayedPreparation.phase, "prepare");
  assert.equal(delayedPreparation.periodEnd, "2026-07-13T15:30:00.000Z");
});

test("a delayed dispatcher can deliver the prior day's late send", () => {
  const window = digestScheduleWindow(
    new Date("2026-07-14T00:47:00Z"),
    [1],
    23,
    45,
    3,
    120,
  );
  assert.equal(window.phase, "send");
  assert.equal(window.periodEnd, "2026-07-13T23:45:00.000Z");
});
