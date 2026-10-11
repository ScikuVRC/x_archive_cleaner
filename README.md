# X Archive Cleaner

A Chrome extension that bulk-deletes **your own** posts and replies on X (x.com), using your downloaded X archive or a live scan of your profile.

![Version](https://img.shields.io/badge/version-1.4.0-5b8cff) ![Manifest](https://img.shields.io/badge/manifest-v3-7c5cff) ![Privacy](https://img.shields.io/badge/data%20collected-none-2ea043)

![Popup](store_screenshots/screenshot4.png)

## Features

- **Archive import:** load `tweet.js` / `tweets.js` files from your official X data export, including common Community-post wrappers.
- **Live scan:** collects Posts and Replies from your profile timelines.
- **Automatic merging and de-duplication** of the queue.
- **Progress tracking:** Queued, Processed and Deleted counters with a live progress bar.
- **Controls:** Pause, Reset and Stop all.
- **Rate-limit back-off:** if X throws an error toast, the extension waits (1 to 15 minutes, up to 5 tries) instead of failing post after post.
- **Clear diagnostics:** when a post can't be deleted, the message says what was on screen.
- **Private:** everything runs locally. No servers, no analytics, no tracking. See the [privacy policy](privacy-policy.html).

## Install

The extension isn't loaded from a store here, so install it unpacked:

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the project folder.
4. Open [x.com](https://x.com) while logged in and open the extension popup.

If you have an older build installed, remove it first.

## Usage

1. On x.com, click the extension icon and press **Detect** to pick up your logged-in account.
2. Choose a source:
   - **Archive:** select your archive post files and press **Import archive**.
   - **Scan account:** press **Scan Posts + Replies**. The popup closes and the scan runs in the tab.
3. Press **Delete queued posts** and confirm.
4. Use **Pause**, **Reset** or **Stop all** at any time.

### Getting your archive

Request your data from X under *Settings → Your account → Download an archive of your data*. When it arrives, unzip it and select the post files from its `data` folder (`tweets.js` and any `tweets-partN.js`).

## How it works

The popup opens one tab at your post's URL with a private job token. The content script in that tab (and only that tab) finds the post, opens its "…" menu, clicks **Delete**, confirms, waits for X to remove the post from the page, then moves to the next one in the queue. A post counts as deleted when X removes it, and otherwise as failed. Reposts are skipped because they need "Undo repost", not Delete.

## Limitations

- **Deletion is permanent.** Deleted posts can't be restored.
- Live scanning only reaches what X currently shows in your profile timelines. Use an archive import for very old posts.
- Large queues are slow, and X may rate-limit the account.
- The extension drives X's web interface. If X changes its layout, deletion may break until the extension is updated.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Keeps the queue and progress locally so a run survives page loads. |
| `https://x.com/*`, `https://twitter.com/*` | Detect your account, scan your timelines and delete your posts. |

No remote code and no network requests of its own.

## Project layout

```
manifest.json     Extension manifest (MV3)
content.js        Runs on x.com: account detection, scanning, deletion
popup.html        Popup UI
popup.js          Popup logic and queue/state management
privacy-policy.html
store_screenshots/
CHANGELOG.md
```

## Disclaimer

X Archive Cleaner is an independent project and is not affiliated with, endorsed by, or sponsored by X Corp. Use it only on your own account and in line with X's terms. You are responsible for what you delete.
