# X Archive Cleaner

A local Chrome Manifest V3 extension that deletes your own X posts one-by-one using the normal X web UI.

## Why archive-driven?
X profile timelines do not expose unlimited history. Importing your X archive lets the extension work from your archived post IDs instead of relying on endless profile scrolling.

## Install
1. Unzip this folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `x_archive_cleaner` folder.

## Get your X archive
On X:
Settings and privacy → Your account → Download an archive of your data.

When the archive arrives, unzip it and locate the JavaScript/JSON file(s) containing your posts, commonly under a `data` folder with a name such as `tweets.js`.

## Use
1. Log into X in Chrome.
2. Open the extension.
3. Enter your CURRENT X username.
4. Select the archive post file(s).
5. Click **Import archive**.
6. Leave **Dry run** enabled first and click **Start / Resume**.
7. Let it verify some or all IDs.
8. To actually delete, turn Dry run off, reset/re-import if needed, then start again.

## Safety
- It verifies that the rendered post belongs to the username you entered before deleting.
- It only uses X's own visible delete controls.
- It stores the queue/progress locally in chrome.storage.local.
- Pause at any time from the popup.

## Limitations
- X can rate-limit or alter its DOM; the extension may need selector updates.
- Reposts may be skipped because their action is usually "Undo repost", not "Delete".
- Already-deleted/unavailable posts are skipped.
- If your X UI is not English or French, add your localized "Delete" menu wording in `findDeleteMenuItem()` in `content.js`.
- Keep the active X tab open while it runs.
