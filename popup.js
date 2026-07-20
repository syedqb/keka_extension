import {
  loadWeek,
  readCache,
  writeCache,
  ensureToken,
  fetchProfile,
  pickProfileName,
  parseLogShifts,
  buildUiModel,
  pickFocusDay,
  getMondayOfCurrentWeek,
  KekaAuthError,
} from './keka.js';

document.addEventListener('DOMContentLoaded', () => {
  const ui = {
    output: document.getElementById('output'),
    hero: document.getElementById('hero'),
    heroEyebrow: document.getElementById('heroEyebrow'),
    heroFoot: document.getElementById('heroFoot'),
    heroFill: document.getElementById('heroFill'),
    timer: document.getElementById('timer'),
    weekLabel: document.getElementById('weekLabel'),
    footNote: document.getElementById('footNote'),
    profileName: document.getElementById('profileName'),
  };

  renderSkeleton(ui.output);
  ui.weekLabel.textContent = formatWeekLabel();

  start(ui);
  loadProfileName(ui.profileName);

  // Let the service worker pull the badge forward while we're here.
  chrome.runtime.sendMessage('keka:refresh').catch(() => {});
});

async function start(ui) {
  let painted = false;

  // Paint cached data first so the popup opens with content instead of a spinner.
  const cached = await readCache().catch(() => null);
  if (cached) {
    painted = renderWeek(ui, cached.payload);
    if (painted) ui.footNote.textContent = `Updated ${formatClock(cached.savedAt)}`;
  }

  try {
    const payload = await loadWeek();
    writeCache(payload).catch(() => {});
    if (renderWeek(ui, payload)) {
      ui.footNote.textContent = 'Suggestions only — Keka is the source of truth';
      ui.footNote.classList.remove('foot--error');
    }
  } catch (error) {
    // Stale data beats no data — keep whatever the cache painted and just say so.
    if (painted) {
      ui.footNote.textContent = cached
        ? `Offline — showing ${formatClock(cached.savedAt)}`
        : 'Offline';
      ui.footNote.classList.add('foot--error');
      return;
    }

    ui.output.innerHTML = '';
    const expired = error instanceof KekaAuthError;
    setHeroError(ui, expired ? 'Session expired' : 'Sync failed');
    ui.footNote.textContent = expired
      ? 'Open Keka in a tab, then reopen this popup'
      : error.message;
    ui.footNote.classList.add('foot--error');
  }
}

async function loadProfileName(el) {
  try {
    // Not getToken(): on a first run the token isn't stored yet, and the name
    // would silently never load.
    const token = await ensureToken();
    if (!token) return;
    const name = pickProfileName(await fetchProfile(token));
    if (name) el.textContent = name;
  } catch (error) {
    // A missing name must never take the countdown down with it.
    console.warn('profile lookup failed', error);
  }
}

/* ── Rendering ─────────────────────────────────────── */

function renderWeek(ui, payload) {
  const workDays = buildUiModel(parseLogShifts(payload));
  const focus = pickFocusDay(workDays);

  ui.output.innerHTML = '';
  if (!focus) {
    setHeroError(ui, 'Nothing logged this week');
    return false;
  }

  workDays.forEach((day, i) => ui.output.appendChild(renderDay(day, i, day === focus)));
  ui.heroFoot.innerHTML = `Suggested exit <strong>${focus.adjustedExitTime}</strong>`;
  startCountdown(ui, focus);
  return true;
}

function renderSkeleton(output) {
  output.innerHTML = '<div class="skeleton"></div>'.repeat(4);
}

function setHeroError(ui, message) {
  ui.hero.dataset.state = 'error';
  ui.heroEyebrow.textContent = 'Offline';
  ui.timer.textContent = message;
  ui.heroFoot.textContent = 'Open Keka in a tab, then reopen this popup';
}

