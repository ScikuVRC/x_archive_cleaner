# X Archive Cleaner v1.3 — Posts Only

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
5. Select the `x_archive_cleaner_v1_3_posts_only` folder.
6. Open X and press **Get Account**.

## Recommended full cleanup
For the most complete post cleanup:
1. Import your X archive and delete that queue.
2. Run **Scan Posts + Replies**.
3. Run **Deep Clean · Rescan + Verify** afterward.

Live profile scanning is limited to content X currently exposes in its profile timelines, so archive import remains the best source for very old posts.
