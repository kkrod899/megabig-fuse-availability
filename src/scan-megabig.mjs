import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(projectRoot, "config", "watch.json");
const defaultOutputPath = path.join(projectRoot, "site", "data", "latest.json");
const artifactDirectory = path.join(projectRoot, "artifacts");

const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
const pad = (value) => String(value).padStart(2, "0");

function datePartsInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function dateStringInTimezone(date, timeZone) {
  const parts = datePartsInTimezone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addCalendarDays(dateString, days, timeZone) {
  const anchor = new Date(`${dateString}T12:00:00+09:00`);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return dateStringInTimezone(anchor, timeZone);
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    throw new Error(`Invalid time: ${value}`);
  }
  return hours * 60 + minutes;
}

function formatEndTime(startHour, startMinute, durationMinutes) {
  const end = startHour * 60 + startMinute + durationMinutes;
  const daysLater = Math.floor(end / 1440);
  const normalized = end % 1440;
  const clock = `${pad(Math.floor(normalized / 60))}:${pad(normalized % 60)}`;
  return daysLater > 0 ? `翌${clock}` : clock;
}

function durationLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours && remainder) return `${hours}時間${remainder}分`;
  if (hours) return `${hours}時間`;
  return `${remainder}分`;
}

function randomDelay(minimum, maximum) {
  if (maximum <= minimum) return minimum;
  return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function selectTargetDate(page, targetDate) {
  const selectedDateText = await page.getByRole("button", { name: "日付選択", exact: true }).innerText();
  const [year, month, day] = targetDate.split("-").map(Number);
  const expected = `${pad(month)} 月 ${pad(day)} 日`;
  if (normalizeText(selectedDateText).includes(expected)) return true;

  await page.getByRole("button", { name: "日付選択", exact: true }).click();
  let dateCell = page.locator(`.btn-owd[data-date="${targetDate}"]`);

  if ((await dateCell.count()) === 0) {
    const nextMonth = page.getByRole("button", { name: "次の月 ", exact: true });
    if ((await nextMonth.count()) === 1) {
      await nextMonth.click();
      dateCell = page.locator(`.btn-owd[data-date="${targetDate}"]`);
    }
  }

  if ((await dateCell.count()) !== 1) {
    const closeButton = page.getByRole("button", { name: "閉じる", exact: true });
    if ((await closeButton.count()) === 1) await closeButton.click();
    return false;
  }

  await dateCell.click();
  await page.locator("#select_hours").waitFor({ state: "visible" });
  const currentText = await page.getByRole("button", { name: "日付選択", exact: true }).innerText();
  return normalizeText(currentText).includes(expected);
}

async function waitForCourseOrUnavailable(page) {
  await page.waitForFunction(() => {
    if (document.querySelector("#selected_course_id")) return true;
    const text = document.querySelector("main")?.textContent || "";
    return text.includes("ご用意できません") || text.includes("予約できません");
  });

  return (await page.locator("#selected_course_id").count()) === 1;
}

async function waitForRoomResult(page) {
  const loading = page.locator("#loading");
  try {
    await loading.waitFor({ state: "visible", timeout: 1200 });
  } catch {
    // Fast responses can finish before the loading overlay becomes observable.
  }
  await loading.waitFor({ state: "hidden", timeout: 12000 });
  await page.waitForTimeout(250);

  const roomNames = (await page.locator(".course-name-strong").allTextContents()).map(normalizeText).filter(Boolean);
  if (roomNames.length) return { kind: "room_candidates", roomNames };

  const mainText = normalizeText(await page.locator("main").innerText());
  if (mainText.includes("ご用意できません") || mainText.includes("予約できません")) {
    return { kind: "store_unavailable", roomNames: [] };
  }
  return { kind: "unknown", roomNames: [] };
}

async function getHours(page) {
  return page.locator("#select_hours option").evaluateAll((options) =>
    options
      .map((option) => ({ value: option.value, text: option.textContent.trim() }))
      .filter((option) => option.value !== "")
  );
}

async function getMinutes(page) {
  return page.locator("#select_minutes option").evaluateAll((options) =>
    options
      .map((option) => ({ value: option.value, text: option.textContent.trim() }))
      .filter((option) => option.value !== "")
  );
}

async function scanDay(page, config, date, runtime) {
  const selected = await selectTargetDate(page, date);
  if (!selected) {
    return {
      date,
      scan_status: "success",
      checked_slot_count: 0,
      total_slot_count: 0,
      checked_at: new Date().toISOString(),
      slots: [],
      state_counts: { not_selectable: 1 }
    };
  }

  await page.locator("#selected_adult").selectOption(String(config.partySize));
  const available = [];
  const stateCounts = {};
  const startBoundary = timeToMinutes(runtime.timeFrom);
  const endBoundary = timeToMinutes(runtime.timeTo);
  let checkedSlots = 0;
  let totalSlots = 0;
  let consecutiveErrors = 0;

  const hours = await getHours(page);
  for (const hourOption of hours) {
    const hour = Number(hourOption.value);
    if (!Number.isFinite(hour)) continue;
    if ((hour + 1) * 60 <= startBoundary || hour * 60 >= endBoundary) continue;

    await page.locator("#select_hours").selectOption(hourOption.value);
    await page.waitForFunction(() => document.querySelectorAll("#select_minutes option").length > 1);
    const minutes = await getMinutes(page);

    for (const minuteOption of minutes) {
      const minute = Number(minuteOption.value);
      const slotMinute = hour * 60 + minute;
      if (!Number.isFinite(minute) || slotMinute < startBoundary || slotMinute >= endBoundary) continue;
      totalSlots += 1;

      const start = `${pad(hour)}:${pad(minute)}`;
      const end = formatEndTime(hour, minute, config.durationMinutes);
      const checkedAt = new Date().toISOString();

      try {
        if (runtime.blockedResponse) {
          throw new Error(`blocked_http_${runtime.blockedResponse}`);
        }

        await page.locator("#select_minutes").selectOption(minuteOption.value);
        const courseAvailable = await waitForCourseOrUnavailable(page);
        if (!courseAvailable) {
          stateCounts.store_unavailable = (stateCounts.store_unavailable || 0) + 1;
          checkedSlots += 1;
          consecutiveErrors = 0;
          console.log(`${date} ${start} store_unavailable`);
          await page.waitForTimeout(randomDelay(runtime.delayMinMs, runtime.delayMaxMs));
          continue;
        }

        const course = page.locator("#selected_course_id");
        const label = durationLabel(config.durationMinutes);
        const labels = await course.locator("option").allTextContents();
        if (!labels.map(normalizeText).includes(label)) {
          stateCounts.unknown = (stateCounts.unknown || 0) + 1;
          checkedSlots += 1;
          consecutiveErrors = 0;
          console.log(`${date} ${start} duration_unavailable`);
          await page.waitForTimeout(randomDelay(runtime.delayMinMs, runtime.delayMaxMs));
          continue;
        }

        await course.selectOption({ label });
        const result = await waitForRoomResult(page);
        let state = result.kind;
        if (result.kind === "room_candidates") {
          state = result.roomNames.includes(config.roomName) ? "reservable" : "not_reservable";
        }
        stateCounts[state] = (stateCounts[state] || 0) + 1;
        checkedSlots += 1;
        consecutiveErrors = 0;

        if (state === "reservable") {
          available.push({ start, end, state, checked_at: checkedAt });
        }
        console.log(`${date} ${start} ${state}`);
      } catch (error) {
        consecutiveErrors += 1;
        stateCounts.error = (stateCounts.error || 0) + 1;
        console.error(`${date} ${start} error: ${error.message}`);
        if (runtime.blockedResponse || consecutiveErrors >= 5) throw error;
      }

      await page.waitForTimeout(randomDelay(runtime.delayMinMs, runtime.delayMaxMs));
    }
  }

  const status = stateCounts.error || checkedSlots < totalSlots ? "partial" : "success";
  return {
    date,
    scan_status: status,
    checked_slot_count: checkedSlots,
    total_slot_count: totalSlots,
    checked_at: new Date().toISOString(),
    slots: available,
    state_counts: stateCounts
  };
}

function pendingDay(date) {
  return {
    date,
    scan_status: "pending",
    checked_slot_count: 0,
    total_slot_count: 0,
    checked_at: null,
    slots: []
  };
}

async function main() {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const outputPath = path.resolve(process.env.SCAN_OUTPUT || defaultOutputPath);
  const existing = await readJson(outputPath, null);
  const today = dateStringInTimezone(new Date(), config.timezone);
  const targetDates = Array.from({ length: config.daysAhead }, (_, index) =>
    addCalendarDays(today, index, config.timezone)
  );
  const scanLimitDays = Math.max(1, Math.min(config.daysAhead, Number(process.env.SCAN_LIMIT_DAYS || config.daysAhead)));
  const delayOverride = process.env.SCAN_DELAY_MS === undefined ? null : Number(process.env.SCAN_DELAY_MS);
  const runtime = {
    timeFrom: process.env.SCAN_TIME_FROM || config.timeFrom,
    timeTo: process.env.SCAN_TIME_TO || config.timeTo,
    delayMinMs: delayOverride === null ? config.delayMinMs : delayOverride,
    delayMaxMs: delayOverride === null ? config.delayMaxMs : delayOverride,
    blockedResponse: null
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await mkdir(artifactDirectory, { recursive: true });

  const launchOptions = { headless: process.env.SCAN_HEADFUL !== "1" };
  if (process.env.SCAN_CHROME_PATH) launchOptions.executablePath = process.env.SCAN_CHROME_PATH;
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ locale: "ja-JP", timezoneId: config.timezone });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("response", (response) => {
    if ([403, 429].includes(response.status())) runtime.blockedResponse = response.status();
  });

  const scannedDays = new Map();
  let fatalError = null;
  try {
    const response = await page.goto(config.bookingUrl, { waitUntil: "domcontentloaded" });
    if (!response || [403, 429].includes(response.status())) {
      throw new Error(`blocked_http_${response?.status() || "no_response"}`);
    }
    await page.locator("#select_hours").waitFor({ state: "visible" });

    for (const date of targetDates.slice(0, scanLimitDays)) {
      console.log(`scan_start ${date}`);
      scannedDays.set(date, await scanDay(page, config, date, runtime));
    }
  } catch (error) {
    fatalError = error;
    console.error(`fatal: ${error.stack || error.message}`);
    await page.screenshot({ path: path.join(artifactDirectory, "megabig-failure.png"), fullPage: true }).catch(() => {});
  } finally {
    await context.close();
    await browser.close();
  }

  const previousDays = new Map((existing?.days || []).map((day) => [day.date, day]));
  const days = targetDates.map((date) => scannedDays.get(date) || previousDays.get(date) || pendingDay(date));
  const generatedAt = new Date().toISOString();
  const output = {
    schema_version: "1.0",
    demo: false,
    generated_at: generatedAt,
    target: {
      shop_name: config.shopName,
      room_name: config.roomName,
      party_size: config.partySize,
      duration_minutes: config.durationMinutes,
      time_from: runtime.timeFrom,
      time_to: runtime.timeTo,
      booking_url: config.bookingUrl
    },
    scan: {
      status: fatalError ? (runtime.blockedResponse ? "blocked" : "partial") : "success",
      scanned_days: [...scannedDays.keys()],
      error: fatalError ? fatalError.message : null
    },
    days
  };

  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`output ${outputPath}`);
  if (fatalError) process.exitCode = 1;
}

await main();
