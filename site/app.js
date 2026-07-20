import {
  availableRanges,
  dateStringInJst,
  dayPresentation,
  isDatasetCurrent
} from "./availability-policy.mjs?v=20260720-safe-empty";

(() => {
  "use strict";

  const config = window.MEGABIG_APP_CONFIG || {};
  const dataUrl = config.dataUrl || "./data/latest.json";
  const staleAfterMinutes = Number(config.staleAfterMinutes || 300);

  const elements = {
    freshness: document.getElementById("freshness"),
    demoNotice: document.getElementById("demo-notice"),
    earliestSlot: document.getElementById("earliest-slot"),
    dayList: document.getElementById("day-list"),
    errorPanel: document.getElementById("error-panel"),
    errorMessage: document.getElementById("error-message"),
    bookingLink: document.getElementById("booking-link"),
    dayTemplate: document.getElementById("day-template")
  };

  const weekdayFormatter = new Intl.DateTimeFormat("ja-JP", {
    weekday: "short",
    timeZone: "Asia/Tokyo"
  });
  const fullDateFormatter = new Intl.DateTimeFormat("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Tokyo"
  });
  const holidayCache = new Map();

  function parseDay(dateString) {
    return new Date(`${dateString}T00:00:00+09:00`);
  }

  function dateKey(year, month, day) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function dateKeyFromUtc(date) {
    return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  function nthMonday(year, month, nth) {
    const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const firstMonday = 1 + ((8 - firstWeekday) % 7);
    return firstMonday + ((nth - 1) * 7);
  }

  function japaneseHolidayDates(year) {
    if (holidayCache.has(year)) return holidayCache.get(year);

    const holidays = new Set();
    const add = (month, day) => holidays.add(dateKey(year, month, day));
    add(1, 1);
    add(1, nthMonday(year, 1, 2));
    add(2, 11);
    add(2, 23);
    add(3, Math.floor(20.8431 + (0.242194 * (year - 1980)) - Math.floor((year - 1980) / 4)));
    add(4, 29);
    add(5, 3);
    add(5, 4);
    add(5, 5);
    add(7, nthMonday(year, 7, 3));
    add(8, 11);
    add(9, nthMonday(year, 9, 3));
    add(9, Math.floor(23.2488 + (0.242194 * (year - 1980)) - Math.floor((year - 1980) / 4)));
    add(10, nthMonday(year, 10, 2));
    add(11, 3);
    add(11, 23);

    for (let day = 2; day < 365; day += 1) {
      const current = new Date(Date.UTC(year, 0, day));
      if (current.getUTCFullYear() !== year || current.getUTCDay() === 0) continue;
      const key = dateKeyFromUtc(current);
      if (holidays.has(key)) continue;
      const previous = new Date(current.getTime() - 86_400_000);
      const next = new Date(current.getTime() + 86_400_000);
      if (holidays.has(dateKeyFromUtc(previous)) && holidays.has(dateKeyFromUtc(next))) {
        holidays.add(key);
      }
    }

    [...holidays].forEach((key) => {
      const holiday = new Date(`${key}T00:00:00Z`);
      if (holiday.getUTCDay() !== 0) return;
      const substitute = new Date(holiday.getTime() + 86_400_000);
      while (holidays.has(dateKeyFromUtc(substitute))) {
        substitute.setUTCDate(substitute.getUTCDate() + 1);
      }
      if (substitute.getUTCFullYear() === year) holidays.add(dateKeyFromUtc(substitute));
    });

    holidayCache.set(year, holidays);
    return holidays;
  }

  function dayType(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    if (japaneseHolidayDates(year).has(dateString)) return "holiday";
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday === 0) return "sunday";
    if (weekday === 6) return "saturday";
    return "weekday";
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

  function renderDay(day, datasetCurrent) {
    const fragment = elements.dayTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".day-row");
    const dateChip = fragment.querySelector(".date-chip");
    const date = parseDay(day.date);
    const presentation = dayPresentation(day, { datasetCurrent });

    dateChip.dataset.dayType = dayType(day.date);
    dateChip.setAttribute("aria-label", fullDateFormatter.format(date));
    fragment.querySelector(".date-label").textContent = String(Number(day.date.split("-")[2]));
    fragment.querySelector(".weekday-label").textContent = weekdayFormatter.format(date);
    fragment.querySelector(".day-time").textContent = presentation.summary || presentation.status;

    row.dataset.state = presentation.state;
    return fragment;
  }

  function render(data) {
    const target = data.target || {};
    const days = Array.isArray(data.days) ? data.days : [];
    const datasetCurrent = isDatasetCurrent(data);
    elements.demoNotice.hidden = !data.demo;
    elements.bookingLink.href = target.booking_url || elements.bookingLink.href;

    const age = ageLabel(data.generated_at);
    elements.freshness.textContent = age.label;
    elements.freshness.dataset.state = data.demo ? "partial" : (datasetCurrent ? age.state : "stale");
    const today = days.find((day) => day.date === dateStringInJst());
    const todayRanges = datasetCurrent && today ? availableRanges(today) : [];
    if (todayRanges.length) {
      elements.earliestSlot.textContent = todayRanges
        .map((range) => `${range.start}〜${range.end}`)
        .join(" / ");
    } else if (!datasetCurrent) {
      elements.earliestSlot.textContent = "本日の取得待ち";
    } else if (!today) {
      elements.earliestSlot.textContent = "今日のデータなし";
    } else {
      elements.earliestSlot.textContent = dayPresentation(today, { datasetCurrent }).status;
    }

    elements.dayList.replaceChildren();
    days.forEach((day) => {
      elements.dayList.appendChild(renderDay(day, datasetCurrent));
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
