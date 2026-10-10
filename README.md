# X Archive Cleaner v1.3.1 — Posts Only

This version removes the Direct Message / X Chat scanner and cleaner entirely.

## Included
- Automatic logged-in X account detection.
- Archive import.
- Common Community-post archive wrappers.
- Live account scanning.
- Separate Posts and Replies scan phases.
- Automatic merging and de-duplication.
- Verified deletion.
- Up to 3 deletion retries when a post survives.
- Deep Clean with up to 3 Posts + Replies rescans.
- Pause, Reset, and Stop All Automation controls.

## Removed
All Direct Message functionality has been removed:
- No DM Scanner.
- No X Chat scanner.
- No `/messages` handling.
- No `/i/chat` handling.
- No DM conversation queue.
- No DM deletion.
- No DM redirect/navigation logic.
- No persistent DM scan state.

The content script now only reacts to post scanning and post deletion jobs.

## Install
1. Remove/disable the older Archive Cleaner build in `chrome://extensions`.
2. Unzip this package.
3. Enable Developer mode.
4. Click **Load unpacked**.
5. Select the `x_archive_cleaner_v1_3_1` folder.
6. Open X and press **Get Account**.

## Recommended full cleanup
For the most complete post cleanup:
1. Import your X archive and delete that queue.
2. Run **Scan Posts + Replies**.
3. Run **Deep Clean · Rescan + Verify** afterward.

Live profile scanning is limited to content X currently exposes in its profile timelines, so archive import remains the best source for very old posts.

## Changes in 1.3.1
- **Worker-tab lock:** only the tab a job was started in runs it. Previously, opening or refreshing any other x.com tab mid-job would mark the current post "skipped" and/or yank that tab to your profile.
- **Honest verification:** a slow-loading page is no longer counted as a verified deletion; the verifier waits for the page to settle and reloads (up to 2x) if it never loads.
- **No aborted deletes:** after confirming, the script waits for X to actually remove the post before navigating, instead of a fixed 1.1s.
- **Rate-limit backoff:** error toasts from X trigger an exponential backoff (1→15 min, max 5 tries) instead of marking post after post as failed.
- **Exact ID matching:** `/status/123` no longer matches `/status/1234…`.
- **Delete menu lookup** is scoped to open menu items and recognises a few more languages.
- **Scanner** clicks X's "Retry" button when a timeline fails to load, and only rewrites storage when new IDs are found.
- **Archive import** skips reposts (they need "Undo repost", not Delete) and numeric IDs that lost precision, and reports both.
- Deep Clean resets counters at start; a crash during deletion no longer leaves "Deep Clean" stuck in the status; the confirm button no longer stays disabled on an early exit; Pause/Stop/Reset invalidate the running job immediately.
