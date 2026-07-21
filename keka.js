/* Shared Keka data layer — imported by both popup.js and background.js. */

export const TENANT = 'https://queuebuster.keka.com';
export const PROFILE_URL = `${TENANT}/k/default/api/me/publicprofile`;
export const TAB_MATCH = `${TENANT}/*`;

const TOKEN_KEY = 'kekaToken';
const CACHE_KEY = 'kekaCache';

/* Thrown for 401/403 so callers can say "session expired" instead of "network error". */
export class KekaAuthError extends Error {
  constructor(message = 'Keka session expired') {
    super(message);
    this.name = 'KekaAuthError';
  }
}

export function summaryUrl(monday) {
  return `${TENANT}/k/attendance/api/mytime/attendance/summary/${monday}`;
}

/* ── Token ─────────────────────────────────────────── */

export async function getToken() {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  return stored[TOKEN_KEY] || null;
}

export async function setToken(token) {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

function readAccessToken() {
  return localStorage.getItem('access_token');
}

let inflightRefresh = null;

/**
 * Pull a fresh token out of any open Keka tab.
 * Targets the Keka origin specifically — the old code read whatever tab happened to
 * be active, so the token only refreshed if you were already looking at Keka.
 *
 * Concurrent callers share one lookup; the popup asks for attendance and the
 * profile at the same time and shouldn't inject twice.
 */
export function refreshTokenFromKekaTab() {
  if (!inflightRefresh) {
    inflightRefresh = readTokenFromKekaTab().finally(() => { inflightRefresh = null; });
  }
  return inflightRefresh;
}

/** A stored token if we have one, otherwise whatever an open Keka tab can give us. */
export async function ensureToken() {
  return (await getToken()) || (await refreshTokenFromKekaTab());
}

async function readTokenFromKekaTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: TAB_MATCH });
  } catch (e) {
    return null;
  }

  for (const tab of tabs) {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: readAccessToken,
      });
      const token = injection && injection.result;
      // Store the raw string. Anything JSON-encoded here ends up inside the
      // Authorization header verbatim and produces a 401.
      if (typeof token === 'string' && token.trim()) {
        await setToken(token);
        return token;
      }
    } catch (e) {
      // Tab may have closed or be mid-navigation; try the next one.
    }
  }
  return null;
}

/* ── Fetching ──────────────────────────────────────── */

async function authedJson(url, token) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401 || response.status === 403) throw new KekaAuthError();
  if (!response.ok) throw new Error(`Keka responded ${response.status}`);
  return response.json();
}

export function fetchWeek(token, monday) {
  return authedJson(summaryUrl(monday), token);
}

export function fetchProfile(token) {
  return authedJson(PROFILE_URL, token);
}

/**
 * Fetch the week, refreshing the token from an open Keka tab once if it's rejected.
 */
export async function loadWeek() {
  const token = await ensureToken();
  if (!token) throw new KekaAuthError('No Keka session found');

  try {
    return await fetchWeek(token, getMondayOfCurrentWeek());
  } catch (error) {
    if (!(error instanceof KekaAuthError)) throw error;
    const fresh = await refreshTokenFromKekaTab();
    if (!fresh) throw error;
    return fetchWeek(fresh, getMondayOfCurrentWeek());
  }
}

/* ── Cache ─────────────────────────────────────────── */

export async function writeCache(payload) {
  await chrome.storage.local.set({ [CACHE_KEY]: { payload, savedAt: Date.now() } });
}

export async function readCache() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const entry = stored[CACHE_KEY];
  if (!entry || !entry.payload) return null;
  // Only useful within the week it describes.
  if (Date.now() - entry.savedAt > 7 * 24 * 3600 * 1000) return null;
  return entry;
}

/* ── Profile ───────────────────────────────────────── */

