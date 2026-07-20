import test from "node:test";
import assert from "node:assert/strict";
import {
  availableRanges,
  dayPresentation,
  isDatasetCurrent,
  isDayCoverageComplete
} from "../site/availability-policy.mjs";

function completeDay(slots = []) {
  return {
    scan_status: "success",
    coverage_complete: true,
    negative_result_confirmed: slots.length === 0,
    checked_slot_count: 4,
    total_slot_count: 4,
    slots
  };
}

test("overlapping 30-minute probes are merged into one continuous range", () => {
  const ranges = availableRanges(completeDay([
    { start: "10:00", end: "10:30", state: "reservable" },
    { start: "10:15", end: "10:45", state: "reservable" },
    { start: "10:30", end: "11:00", state: "reservable" }
  ]));
  assert.deepEqual(ranges, [{ start: "10:00", end: "11:00" }]);
});

test("gaps remain separate and every range is displayed", () => {
  const day = completeDay([
    { start: "10:00", end: "10:30", state: "reservable" },
    { start: "11:00", end: "12:30", state: "reservable" },
    { start: "14:00", end: "14:30", state: "reservable" }
  ]);
  assert.equal(
    dayPresentation(day).summary,
    "10:00〜10:30 / 11:00〜12:30 / 14:00〜14:30"
  );
});

test("an incomplete scan can never become a no-vacancy presentation", () => {
  const day = {
    scan_status: "partial",
    coverage_complete: false,
    negative_result_confirmed: false,
    checked_slot_count: 3,
    total_slot_count: 4,
    slots: []
  };
  const presentation = dayPresentation(day);
  assert.equal(isDayCoverageComplete(day), false);
  assert.equal(presentation.status, "確認途中");
  assert.doesNotMatch(presentation.status, /空き.*なし|ありません/);
});

test("even a complete zero-result scan uses a non-categorical official-check label", () => {
  const presentation = dayPresentation(completeDay([]));
  assert.equal(presentation.status, "空き枠未検出・公式確認");
  assert.doesNotMatch(presentation.status, /空き.*なし|ありません/);
});

test("legacy success data without coverage proof is never treated as complete", () => {
  const day = {
    scan_status: "success",
    checked_slot_count: 27,
    total_slot_count: 27,
    slots: []
  };
  assert.equal(isDayCoverageComplete(day), false);
  assert.equal(dayPresentation(day).status, "確認不完全・公式確認");
});

test("a stale or failed dataset suppresses zero-result claims", () => {
  const now = new Date("2026-07-20T12:00:00+09:00");
  const stale = { generated_at: "2026-07-19T09:30:00+09:00", scan: { status: "success" } };
  assert.equal(isDatasetCurrent(stale, now), false);
  assert.equal(dayPresentation(completeDay([]), { datasetCurrent: false }).status, "本日の取得待ち");
});

test("today's successful dataset is current", () => {
  const now = new Date("2026-07-20T12:00:00+09:00");
  const data = { generated_at: "2026-07-20T09:30:00+09:00", scan: { status: "success" } };
  assert.equal(isDatasetCurrent(data, now), true);
});

test("an elapsed same-day window is explicit and never presented as no availability", () => {
  const day = {
    scan_status: "expired",
    coverage_complete: true,
    negative_result_confirmed: false,
    checked_slot_count: 0,
    total_slot_count: 0,
    slots: []
  };
  const presentation = dayPresentation(day);
  assert.equal(presentation.status, "本日の対象時間終了");
  assert.doesNotMatch(presentation.status, /空き.*なし|ありません/);
});
