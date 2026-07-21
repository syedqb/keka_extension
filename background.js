/**
 * Keeps the toolbar badge showing time left until you can leave, and pings once
 * when you get there — so the common case needs no popup at all.
 */
import {
  loadWeek,
  writeCache,
  parseLogShifts,
  buildUiModel,
  contextFromPayload,
  pickFocusDay,
  formatBadgeText,
  KekaAuthError,
} from './keka.js';

const ALARM = 'keka-tick';
const NOTIFIED_KEY = 'kekaNotifiedFor';

const AMBER = '#ffb627';
const GREEN = '#7ed492';
const RED = '#ef6a5f';

chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) refresh();
});
// The popup re-fetches on open; let it push the badge forward too.
chrome.runtime.onMessage.addListener(message => {
  if (message === 'keka:refresh') refresh();
});

function start() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  refresh();
}

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title: title || 'Keka Time Suggestion' });
}

async function refresh() {
  try {
    const payload = await loadWeek();
    await writeCache(payload);

    const focus = pickFocusDay(buildUiModel(parseLogShifts(payload), contextFromPayload(payload)));
    if (!focus) {
      await setBadge('', null, 'Keka — nothing logged this week');
      return;
    }

    if (!focus.isWorkingDay) {
      await setBadge('', null, 'Keka — not a working day');
      return;
    }

    const remaining = focus.adjustedExitTimeDate.getTime() - Date.now();

    if (remaining <= 0) {
      await setBadge('✓', GREEN, `Keka — you're free (exit was ${focus.adjustedExitTime})`);
      await maybeNotify(focus);
      return;
    }

    await setBadge(formatBadgeText(remaining), AMBER, `Keka — leave at ${focus.adjustedExitTime}`);
  } catch (error) {
    if (error instanceof KekaAuthError) {
      await setBadge('!', RED, 'Keka session expired — open Keka in a tab');
    } else {
      await setBadge('!', RED, `Keka — ${error.message}`);
    }
  }
}

/** At most one notification per calendar day. */
async function maybeNotify(focus) {
  const todayKey = new Date().toDateString();
  const stored = await chrome.storage.local.get(NOTIFIED_KEY);
  if (stored[NOTIFIED_KEY] === todayKey) return;

  await chrome.storage.local.set({ [NOTIFIED_KEY]: todayKey });
  chrome.notifications.create(`keka-${todayKey}`, {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: "You're clear to leave",
    message: `Suggested exit was ${focus.adjustedExitTime}.`,
  });
}
