(() => {
  if (window.__xArchiveCleanerLoaded) return;
  window.__xArchiveCleanerLoaded = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function state() {
    return chrome.storage.local.get([
      "username","queue","index","running","deleted","verified","skipped","failed","dryRun","delay"
    ]);
  }

  async function patch(obj) {
    await chrome.storage.local.set(obj);
  }

  function norm(s) {
    return (s || "").trim().toLowerCase();
  }

  function expectedStatusId(s) {
    return s.queue?.[s.index ?? 0];
  }

  async function waitForTweet(expectedId, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
      for (const article of articles) {
        const statusLinks = [...article.querySelectorAll('a[href*="/status/"]')];
        if (statusLinks.some(a => a.getAttribute("href")?.includes(`/status/${expectedId}`))) {
          return article;
        }
      }
      await sleep(400);
    }
    return null;
  }

  function articleBelongsToUsername(article, username, expectedId) {
    const u = norm(username);
    const links = [...article.querySelectorAll("a[href]")];
    return links.some(a => {
      const href = a.getAttribute("href") || "";
      return href.toLowerCase() === `/${u}` ||
             href.toLowerCase().startsWith(`/${u}/status/${expectedId}`);
    });
  }

  async function waitForMenu(timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const items = [...document.querySelectorAll('[role="menuitem"]')];
      if (items.length) return items;
      await sleep(150);
    }
    return [];
  }

  function findDeleteMenuItem(items) {
    const patterns = [
      /^delete$/i,
      /^delete post$/i,
      /^supprimer$/i,
      /^supprimer le post$/i,
      /^supprimer la publication$/i
    ];
    return items.find(el => {
      const t = (el.innerText || el.textContent || "").trim();
      return patterns.some(rx => rx.test(t));
    });
  }

  async function waitForConfirm(timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const btn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
      if (btn) return btn;
      await sleep(150);
    }
    return null;
  }

  async function advance(s, kind, error = "") {
    const updates = {
      index: (s.index ?? 0) + 1,
      lastError: error
    };
    updates[kind] = (s[kind] ?? 0) + 1;
    await patch(updates);

    const nextIndex = updates.index;
    if (nextIndex >= s.queue.length) {
      await patch({running:false});
      alert(`X Archive Cleaner finished.\nDeleted: ${kind === "deleted" ? (s.deleted ?? 0) + 1 : (s.deleted ?? 0)}\nSkipped: ${kind === "skipped" ? (s.skipped ?? 0) + 1 : (s.skipped ?? 0)}\nFailed: ${kind === "failed" ? (s.failed ?? 0) + 1 : (s.failed ?? 0)}`);
      return;
    }

    await sleep(s.delay ?? 2200);
    location.href = `https://x.com/i/web/status/${s.queue[nextIndex]}`;
  }

  async function run() {
    await sleep(800);
    const s = await state();
    if (!s.running || !s.queue?.length || !s.username) return;

    const id = expectedStatusId(s);
    if (!id) {
      await patch({running:false});
      return;
    }

    const article = await waitForTweet(id);
    if (!article) {
      // Deleted already, unavailable, or failed to load.
      await advance(s, "skipped", `Post ${id} was not found or is unavailable.`);
      return;
    }

    if (!articleBelongsToUsername(article, s.username, id)) {
      await patch({running:false, lastError:`Safety stop: post ${id} does not appear to belong to @${s.username}.`});
      alert(`Safety stop.\nPost ${id} did not appear to belong to @${s.username}.\nNothing was deleted.`);
      return;
    }

    if (s.dryRun) {
      await advance(s, "verified");
      return;
    }

    const caret = article.querySelector('button[data-testid="caret"]');
    if (!caret) {
      await advance(s, "failed", `Could not find menu button for ${id}.`);
      return;
    }

    caret.click();
    await sleep(250);

    const items = await waitForMenu();
    const del = findDeleteMenuItem(items);
    if (!del) {
      // Often means this is a repost or X changed menu wording/DOM.
      document.body.click();
      await advance(s, "skipped", `No Delete option found for ${id}. It may be a repost or X changed its UI.`);
      return;
    }

    del.click();
    const confirm = await waitForConfirm();
    if (!confirm) {
      await advance(s, "failed", `Delete confirmation did not appear for ${id}.`);
      return;
    }

    confirm.click();
    await sleep(700);
    await advance(s, "deleted");
  }

  run().catch(async (err) => {
    console.error("X Archive Cleaner", err);
    const s = await state();
    await patch({
      running:false,
      failed:(s.failed ?? 0) + 1,
      lastError:String(err?.message || err)
    });
    alert("X Archive Cleaner paused because of an unexpected error. Open the extension popup for status.");
  });
})();