// The endpoint's exact field names aren't pinned down, so accept the usual shapes
// rather than betting on one. Returns null if nothing usable is present.
export function pickProfileName(payload) {
  const p = (payload && payload.data) || payload;
  if (!p || typeof p !== 'object') return null;

  const joined = [p.firstName, p.middleName, p.lastName]
    .filter(part => typeof part === 'string' && part.trim())
    .join(' ');

  const candidate = [p.displayName, p.fullName, p.name, p.employeeName, joined]
    .find(value => typeof value === 'string' && value.trim());

  return candidate ? candidate.trim() : null;
}

/* ── Model ─────────────────────────────────────────── */

class LogShift {
  constructor(fields) {
    Object.assign(this, fields);
  }
}

/**
 * attendanceDayStatus codes confirmed from live responses.
 *
 * Keka does not publish this enum, so anything not listed here is treated as
 * "unknown" and reported rather than guessed at — see classifyDay().
 */
export const DAY_STATUS = {
  PRESENT: 1,
};

/**
 * Status codes Keka credits as a full working day with no in/out punches:
 * On Duty, Work From Home, on-duty regularisation.
 *
 * Add a code here once confirmed — everything else is inferred by
 * looksLikeOnDuty() below, which does not depend on knowing the enum.
 */
export const ON_DUTY_STATUS_CODES = new Set();

const ON_DUTY_HINT = /(on.?duty|work.?from.?home|\bwfh\b|remote)/i;

/**
 * Detect On Duty / WFH without relying on the undocumented status enum.
 *
 * The summary rows carry extra fields we don't otherwise read, and an On Duty day
 * is flagged somewhere among them. Rather than hardcode a field name we haven't
 * confirmed, look for a truthy on-duty-ish key or a matching string value.
 */
function looksLikeOnDuty(raw) {
  if (!raw || typeof raw !== 'object') return false;

  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === false) continue;
    if (ON_DUTY_HINT.test(key) && value !== 0) return true;
    if (typeof value === 'string' && ON_DUTY_HINT.test(value)) return true;
  }
  return false;
}

/**
 * Decide how a day counts.
 *
 *   worked  — you owe/earn hours on this day
 *   off     — weekly off, holiday, or leave; no hours expected
 *   unknown — an unrecognised status code
 *
 * "unknown" is deliberately balance-neutral and labelled with its raw code.
 * The old logic treated every non-PRESENT status as leave, which mislabelled
 * On Duty (WFH) days and, worse, dropped them from the running balance.
 */
export function classifyDay(shift) {
  const status = shift.attendanceDayStatus;
  const hasPunches = shift.inTime != null;

  if (status === DAY_STATUS.PRESENT) return { kind: 'worked', label: null, credited: false };

  // Credited full day: on duty / WFH, typically with no badge punches at all.
  if (ON_DUTY_STATUS_CODES.has(status) || looksLikeOnDuty(shift.raw)) {
    return { kind: 'worked', label: 'On duty', credited: !hasPunches };
  }

  // Punches on a non-present status still mean you were at work.
  if (hasPunches) return { kind: 'worked', label: null, credited: false };

  // No punches, no shift expected — a genuine day off.
  if (!shift.shiftDuration) return { kind: 'off', label: 'Weekly off', credited: false };

  return { kind: 'unknown', label: `Status ${status}`, credited: false };
}

/**
 * Collapse every in/out pair for a day into one span.
 *
 * Keka splits the day into a pair per badge-in/out, so a lunch break yields two.
 * Reading only pairs[0] counted the morning and treated the lunch exit as the day's
 * out time, which understated hours worked. Summing is identical when there's one pair.
 */
function summarizePairs(pairs) {
  const valid = (Array.isArray(pairs) ? pairs : []).filter(pair => pair && pair.inTime);
  if (valid.length === 0) return { inTime: null, outTime: null, totalDuration: 0 };

  const totalDuration = valid.reduce((sum, pair) => sum + (Number(pair.totalDuration) || 0), 0);
  const last = valid[valid.length - 1];

  return {
    inTime: new Date(valid[0].inTime),
    // Null while the last pair is still open — you're clocked in right now.
    outTime: last.outTime ? new Date(last.outTime) : null,
    totalDuration,
  };
}

