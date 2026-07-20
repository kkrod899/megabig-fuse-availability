export function availableSlots(day) {
  return (day?.slots || []).filter((slot) => slot.state === "reservable");
}

export function timeToMinutes(value) {
  const text = String(value || "");
  const normalized = text.replace(/^翌/, "");
  const [hours, minutes] = normalized.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes + (text.startsWith("翌") ? 1440 : 0);
}

export function minutesToTime(value) {
  const normalized = value % 1440;
  const clock = `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
  return value >= 1440 ? `翌${clock}` : clock;
}

export function availableRanges(day) {
  const intervals = availableSlots(day)
    .map((slot) => ({ start: timeToMinutes(slot.start), end: timeToMinutes(slot.end) }))
    .filter((slot) => Number.isFinite(slot.start) && Number.isFinite(slot.end) && slot.end > slot.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  return intervals.reduce((ranges, interval) => {
    const current = ranges[ranges.length - 1];
    if (!current || interval.start > current.end) {
      ranges.push({ ...interval });
    } else {
      current.end = Math.max(current.end, interval.end);
    }
    return ranges;
  }, []).map((range) => ({
    start: minutesToTime(range.start),
    end: minutesToTime(range.end)
  }));
}

export function isDayCoverageComplete(day) {
  const checked = Number(day?.checked_slot_count);
  const total = Number(day?.total_slot_count);
  return day?.scan_status === "success"
    && day?.coverage_complete === true
    && Number.isInteger(checked)
    && Number.isInteger(total)
    && total > 0
    && checked === total;
}

export function dateStringInJst(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Tokyo"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isDatasetCurrent(data, now = new Date()) {
  if (data?.scan?.status !== "success" || !data?.generated_at) return false;
  const generatedAt = new Date(data.generated_at);
  if (!Number.isFinite(generatedAt.getTime())) return false;
  return dateStringInJst(generatedAt) === dateStringInJst(now);
}

export function dayPresentation(day, { datasetCurrent = true } = {}) {
  const ranges = availableRanges(day);
  if (ranges.length) {
    const suffix = isDayCoverageComplete(day) && datasetCurrent ? "" : "（確認途中）";
    return {
      state: "available",
      status: "予約可能",
      summary: `${ranges.map((range) => `${range.start}〜${range.end}`).join(" / ")}${suffix}`
    };
  }

  if (!datasetCurrent) {
    return { state: "pending", status: "本日の取得待ち", summary: "" };
  }
  if (isDayCoverageComplete(day) && day?.negative_result_confirmed === true) {
    // A scraper can prove what it checked, but it cannot prove that an external
    // reservation service is infallible. Never make a categorical no-vacancy claim.
    return { state: "unavailable", status: "空き枠未検出・公式確認", summary: "" };
  }

  const status = day?.scan_status || "pending";
  if (status === "partial") return { state: "partial", status: "確認途中", summary: "" };
  if (status === "error") return { state: "error", status: "確認失敗", summary: "" };
  if (status === "blocked") return { state: "blocked", status: "自動確認停止", summary: "" };
  return { state: "pending", status: "確認不完全・公式確認", summary: "" };
}