function renderDay(day, index, isFocus) {
  const el = document.createElement('article');
  const off = !day.isWorkingDay;
  const tone = off ? 'off' : (day.accMinutes > 0 ? 'ahead' : (day.accMinutes < 0 ? 'behind' : 'off'));

  el.className = `day day--${tone}${isFocus ? ' day--today' : ''}`;
  el.style.setProperty('--d', `${index * 45}ms`);

  const date = document.createElement('div');
  date.className = 'day-date';
  date.textContent = day.shortDate;

  const delta = document.createElement('div');
  if (off) {
    delta.className = 'day-delta day-delta--flat';
    delta.textContent = 'OFF';
  } else {
    delta.className = `day-delta day-delta--${day.accMinutes > 0 ? 'ahead' : (day.accMinutes < 0 ? 'behind' : 'flat')}`;
    delta.textContent = formatDelta(day.accMinutes);
  }

  const meta = document.createElement('div');
  meta.className = 'day-meta';
  const bits = off
    ? ['On leave']
    : [`${day.entryTime} – ${day.exitTime}`, `exit ${day.adjustedExitTime}`];
  if (!off && day.workedLabel) bits.push(day.workedLabel);
  meta.innerHTML = bits.map(b => `<span>${b}</span>`).join('<span class="sep-dot">·</span>');

  el.append(date, delta, meta);
  return el;
}

function formatClock(ms) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hour12: true })
    .format(new Date(ms));
}

function formatWeekLabel() {
  const monday = new Date(`${getMondayOfCurrentWeek()}T00:00:00`);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  // en-GB puts the day before the month — "19 Jul", not "Jul 19"
  const d = new Intl.DateTimeFormat('en-GB', { day: 'numeric' });
  const dm = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

  return monday.getMonth() === sunday.getMonth()
    ? `${d.format(monday)} – ${dm.format(sunday)}`
    : `${dm.format(monday)} – ${dm.format(sunday)}`;
}

function formatDelta(minutes) {
  const m = Math.round(minutes);
  if (m === 0) return 'EVEN';
  const sign = m > 0 ? '+' : '−';
  const abs = Math.abs(m);
  const h = Math.floor(abs / 60);
  const rem = abs % 60;
  return h > 0 ? `${sign}${h}h ${String(rem).padStart(2, '0')}m` : `${sign}${abs}m`;
}

let countdownInterval = null;

function startCountdown(ui, day) {
  const target = day.adjustedExitTimeDate.getTime();
  const start = day.startDate.getTime();

  // A re-render (cache then fresh) must not leave two timers racing on one element.
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;

  const tick = () => {
    const now = Date.now();
    const distance = target - now;

    if (distance <= 0) {
      ui.hero.dataset.state = 'over';
      ui.heroEyebrow.textContent = 'Clear to leave';
      ui.timer.textContent = "You're free";
      ui.heroFoot.innerHTML = `Suggested exit was <strong>${day.adjustedExitTime}</strong>`;
      ui.heroFill.style.width = '100%';
      if (countdownInterval) clearInterval(countdownInterval);
      countdownInterval = null;
      return;
    }

    ui.hero.dataset.state = 'counting';
    ui.heroEyebrow.textContent = 'Time remaining';

    const hours = Math.floor(distance / 3600000);
    const minutes = Math.floor((distance % 3600000) / 60000);
    const seconds = Math.floor((distance % 60000) / 1000);

    ui.timer.innerHTML =
      `${hours}<span class="unit">h</span>` +
      `${String(minutes).padStart(2, '0')}<span class="unit">m</span>` +
      `${String(seconds).padStart(2, '0')}<span class="unit">s</span>`;

    const span = target - start;
    const pct = span > 0 ? Math.min(100, Math.max(0, ((now - start) / span) * 100)) : 0;
    ui.heroFill.style.width = `${pct}%`;
  };

  tick();
  // tick() short-circuits the timer when the exit time has already passed.
  if (ui.hero.dataset.state === 'counting') {
    countdownInterval = setInterval(tick, 1000);
  }
}
