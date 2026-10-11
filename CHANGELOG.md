# Changelog

## 1.4.0
- **Redesigned popup:** glass-style cards on a dark gradient background, line icons, a pill-style Archive / Scan switch, larger stat tiles, a glowing progress bar, styled file picker, focus rings, and an animated confirmation dialog. Stop All Automation now sits in the Queue controls as "Stop all".
- **Removed Deep Clean** (the multi-pass rescan loop) and the **post-delete verification/retry step**. Each post is deleted once; it counts as deleted when X removes it from the page, otherwise as failed.
- **Fixed "Could not open the menu" failures:** the post menu button is now found by its test id, then its "More" label, then any menu-opening button that is not an action-bar button (so Repost is never clicked by mistake). Waits up to 8s for it to appear.
- **Delete item lookup** is more tolerant of menu markup and labels, and errors now list the menu items or buttons that were seen, to make future breakage easy to diagnose.

## 1.3.1
- **Worker-tab lock:** only the tab a job was started in runs it. Previously, opening or refreshing any other x.com tab mid-job would mark the current post "skipped" and/or yank that tab to your profile.
- **Honest verification:** a slow-loading page is no longer counted as a verified deletion; the verifier waits for the page to settle and reloads (up to 2x) if it never loads.
- **No aborted deletes:** after confirming, the script waits for X to actually remove the post before navigating, instead of a fixed 1.1s.
- **Rate-limit backoff:** error toasts from X trigger an exponential backoff (1→15 min, max 5 tries) instead of marking post after post as failed.
- **Exact ID matching:** `/status/123` no longer matches `/status/1234…`.
- **Delete menu lookup** is scoped to open menu items and recognises a few more languages.
- **Scanner** clicks X's "Retry" button when a timeline fails to load, and only rewrites storage when new IDs are found.
- **Archive import** skips reposts (they need "Undo repost", not Delete) and numeric IDs that lost precision, and reports both.
- Deep Clean resets counters at start; a crash during deletion no longer leaves "Deep Clean" stuck in the status; the confirm button no longer stays disabled on an early exit; Pause/Stop/Reset invalidate the running job immediately.
