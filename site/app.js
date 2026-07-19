(() => {
  "use strict";

  const config = window.MEGABIG_APP_CONFIG || {};
  const dataUrl = config.dataUrl || "./data/latest.json";
  const staleAfterMinutes = Number(config.staleAfterMinutes || 300);

  const elements = {
    freshness: document.getElementById("freshness"),
    demoNotice: document.getElementById("demo-notice"),
    partySize: document.getElementById("party-size"),
    duration: document.getElementById("duration"),
    timeRange: document.getElementById("time-range"),
    earliestSlot: document.getElementById("earliest-slot"),
    checkedAt: document.getElementById("checked-at"),
    reloadButton: document.getElementById("reload-button"),
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
  const checkedFormatter = new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo"
  });

  function parseDay(dateString) {
    return new Date(`${dateString}T00:00:00+09:00`);
  }

  function formatDuration(minutes) {
    if (!Number.isFinite(minutes)) return "利用時間不明";
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours && rest) return `${hours}時間${rest}分`;
    if (hours) return `${hours}時間`;
    return `${rest}分`;
  }

  function formatCheckedAt(value) {
    if (!value) return "未確認";
    return checkedFormatter.format(new Date(value)).replace("24:", "00:");
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
    const checked = Number(day.checked_slot_count || 0);
    const total = Number(day.total_slot_count || 0);
    if (status === "success") {
      return { state: "unavailable", status: "空き時間なし", summary: "対象時間を確認済み" };
    }
    if (status === "partial") {
      return { state: "partial", status: "確認途中", summary: `${checked} / ${total}時刻を確認` };
    }
    if (status === "error") {
      return { state: "error", status: "確認失敗", summary: "実行ログを確認してください" };
    }
    if (status === "blocked") {
      return { state: "blocked", status: "自動確認停止", summary: "アクセス拒否を検知しました" };
    }
    return { state: "pending", status: "確認待ち", summary: "次回の定期走査で確認" };
  }

  function renderDay(day, index, shouldOpen) {
    const fragment = elements.dayTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".day-card");
    const toggle = fragment.querySelector(".day-toggle");
    const details = fragment.querySelector(".day-details");
    const date = parseDay(day.date);
    const presentation = dayPresentation(day);
    const ranges = availableRanges(day);
    const detailsId = `day-details-${index}`;

    fragment.querySelector(".date-label").textContent = dateFormatter.format(date);
    fragment.querySelector(".weekday-label").textContent = weekdayFormatter.format(date);
    const statusElement = fragment.querySelector(".day-status");
    statusElement.textContent = presentation.status;
    statusElement.dataset.state = presentation.state;
    fragment.querySelector(".day-summary").textContent = presentation.summary;

    const caption = fragment.querySelector(".detail-caption");
    caption.textContent = ranges.length
      ? "予約可能な時間帯"
      : "この日の確認状況";

    const slotList = fragment.querySelector(".slot-list");
    if (ranges.length) {
      ranges.forEach((range) => {
        const item = document.createElement("li");
        item.className = "slot-item";
        const time = document.createElement("span");
        time.className = "slot-time";
        time.textContent = `${range.start}〜${range.end}`;
        const state = document.createElement("span");
        state.className = "slot-state";
        state.textContent = "空きあり";
        item.append(time, state);
        slotList.appendChild(item);
      });
    } else {
      const empty = document.createElement("li");
      empty.className = "empty-detail";
      empty.textContent = presentation.summary;
      slotList.appendChild(empty);
    }

    fragment.querySelector(".day-checked").textContent = `最終確認: ${formatCheckedAt(day.checked_at)}`;
    details.id = detailsId;
    toggle.setAttribute("aria-controls", detailsId);
    toggle.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    details.hidden = !shouldOpen;
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      details.hidden = open;
    });

    card.dataset.state = presentation.state;
    return fragment;
  }

  function render(data) {
    const target = data.target || {};
    const days = Array.isArray(data.days) ? data.days : [];
    const allAvailable = days.flatMap((day) =>
      availableRanges(day).map((range) => ({ ...range, date: day.date }))
    );
    allAvailable.sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`));

    elements.demoNotice.hidden = !data.demo;
    elements.partySize.textContent = `${target.party_size || "—"}名`;
    elements.duration.textContent = `${formatDuration(Number(target.duration_minutes))}単位で確認`;
    elements.timeRange.textContent = `${target.time_from || "—"}〜${target.time_to || "—"}`;
    elements.bookingLink.href = target.booking_url || elements.bookingLink.href;

    const age = ageLabel(data.generated_at);
    elements.freshness.textContent = age.label;
    elements.freshness.dataset.state = data.demo ? "partial" : age.state;
    elements.checkedAt.textContent = data.generated_at
      ? `データ更新 ${formatCheckedAt(data.generated_at)} JST`
      : "まだ取得されていません";

    if (allAvailable.length) {
      const earliest = allAvailable[0];
      const earliestDate = parseDay(earliest.date);
      elements.earliestSlot.textContent = `${dateFormatter.format(earliestDate)}（${weekdayFormatter.format(earliestDate)}）${earliest.start}〜${earliest.end}`;
    } else {
      elements.earliestSlot.textContent = days.some((day) => day.scan_status === "pending" || day.scan_status === "partial")
        ? "確認中です"
        : "向こう1週間に空き時間なし";
    }

    const availableDayCount = days.filter((day) => availableSlots(day).length > 0).length;
    elements.availableDays.textContent = `${availableDayCount}日で予約可`;
    elements.dayList.replaceChildren();
    let openedAvailableDay = false;
    days.forEach((day, index) => {
      const hasAvailability = availableRanges(day).length > 0;
      const shouldOpen = hasAvailability && !openedAvailableDay;
      if (shouldOpen) openedAvailableDay = true;
      elements.dayList.appendChild(renderDay(day, index, shouldOpen));
    });

    elements.errorPanel.hidden = true;
  }

  async function loadAvailability() {
    elements.reloadButton.disabled = true;
    elements.reloadButton.lastChild.textContent = " 読み込み中…";
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
    } finally {
      elements.reloadButton.disabled = false;
      elements.reloadButton.lastChild.textContent = " 最新データを再読込";
    }
  }

  elements.reloadButton.addEventListener("click", loadAvailability);

  loadAvailability();
  window.setInterval(loadAvailability, 60_000);
})();
