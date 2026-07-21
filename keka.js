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
    return await loadWeekWith(token);
  } catch (error) {
    if (!(error instanceof KekaAuthError)) throw error;
    const fresh = await refreshTokenFromKekaTab();
    if (!fresh) throw error;
    return loadWeekWith(fresh);
  }
}

/**
 * The week needs three calls: the attendance rows, the On Duty requests, and the
 * week-off schedule. Only the first is essential — the other two degrade to empty
 * rather than taking the whole popup down with them.
 */
async function loadWeekWith(token) {
  const monday = getMondayOfCurrentWeek();
  const [summary, onDuty, weekOff] = await Promise.all([
    fetchWeek(token, monday),
    fetchOnDutyDays(token, monday).catch(() => new Map()),
    fetchWeekOffDays(token).catch(() => new Set()),
  ]);

  return {
    ...summary,
    onDutyDays: [...onDuty.entries()],
    weekOffDays: [...weekOff],
  };
}

/** Rebuild the lookup structures from a cached (JSON-safe) payload. */
export function contextFromPayload(payload) {
  return {
    onDutyDays: new Map((payload && payload.onDutyDays) || []),
    weekOffDays: new Set((payload && payload.weekOffDays) || []),
  };
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
 * attendanceDayStatus values, confirmed against live responses.
 * 0 simply means "nothing recorded" — it is not a leave marker.
 */
export const DAY_STATUS = {
  NONE: 0,
  PRESENT: 1,
};

/** weekOffType from day-wise-shift-weeklyoff-details: 0 = working day, 2 = full week off. */
export const WEEK_OFF_FULL = 2;

/** requestType 6 = "working remotely" (Keka's On Duty / WFH request). */
const REQUEST_TYPE_REMOTE = 6;
/** requestStatus 1 = pending approval. */
const REQUEST_PENDING = 1;

export function dateKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * On Duty / WFH lives in its own endpoint, not on the attendance row.
 *
 * This is why the day looked like leave: the summary row for an On Duty day is
 * simply blank (attendanceDayStatus 0, no punches, no leave details). The request
 * has to be fetched separately and joined on by date.
 */
export async function fetchOnDutyDays(token, monday) {
  const from = monday;
  const to = dateKey(new Date(new Date(`${monday}T00:00:00`).getTime() + 6 * 86400000));
  const url = `${TENANT}/k/attendance/api/mytime/attendance/workingremotelyrequests`
    + `?fromDate=${from}&toDate=${to}`;

  const payload = await authedJson(url, token);
  const requests = (payload && payload.data) || [];
  const days = new Map();

  for (const req of requests) {
    if (req.requestType !== REQUEST_TYPE_REMOTE) continue;
    // Requests cover an inclusive date range, so expand it day by day.
    const start = new Date(`${String(req.fromDate).slice(0, 10)}T00:00:00`);
    const end = new Date(`${String(req.toDate).slice(0, 10)}T00:00:00`);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      days.set(dateKey(d), { pending: req.requestStatus === REQUEST_PENDING });
    }
  }
  return days;
}

/** Authoritative week-off days, replacing the old "Saturday" guess. */
export async function fetchWeekOffDays(token) {
  const url = `${TENANT}/k/attendance/api/mytime/attendance/day-wise-shift-weeklyoff-details`;
  const payload = await authedJson(url, token);
  const details = (payload && payload.data && payload.data.shiftWeekoffDetails) || {};
  const offDays = new Set();

  for (const [date, entries] of Object.entries(details)) {
    const entry = Array.isArray(entries) ? entries[0] : null;
    if (entry && entry.weekOffType === WEEK_OFF_FULL) offDays.add(date.slice(0, 10));
  }
  return offDays;
}

/**
 * Decide how a day counts.
 *
 *   worked  — you owe/earn hours on this day
 *   off     — week off, holiday, or leave; no hours expected
 *   unknown — nothing recorded and no explanation for it
 *
 * `context` carries the two things the attendance row cannot tell us on its own:
 * which days are On Duty, and which are week offs.
 */
