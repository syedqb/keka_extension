# Keka Time Suggestion

Chrome extension that tells you when you can leave. The toolbar badge counts down
(`2h`, `45m`), turns into a green check when you're clear, and notifies you once.
Click it for the week's breakdown.

Built for the **queuebuster.keka.com** tenant — see [Other tenants](#other-tenants).

## Install

> Chrome blocks one-click installs for extensions hosted outside the Chrome Web
> Store (it removed drag-and-drop `.crx` installs in Chrome 73 for security).
> Until this is published to the Store, the unpacked install below is the way.
> It takes about a minute.

1. Download `keka-time-<version>.zip` and **unzip it**. Keep the resulting folder
   somewhere permanent — Chrome loads the extension from that folder every launch,
   so deleting it uninstalls the extension.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select the unzipped folder — the one containing
   `manifest.json`.
5. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to
   "Keka Time Suggestion".

### First run

Open **queuebuster.keka.com** in a tab and sign in. The extension reads your
existing session from that tab — it never asks for your password and has no login
of its own. Once the badge shows a countdown you can close the Keka tab.

If the badge shows a red `!`, your session expired: open Keka again and sign in.

### Updating

Replace the folder's contents with the new version, then hit the reload arrow on
the extension's card in `chrome://extensions`.

## What it can access

| Permission | Why |
| --- | --- |
| `host_permissions: queuebuster.keka.com` | Read attendance and profile. This is the **only** site it can touch. |
| `scripting` | Read the auth token from your open Keka tab. |
| `storage` | Cache the week locally so the popup opens instantly. |
| `alarms` | Refresh the badge once a minute. |
| `notifications` | Tell you once when you're clear to leave. |

Everything stays on your machine — the extension talks to Keka and nothing else.
There is no analytics, no server, no third party.

## Other tenants

The Keka host is hardcoded. For a different company, edit `TENANT` at the top of
`keka.js` and the matching entry in `manifest.json` under `host_permissions`, then
reload.

## Publishing to the Web Store

A Store listing is what makes this genuinely one-click (and enables auto-updates).

1. Pay the one-time $5 developer registration fee at the
   [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Run `./build.sh` and upload `dist/keka-time-<version>.zip`.
3. Set visibility to **Unlisted** so only people with the link can install, or
   **Private** to restrict it to your Google Workspace org — for an internal tool
   this is usually what you want rather than Public.
4. Review typically takes a few days. Bump `version` in `manifest.json` for each
   submission.

Your Workspace admin can also force-install it org-wide by policy, which genuinely
is zero-click for colleagues.

## Development

```sh
./build.sh    # validates and packages into dist/
```

- `keka.js` — API, auth, caching, and the attendance model. Shared by both below.
- `popup.js` — renders the popup.
- `background.js` — service worker driving the badge and notification.
