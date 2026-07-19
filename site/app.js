(() => {
  "use strict";

  const config = window.MEGABIG_APP_CONFIG || {};
  const dataUrl = config.dataUrl || "./data/latest.json";
  const staleAfterMinutes = Number(config.staleAfterMinutes || 300);

  const elements = {
    freshness: document.getElementById("freshness"),
    demoNotice: document.getElementById("demo-notice"),
    earliestSlot: document.getElementById("earliest-slot"),
    availableDays: document.getElementById("available-days"),
    dayList: document.getElementById("day-list"),
    errorPanel: document.getElementById("error-panel"),
    errorMessage: document.getElementById("error-message"),
    bookingLink: document.getElementById("booking-link"),
    dayTemplate: document.getElementById("day-template")
  };

  const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    timeZone: "Asia/Tokyo"
  });
  const weekdayFormatter = new Intl.DateTimeFormat("ja-JP", {
    weekday: "short",
    timeZone: "Asia/Tokyo"
  });
  function parseDay(dateString) {
    return new Date(`${dateString}T00:00:00+09:00`);
  }

  function dateStringInJst(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Asia/Tokyo"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function ageLabel(value) {
    if (!value) return { label: "未取得", state: "error" };
    const diffMinutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
    if (diffMinutes < 1) return { label: "たった今取得", state: "fresh" };
    if (diffMinutes < 60) {
      return {
        label: `${diffMinutes}分前に取得`,
        state: diffMinutes > staleAfterMinutes ? "stale" : "fresh"
      };
    }
    const hours = Math.floor(diffMinutes / 60);
    return {
      label: `${hours}時間前に取得`,
      state: diffMinutes > staleAfterMinutes ? "stale" : "fresh"
    };
  }

  function availableSlots(day) {
    return (day.slots || []).filter((slot) => slot.state === "reservable");
  }

  function timeToMinutes(value) {
    const normalized = String(value || "").replace(/^翌/, "");
    const [hours, minutes] = normalized.split(":").map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return hours * 60 + minutes + (String(value).startsWith("翌") ? 1440 : 0);
  }

  function minutesToTime(value) {
    const normalized = value % 1440;
    const clock = `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
    return value >= 1440 ? `翌${clock}` : clock;
  }

  function availableRanges(day) {
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

  function dayPresentation(day) {
    const ranges = availableRanges(day);
    if (ranges.length) {
      const preview = ranges.slice(0, 2).map((range) => `${range.start}〜${range.end}`).join(" / ");
      const remainder = ranges.length > 2 ? ` ほか${ranges.length - 2}時間帯` : "";
      return {
        state: "available",
        status: "予約可能",
        summary: `${preview}${remainder}`
      };
    }

    const status = day.scan_status || "pending";
    if (status === "success") {
      return { state: "unavailable", status: "空き時間なし", summary: "" };
    }
    if (status === "partial") {
      return { state: "partial", status: "確認途中", summary: "" };
    }
    if (status === "error") {
      return { state: "error", status: "確認失敗", summary: "" };
    }
    if (status === "blocked") {
      return { state: "blocked", status: "自動確認停止", summary: "" };
    }
    return { state: "pending", status: "確認待ち", summary: "" };
  }

  function renderDay(day) {
    const fragment = elements.dayTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".day-card");
    const date = parseDay(day.date);
    const presentation = dayPresentation(day);

    fragment.querySelector(".date-label").textContent = dateFormatter.format(date);
    fragment.querySelector(".weekday-label").textContent = weekdayFormatter.format(date);
    const statusElement = fragment.querySelector(".day-status");
    statusElement.textContent = presentation.status;
    statusElement.dataset.state = presentation.state;
    const summaryElement = fragment.querySelector(".day-summary");
    summaryElement.textContent = presentation.summary;
    summaryElement.hidden = !presentation.summary;

    card.dataset.state = presentation.state;
    return fragment;
  }

  function render(data) {
    const target = data.target || {};
    const days = Array.isArray(data.days) ? data.days : [];
    elements.demoNotice.hidden = !data.demo;
    elements.bookingLink.href = target.booking_url || elements.bookingLink.href;

    const age = ageLabel(data.generated_at);
    elements.freshness.textContent = age.label;
    elements.freshness.dataset.state = data.demo ? "partial" : age.state;
    const today = days.find((day) => day.date === dateStringInJst());
    const todayRanges = today ? availableRanges(today) : [];
    if (todayRanges.length) {
      elements.earliestSlot.textContent = todayRanges
        .map((range) => `${range.start}〜${range.end}`)
        .join(" / ");
    } else if (!today) {
      elements.earliestSlot.textContent = "今日のデータなし";
    } else if (["pending", "partial"].includes(today.scan_status)) {
      elements.earliestSlot.textContent = "今日の確認待ち";
    } else {
      elements.earliestSlot.textContent = "今日は空き時間なし";
    }

    const availableDayCount = days.filter((day) => availableSlots(day).length > 0).length;
    elements.availableDays.textContent = `${availableDayCount}日で予約可`;
    elements.dayList.replaceChildren();
    days.forEach((day) => {
      elements.dayList.appendChild(renderDay(day));
    });

    elements.errorPanel.hidden = true;
  }

  async function loadAvailability() {
    try {
      const separator = dataUrl.includes("?") ? "&" : "?";
      const response = await fetch(`${dataUrl}${separator}ts=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      render(data);
    } catch (error) {
      elements.freshness.textContent = "読込失敗";
      elements.freshness.dataset.state = "error";
      elements.errorMessage.textContent = `最新JSONの取得に失敗しました（${error.message}）。`;
      elements.errorPanel.hidden = false;
    }
  }

  loadAvailability();
  window.setInterval(loadAvailability, 60_000);
})();
