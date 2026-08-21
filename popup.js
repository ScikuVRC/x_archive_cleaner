const $ = (id) => document.getElementById(id);

function cleanUsername(v) {
  return v.trim().replace(/^@/, "").toLowerCase();
}

function extractJsonArray(text) {
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first < 0 || last < first) throw new Error("No JSON array found");
  return JSON.parse(text.slice(first, last + 1));
}

function extractIds(arr) {
  const ids = [];
  for (const item of arr) {
    const t = item?.tweet ?? item?.post ?? item;
    const id = t?.id_str ?? t?.id;
    if (id && /^\d+$/.test(String(id))) ids.push(String(id));
  }
  return ids;
}

async function refresh() {
  const s = await chrome.storage.local.get([
    "username","queue","index","running","deleted","verified","skipped","failed","dryRun","delay"
  ]);
  if (s.username) $("username").value = s.username;
  if (s.delay) $("delay").value = s.delay;
  $("dryRun").checked = s.dryRun ?? true;

  const q = s.queue ?? [];
  const idx = s.index ?? 0;
  $("status").textContent =
    `Mode: ${(s.dryRun ?? true) ? "DRY RUN" : "DELETE"}\n` +
    `State: ${s.running ? "RUNNING" : "PAUSED"}\n` +
    `Imported: ${q.length}\n` +
    `Progress: ${Math.min(idx, q.length)} / ${q.length}\n` +
    `Deleted: ${s.deleted ?? 0}\n` +
    `Verified: ${s.verified ?? 0}\n` +
    `Skipped: ${s.skipped ?? 0}\n` +
    `Failed: ${s.failed ?? 0}`;
}

$("importBtn").addEventListener("click", async () => {
  const files = [...$("archiveFiles").files];
  if (!files.length) {
    alert("Choose tweets.js / posts.js (or archive part files) first.");
    return;
  }

  const allIds = [];
  for (const file of files) {
    const text = await file.text();
    try {
      const arr = extractJsonArray(text);
      allIds.push(...extractIds(arr));
    } catch (e) {
      console.warn("Could not parse", file.name, e);
    }
  }

  const unique = [...new Set(allIds)];
  if (!unique.length) {
    alert("No post IDs were found in the selected file(s).");
    return;
  }

  await chrome.storage.local.set({
    queue: unique,
    index: 0,
    running: false,
    deleted: 0,
    verified: 0,
    skipped: 0,
    failed: 0,
    lastError: ""
  });

  await refresh();
});

$("startBtn").addEventListener("click", async () => {
  const username = cleanUsername($("username").value);
  const delay = Math.max(1200, Math.min(15000, Number($("delay").value) || 2200));
  const dryRun = $("dryRun").checked;

  if (!username) {
    alert("Enter your current X username.");
    return;
  }

  const s = await chrome.storage.local.get(["queue","index"]);
  if (!s.queue?.length) {
    alert("Import your archive first.");
    return;
  }
  if ((s.index ?? 0) >= s.queue.length) {
    alert("The queue is already complete. Reset it if you want to run again.");
    return;
  }

  await chrome.storage.local.set({ username, delay, dryRun, running: true });

  const id = s.queue[s.index ?? 0];
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  if (!tab?.id) return;

  await chrome.tabs.update(tab.id, {url: `https://x.com/i/web/status/${id}`});
  window.close();
});

$("pauseBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({running:false});
  await refresh();
});

$("resetBtn").addEventListener("click", async () => {
  if (!confirm("Reset all imported IDs and progress?")) return;
  await chrome.storage.local.set({
    queue: [], index: 0, running:false, deleted:0, verified:0, skipped:0, failed:0, lastError:""
  });
  await refresh();
});

chrome.storage.onChanged.addListener(refresh);
refresh();