export function parseLogShifts(responseData) {
  const rows = (responseData && responseData.data) || [];
  return rows.map(shift => {
    const span = summarizePairs(shift.validInOutPairs);

    return new LogShift({
      raw: shift,
      dayType: shift.dayType,
      shiftStartTime: new Date(shift.shiftStartTime),
      shiftEndTime: new Date(shift.shiftEndTime),
      inTime: span.inTime,
      outTime: span.outTime,
      shiftDuration: shift.shiftDuration,
      totalDuration: span.totalDuration,
      attendanceDayStatus: shift.attendanceDayStatus,
    });
  });
}

class WorkDay {
  constructor(fields) {
    Object.assign(this, fields);
  }
}

export function buildUiModel(logShifts) {
  const workDays = [];

  const dateFormat = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short', year: 'numeric', weekday: 'short' });
  const shortFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: '2-digit', month: 'short' });
  const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });
  const dayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long' });

  let accumulatedMinute = 0;
  let inMinute = 0;

  for (const shift of logShifts) {
    const status = classifyDay(shift);
    const isWorkingDay = status.kind === 'worked';

    let adjustedExitTime = new Date(shift.shiftEndTime);
    if (isWorkingDay) {
      adjustedExitTime = new Date(shift.shiftEndTime.getTime() - inMinute * 60000);
    }

    // A credited day (On Duty / WFH) has no punches but counts as the full shift,
    // so it lands balance-neutral instead of looking like a day of missed hours.
    const workedHours = status.credited ? shift.shiftDuration : shift.totalDuration;

    const day = new WorkDay({
      date: dateFormat.format(new Date(shift.shiftStartTime)),
      shortDate: shortFormat.format(new Date(shift.shiftStartTime)),
      startDate: new Date(shift.shiftStartTime),
      dayType: shift.dayType,
      entryTime: timeFormat.format(new Date(shift.shiftStartTime)),
      exitTime: shift.outTime ? timeFormat.format(new Date(shift.outTime)) : timeFormat.format(new Date(shift.shiftEndTime)),
      adjustedExitTime: timeFormat.format(adjustedExitTime),
      accMinutes: inMinute,
      adjustedExitTimeDate: adjustedExitTime,
      isWorkingDay: isWorkingDay,
      statusLabel: status.label,
      isCredited: status.credited,
      attendanceDayStatus: shift.attendanceDayStatus,
      workedLabel: status.credited
        ? getGrossTime(shift.shiftDuration)
        : (shift.outTime != null ? getGrossTime(shift.totalDuration) : null),
    });

    if (isWorkingDay && (shift.outTime != null || status.credited)) {
      accumulatedMinute += workedHours - shift.shiftDuration;
      inMinute = accumulatedMinute * 60;
    }

    if (dayFormat.format(new Date(shift.shiftStartTime)) === 'Saturday') {
      accumulatedMinute = 0;
      inMinute = 0;
    }

    workDays.push(day);
  }

  return workDays;
}

/** Today's row if the week contains it, else the last row. */
export function pickFocusDay(workDays) {
  if (!workDays.length) return null;
  const todayKey = new Date().toDateString();
  return workDays.find(day => day.startDate.toDateString() === todayKey)
    || workDays[workDays.length - 1];
}

/**
 * Toolbar badge text for time remaining. Chrome fits roughly 4 characters, so:
 * minutes under an hour, whole hours above. Callers handle the <= 0 case.
 */
export function formatBadgeText(msRemaining) {
  const minutes = Math.ceil(msRemaining / 60000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.max(minutes, 1)}m`;
}

export function getGrossTime(decimalHour) {
  const hours = Math.floor(decimalHour);
  const minutes = Math.round((decimalHour - hours) * 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

export function getMondayOfCurrentWeek() {
  const today = new Date();
  const distanceToMonday = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - distanceToMonday);

  const year = monday.getFullYear();
  const month = String(monday.getMonth() + 1).padStart(2, '0');
  const day = String(monday.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}
