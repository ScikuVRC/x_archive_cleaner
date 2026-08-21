# X Archive Cleaner v1.2 — Verified Deep Clean

This build adds a Direct Message cleaner to the existing post/reply cleaner.

## Posts Cleaner
Two sources are available:
- **Archive**: import X archive `.js` / `.json` post files.
- **Scan Account**: scan your live Posts & Replies timeline for post IDs X currently exposes.

Deletion still uses X's visible web interface rather than a hard-coded private DeleteTweet GraphQL endpoint.

## DM Cleaner
1. Open X and press **Get Account**.
2. Open the **DM Cleaner** tab.
3. Press **Scan DM Inbox**.
4. The extension opens `x.com/messages`, scrolls the inbox, and queues unique conversation URLs.
5. Re-open the extension and review the count.
6. Press **Remove Queued Conversations**.
7. Confirm with **I'm sure**.

The cleaner then opens each queued conversation, opens Conversation Info, looks for **Delete conversation** or **Leave conversation**, confirms the action, and continues.

### Important DM behavior
Removing a Direct Message or conversation from X removes it from your account only. Other participants may still be able to see their copies. Removing a group conversation can also cause you to leave that group.

## Safety
- The logged-in numeric X account ID is automatically detected.
- The account ID is checked again before scanning and destructive actions.
- Post deletion and DM removal have separate queues and separate confirmation flows.
- Progress is stored locally in `chrome.storage.local`.
- Both cleaners can be paused/reset separately.

## Install / update
1. Unzip the package.
2. Go to `chrome://extensions`.
3. Enable Developer mode.
4. Remove/reload the old unpacked extension.
5. Choose **Load unpacked** and select the `x_archive_cleaner_v1_1_dm` folder.
6. Open x.com while logged into the correct account.
7. Press **Get Account** before using either cleaner.

## Limitations
- X may change its web UI, selectors, or wording at any time.
- DM scanning discovers conversations currently exposed through the web inbox.
- Message Requests may not appear in the normal inbox scan.
- DM removal uses visible Delete/Leave Conversation controls and does not promise to erase recipients' copies.
- Keep the X tab open while scanning or deleting.


## v1.1.1 stability hotfix
- Clears the active job flag before leaving the last deleted post/conversation.
- After post cleanup, returns to `https://x.com/home`.
- After DM cleanup, returns to `https://x.com/messages` instead of remaining on a deleted conversation URL.
- Detects stale completed queues on page load and refuses to resume them.
- Adds **Stop All Automation** to immediately clear post scanning, post deletion, DM scanning, and DM deletion flags.
- Re-checks the running flag after each inter-item delay so Pause/Stop All takes effect before another navigation.
- Slows navigation slightly and adds periodic cooldowns during large cleanups.


## v1.2 Verified Deletion
A Delete click is no longer treated as success by itself.

For every queued post the cleaner now:
1. Opens the exact status URL.
2. Uses X's visible Delete → Confirm flow.
3. Stores a verification checkpoint.
4. Reloads that exact status URL.
5. Checks whether the post authored by the detected username still renders.
6. If it still exists, retries deletion.
7. Only increments **Deleted** after the post is confirmed absent.
8. Gives up after 3 verified attempts and records the post as failed instead of falsely reporting success.

## Deep Clean
The **Deep Clean · Rescan + Verify** button runs up to 3 passes.

Each pass:
- Performs a slower, deeper Posts & Replies scan.
- Uses all visible `/status/` links for the detected username instead of relying only on one tweet-article wrapper.
- Queues surviving posts.
- Deletes each survivor with verification and up to 3 attempts.
- Rescans the timeline after the queue is processed so posts newly exposed by X's virtualized/truncated timeline can be caught.

Deep Clean finishes early if a rescan finds zero surviving posts.

## Important X limitation
The live profile scan is not equivalent to the full account archive. X limits what is displayed in profile timelines, and timeline/indexing behavior can be inconsistent after mass deletion. For the most complete historical cleanup, import the X archive first, run its queue, then use Deep Clean as the final live-profile verification pass.