export function classifyDay(shift, context = {}) {
  const { onDutyDays, weekOffDays } = context;
  const key = dateKey(shift.shiftStartTime);
  const hasPunches = shift.inTime != null;

  // Real leave is explicit on the row — no guessing needed.
  const leave = (shift.raw && (shift.raw.leaveDetails || [])[0]) || null;
  const onLeave = leave || (shift.raw && (shift.raw.leaveDayStatuses || []).length > 0);

  const onDuty = onDutyDays && onDutyDays.get(key);
  if (onDuty) {
    return {
      kind: 'worked',
      label: onDuty.pending ? 'On duty (pending)' : 'On duty',
      credited: !hasPunches,
    };
  }

  if (onLeave) {
    return { kind: 'off', label: (leave && leave.leaveTypeName) || 'On leave', credited: false };
  }

  if (weekOffDays && weekOffDays.has(key)) {
    return { kind: 'off', label: 'Weekly off', credited: false };
  }

  if (shift.attendanceDayStatus === DAY_STATUS.PRESENT || hasPunches) {
    return { kind: 'worked', label: null, credited: false };
  }

  if (!shift.shiftDuration) return { kind: 'off', label: 'Weekly off', credited: false };

  // A weekday with nothing logged is only an anomaly once it's in the past.
  const today = dateKey(new Date());
  if (key > today) return { kind: 'scheduled', label: 'Scheduled', credited: false };
  if (key === today) return { kind: 'scheduled', label: 'Not clocked in', credited: false };

  return { kind: 'unknown', label: 'No entries', credited: false };
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

export function buildUiModel(logShifts, context = {}) {
  const workDays = [];

  const dateFormat = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short', year: 'numeric', weekday: 'short' });
  const shortFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: '2-digit', month: 'short' });
  const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });

  let accumulatedMinute = 0;
  let inMinute = 0;

  for (const shift of logShifts) {
    const status = classifyDay(shift, context);
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
      statusKind: status.kind,
      isCredited: status.credited,
      // Straight from the API — never a hardcoded shift length.
      // A scheduled weekday owes hours whether or not it has been worked yet, so
      // this keys off "not a day off" rather than "already worked". Only week offs
      // and leave excuse the hours.
      requiredHours: status.kind === 'off' ? 0 : (shift.shiftDuration || 0),
      workedHours: isWorkingDay ? (workedHours || 0) : 0,
      attendanceDayStatus: shift.attendanceDayStatus,
      workedLabel: status.credited
        ? getGrossTime(shift.shiftDuration)
        : (shift.outTime != null ? getGrossTime(shift.totalDuration) : null),
    });

    if (isWorkingDay && (shift.outTime != null || status.credited)) {
      accumulatedMinute += workedHours - shift.shiftDuration;
      inMinute = accumulatedMinute * 60;
    }

    // The old code zeroed the balance every Saturday. The API returns one Mon–Sun
    // week per call, so the balance already starts fresh — and week offs are now
    // read from weekOffDays rather than assumed to be Saturday.

    workDays.push(day);
  }

  return workDays;
}

/**
 * The week as an hours budget.
 *
 * Offices differ — 45h over 5 days, 40h over 5, 48h over 6 — and some let you
 * vary the split (8h today, 10h tomorrow) so long as the week total lands. So the
 * target is summed from each working day's own shiftDuration rather than assuming
 * any per-day figure: 5 × 9h derives 45h here, 5 × 8h would derive 40h elsewhere.
 *
 * `remainingToday` spreads the shortfall correctly: it is what's left for the week
 * minus the standard hours the *later* working days will absorb.
 */
export function weekBudget(workDays, focusDay = null) {
  let required = 0;
  let worked = 0;
  let laterRequired = 0;
  let seenFocus = false;

  for (const day of workDays) {
    required += day.requiredHours || 0;
    worked += day.workedHours || 0;

    if (focusDay && day === focusDay) { seenFocus = true; continue; }
    if (focusDay && seenFocus) laterRequired += day.requiredHours || 0;
  }

  const remainingWeek = Math.max(0, required - worked);
  const focusWorked = focusDay ? (focusDay.workedHours || 0) : 0;

  return {
    requiredHours: required,
    workedHours: worked,
    balanceHours: worked - required,
    remainingHours: remainingWeek,
    // Hours still owed on the focus day itself, after later days take their share.
    remainingToday: focusDay
      ? Math.max(0, required - (worked - focusWorked) - laterRequired - focusWorked)
      : 0,
    percent: required > 0 ? Math.min(100, (worked / required) * 100) : 0,
  };
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
