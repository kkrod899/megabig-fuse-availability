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
const apiRequestPaths = new Set([
  "/AjaxOwned/reservableList",
  "/BussinessDaySetting/getHourList",
  "/BussinessDaySetting/getMinuteList",
  "/AjaxOwned/getCourseList",
  "/AjaxOwned/getSeatTypeList",
  "/AjaxOwned/getCourseQuestions"
]);

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

function requestParams(response) {
  return new URLSearchParams(response.request().postData() || "");
}

function matchesApiResponse(response, pathname, expectedParams = {}) {
  let responsePath;
  try {
    responsePath = new URL(response.url()).pathname;
  } catch {
    return false;
  }
  if (responsePath !== pathname || response.request().method() !== "POST") return false;

  const params = requestParams(response);
  return Object.entries(expectedParams).every(([key, expected]) => {
    if (expected === undefined || expected === null) return true;
    const actual = params.get(key);
    const expectedText = String(expected);
    if (actual === expectedText) return true;
    if (key === "use_date") {
      return actual?.split("/").map(Number).join("/") === expectedText.split("/").map(Number).join("/");
    }
    return /^\d+$/.test(actual || "") && /^\d+$/.test(expectedText) && Number(actual) === Number(expectedText);
  });
}

async function waitForJsonResponse(page, pathname, expectedParams = {}) {
  const response = await page.waitForResponse(
    (candidate) => matchesApiResponse(candidate, pathname, expectedParams),
    { timeout: 20000 }
  );
  if (!response.ok()) throw new Error(`api_http_${response.status()}_${pathname}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`api_invalid_json_${pathname}`);
  }
}

function installApiTracker(page, runtime) {
  const pending = new Set();
  runtime.pendingApiRequests = pending;

  const isTracked = (request) => {
    try {
      return apiRequestPaths.has(new URL(request.url()).pathname);
    } catch {
      return false;
    }
  };
  page.on("request", (request) => {
    if (isTracked(request)) pending.add(request);
  });
  const complete = (request) => pending.delete(request);
  page.on("requestfinished", complete);
  page.on("requestfailed", complete);
}

async function waitForApiIdle(page, runtime, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let idleSince = null;
  while (Date.now() < deadline) {
    if (runtime.pendingApiRequests.size === 0) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 150) return;
    } else {
      idleSince = null;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`api_idle_timeout_${runtime.pendingApiRequests.size}`);
}

function dateRequestParams(targetDate) {
  const [year, month, day] = targetDate.split("-");
  return { y: year, m: month, d: day };
}

async function captureAvailabilityRefresh(page, runtime, targetDate, partySize, action) {
  const expected = dateRequestParams(targetDate);
  if (partySize !== undefined) expected.personnum = String(partySize);
  const availabilityPromise = waitForJsonResponse(page, "/AjaxOwned/reservableList", expected);
  const actionResult = await action();
  const availability = await availabilityPromise;
  await waitForApiIdle(page, runtime);
  await page.locator("#select_hours").waitFor({ state: "visible" });
  return { actionResult, availability };
}

async function loadBookingPage(page, runtime, bookingUrl, today) {
  const { actionResult: response, availability } = await captureAvailabilityRefresh(
    page,
    runtime,
    today,
    undefined,
    () => page.goto(bookingUrl, { waitUntil: "domcontentloaded" })
  );
  if (!response || [403, 429].includes(response.status())) {
    throw new Error(`blocked_http_${response?.status() || "no_response"}`);
  }
  return availability;
}

async function selectTargetDate(page, runtime, targetDate, availability) {
  const selectedDateText = await page.getByRole("button", { name: "日付選択", exact: true }).innerText();
  const [year, month, day] = targetDate.split("-").map(Number);
  const expected = `${pad(month)} 月 ${pad(day)} 日`;
  if (normalizeText(selectedDateText).includes(expected)) return { selected: true, availability };

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
    return { selected: false, availability: null };
  }

  const refreshed = await captureAvailabilityRefresh(page, runtime, targetDate, undefined, () => dateCell.click());
  const currentText = await page.getByRole("button", { name: "日付選択", exact: true }).innerText();
  return {
    selected: normalizeText(currentText).includes(expected),
    availability: refreshed.availability
  };
}

async function ensurePartySize(page, runtime, date, partySize, availability) {
  const adult = page.locator("#selected_adult");
  const current = await adult.inputValue();
  if (current === String(partySize)) return availability;

  const refreshed = await captureAvailabilityRefresh(page, runtime, date, partySize, () =>
    adult.selectOption(String(partySize))
  );
  return refreshed.availability;
}

function normalizeApiTime(value) {
  return String(value || "").replace(":", "").padStart(4, "0");
}

function buildTimeOptions(availability) {
  const periods = availability?.reservation_period_result;
  if (!periods || typeof periods !== "object") throw new Error("missing_reservation_period_result");

  return [...new Set(Object.values(periods).flat().map(normalizeApiTime))]
    .filter((value) => /^\d{4}$/.test(value))
    .sort((left, right) => Number(left) - Number(right));
}

function buildReservableTimes(availability) {
  const result = availability?.search_result;
  if (!result || typeof result !== "object") throw new Error("missing_search_result");
  return new Set(
    Object.entries(result)
      .filter(([, value]) => Boolean(value))
      .map(([time]) => normalizeApiTime(time))
  );
}

async function selectHour(page, runtime, date, hour) {
  const hours = page.locator("#select_hours");
  if ((await hours.inputValue()) === String(hour)) return;

  const [year, month, day] = date.split("-");
  const minutesPromise = waitForJsonResponse(page, "/BussinessDaySetting/getMinuteList", {
    use_date: `${year}/${month}/${day}`,
    hour: pad(hour)
  });
  await hours.selectOption(String(hour));
  await minutesPromise;
  await waitForApiIdle(page, runtime);
}

async function selectMinuteAndGetCourses(page, runtime, date, partySize, hour, minute, timeKey) {
  const [year, month, day] = date.split("-");
  const coursePromise = waitForJsonResponse(page, "/AjaxOwned/getCourseList", {
    personnum: String(partySize),
    y: year,
    m: month,
    d: day,
    time: timeKey
  });
  const minuteListPromise = waitForJsonResponse(page, "/BussinessDaySetting/getMinuteList", {
    use_date: `${year}/${month}/${day}`,
    hour: pad(hour)
  });

  const minutes = page.locator("#select_minutes");
  const minuteValue = pad(minute);
  await page.waitForFunction(
    (expected) => [...document.querySelectorAll("#select_minutes option")].some((option) => option.value === expected),
    minuteValue
  );
  await minutes.selectOption(minuteValue);
  const [courses] = await Promise.all([coursePromise, minuteListPromise]);
  await waitForApiIdle(page, runtime);
  if (!Array.isArray(courses)) throw new Error("unexpected_course_response");
  return courses;
}

async function selectCourseAndGetRooms(page, runtime, date, partySize, timeKey, courseRow) {
  const [year, month, day] = date.split("-");
  const courseId = String(courseRow.course_id);
  const roomsPromise = waitForJsonResponse(page, "/AjaxOwned/getSeatTypeList", {
    personnum: String(partySize),
    y: year,
    m: month,
    d: day,
    time: timeKey,
    courseId
  });

  await page.waitForFunction(
    (expected) => [...document.querySelectorAll("#selected_course_id option")].some((option) => option.value === expected),
    courseId
  );
  await page.locator("#selected_course_id").selectOption(courseId);
  const rooms = await roomsPromise;
  await waitForApiIdle(page, runtime);
  if (!Array.isArray(rooms)) throw new Error("unexpected_room_response");
  return rooms.map((room) => normalizeText(room?.t_name).replace(/\/+$/, "")).filter(Boolean);
}

async function scanDay(page, config, date, runtime, initialAvailability) {
  const selectedDate = await selectTargetDate(page, runtime, date, initialAvailability);
  if (!selectedDate.selected) {
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

  const availability = await ensurePartySize(
    page,
    runtime,
    date,
    config.partySize,
    selectedDate.availability
  );
  const available = [];
  const stateCounts = {};
  const startBoundary = timeToMinutes(runtime.timeFrom);
  const endBoundary = timeToMinutes(runtime.timeTo);
  let checkedSlots = 0;
  let totalSlots = 0;
  let consecutiveErrors = 0;

  const timeOptions = buildTimeOptions(availability);
  const reservableTimes = buildReservableTimes(availability);
  for (const timeKey of timeOptions) {
    const hour = Number(timeKey.slice(0, 2));
    const minute = Number(timeKey.slice(2, 4));
    const slotMinute = hour * 60 + minute;
    if (
      !Number.isFinite(hour) ||
      !Number.isFinite(minute) ||
      slotMinute < startBoundary ||
      slotMinute + config.durationMinutes > endBoundary
    ) continue;
    totalSlots += 1;

    const start = `${pad(hour)}:${pad(minute)}`;
    const end = formatEndTime(hour, minute, config.durationMinutes);
    const checkedAt = new Date().toISOString();

    try {
      if (runtime.blockedResponse) {
        throw new Error(`blocked_http_${runtime.blockedResponse}`);
      }

      if (!reservableTimes.has(timeKey)) {
        stateCounts.store_unavailable = (stateCounts.store_unavailable || 0) + 1;
        checkedSlots += 1;
        consecutiveErrors = 0;
        console.log(`${date} ${start} store_unavailable`);
        await page.waitForTimeout(randomDelay(runtime.delayMinMs, runtime.delayMaxMs));
        continue;
      }

      await selectHour(page, runtime, date, hour);
      const courses = await selectMinuteAndGetCourses(
        page,
        runtime,
        date,
        config.partySize,
        hour,
        minute,
        timeKey
      );
      if (courses.length === 0) {
        stateCounts.store_unavailable = (stateCounts.store_unavailable || 0) + 1;
        checkedSlots += 1;
        consecutiveErrors = 0;
        console.log(`${date} ${start} store_unavailable`);
        await page.waitForTimeout(randomDelay(runtime.delayMinMs, runtime.delayMaxMs));
        continue;
      }

      const label = durationLabel(config.durationMinutes);
      const courseRow = courses.find((course) => normalizeText(course?.reserve_coursename) === label);
      if (!courseRow?.course_id) {
        stateCounts.unknown = (stateCounts.unknown || 0) + 1;
        checkedSlots += 1;
        consecutiveErrors = 0;
        console.log(`${date} ${start} duration_unavailable`);
        await page.waitForTimeout(randomDelay(runtime.delayMinMs, runtime.delayMaxMs));
        continue;
      }

      const roomNames = await selectCourseAndGetRooms(
        page,
        runtime,
        date,
        config.partySize,
        timeKey,
        courseRow
      );
      const state = roomNames.includes(config.roomName) ? "reservable" : "not_reservable";
      stateCounts[state] = (stateCounts[state] || 0) + 1;
      checkedSlots += 1;
      consecutiveErrors = 0;

      if (state === "reservable") {
        available.push({ start, end, state, checked_at: checkedAt });
      }
      console.log(`${date} ${start} ${state} rooms=${roomNames.join("|") || "none"}`);
    } catch (error) {
      consecutiveErrors += 1;
      stateCounts.error = (stateCounts.error || 0) + 1;
      console.error(`${date} ${start} error: ${error.message}`);
      if (runtime.blockedResponse || consecutiveErrors >= 5) throw error;
    }

    await page.waitForTimeout(randomDelay(runtime.delayMinMs, runtime.delayMaxMs));
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
  installApiTracker(page, runtime);

  const scannedDays = new Map();
  let fatalError = null;
  try {
    for (const date of targetDates.slice(0, scanLimitDays)) {
      console.log(`scan_start ${date}`);
      const initialAvailability = await loadBookingPage(page, runtime, config.bookingUrl, today);
      scannedDays.set(date, await scanDay(page, config, date, runtime, initialAvailability));
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
