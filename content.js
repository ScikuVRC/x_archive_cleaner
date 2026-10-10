(() => {
  if(window.__xArchiveCleanerPostsOnly) return;
  window.__xArchiveCleanerPostsOnly = true;

  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

  // ---------------------------------------------------------------------------
  // Worker-tab lock
  // The popup starts every job by navigating ONE tab to a URL carrying
  // ?xac_job=<token>. That tab remembers the token in sessionStorage (which
  // survives the location.replace() navigations below). Any other x.com tab the
  // user opens or refreshes while a job runs stays passive instead of
  // hijacking the queue.
  // ---------------------------------------------------------------------------
  const JOB_PARAM = "xac_job";
  const JOB_KEY = "xacJob";

  try{
    const job = new URL(location.href).searchParams.get(JOB_PARAM);
    if(job) sessionStorage.setItem(JOB_KEY,job);
  }catch{}

  function isWorker(state){
    try{
      return !!state.jobId && sessionStorage.getItem(JOB_KEY) === state.jobId;
    }catch{
      return false;
    }
  }

  function readCookie(name){
    const item = document.cookie.split("; ").find(v => v.startsWith(name + "="));
    return item ? item.slice(name.length + 1) : null;
  }

  function accountIdFromSession(){
    const raw = readCookie("twid");
    if(!raw) return null;

    let value = raw;
    try{ value = decodeURIComponent(raw); }catch{}

    const match = value.match(/u=(\d+)/) || value.match(/(\d{5,})/);
    return match?.[1] || null;
  }

  function usernameFromProfileLink(){
    const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const href = profile?.getAttribute("href") || "";
    const match = href.match(/^\/([^/?#]+)$/);

    if(
      match &&
      !["home","explore","notifications","messages","i"].includes(match[1].toLowerCase())
    ){
      return match[1];
    }

    return null;
  }

  chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
    if(message?.cmd !== "detect-account") return;

    const accountId = accountIdFromSession();
    const username = usernameFromProfileLink();

    sendResponse(
      accountId
        ? {accountId,username}
        : {error:"No logged-in X session detected"}
    );
  });

  async function getState(){
    return chrome.storage.local.get([
      "accountId","username","jobId",
      "queue","index","running","deleted","skipped","failed",
      "scanActive","scanFound","scanStatus","scanPhase","scanCollected",
      "deepCleanActive","deepCleanPass","deepCleanMaxPasses",
      "verifyPending","verifyId","verifyAttempts","verifyReloads",
      "rateLimitHits"
    ]);
  }

  // Cheap read used inside polling loops (avoids pulling the whole queue).
  async function getFlags(){
    return chrome.storage.local.get(["running","scanActive","jobId"]);
  }

  async function setState(patch){
    await chrome.storage.local.set(patch);
  }

  function accountMatches(expectedId){
    const live = accountIdFromSession();
    return !!live && live === expectedId;
  }

  function escapeRx(s){
    return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  }

  // Exact match on /<user>/status/<id> followed by a boundary, so ID 123 can
  // never match /user/status/1234...
  function statusHrefRx(username,id){
    return new RegExp(`^/${escapeRx(username)}/status/${id}(?:[/?#]|$)`,"i");
  }

  function collectOwnStatusIds(username){
    const ids = new Set();
    const wanted = username.toLowerCase();

    for(const a of document.querySelectorAll('a[href*="/status/"]')){
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/([^/]+)\/status\/(\d+)/);

      if(m && m[1].toLowerCase() === wanted){
        ids.add(m[2]);
      }
    }

    return ids;
  }

  function expectedScanPath(username,phase){
    return phase === "replies"
      ? `/${username.toLowerCase()}/with_replies`
      : `/${username.toLowerCase()}`;
  }

  function phaseUrl(username,phase){
    return phase === "replies"
      ? `https://x.com/${username}/with_replies`
      : `https://x.com/${username}`;
  }

  function visibleText(el){
    return ((el?.innerText || el?.textContent || "") + "").trim();
  }

  // X shows a "Retry" button when a timeline page fails to load. Without
  // clicking it the scanner sees no new IDs and quits early.
  function clickTimelineRetry(){
    const col = document.querySelector('[data-testid="primaryColumn"]') || document;
    for(const el of col.querySelectorAll('button,[role="button"]')){
      if(/^(retry|réessayer|reintentar|erneut versuchen|tentar novamente|riprova)$/i.test(visibleText(el))){
        el.click();
        return true;
      }
    }
    return false;
  }

  async function runPostScanner(){
    const initial = await getState();

    if(!initial.scanActive || !initial.accountId || !initial.username) return;
    if(!isWorker(initial)) return;

    if(!accountMatches(initial.accountId)){
      await setState({
        scanActive:false,
        deepCleanActive:false,
        scanStatus:"Scan stopped",
        lastError:"Safety stop: logged-in X account could not be verified."
      });
      return;
    }

    const phase = initial.scanPhase || "posts";
    const expected = expectedScanPath(initial.username,phase);
    const path = location.pathname.toLowerCase();

    const pathOkay = phase === "posts"
      ? path === expected || path === `${expected}/`
      : path.startsWith(expected);

    if(!pathOkay){
      location.replace(phaseUrl(initial.username,phase));
      return;
    }

    const collected = new Set(initial.scanCollected || []);
    const phaseFound = new Set();

    let stagnant = 0;
    let previous = 0;
    let lastWrittenSize = -1;

    const deep = !!initial.deepCleanActive;
    const pass = initial.deepCleanPass || 1;
    const maxPasses = initial.deepCleanMaxPasses || 3;
    const stagnantLimit = deep ? 22 : 14;
    const maxRounds = deep ? 520 : 380;
    const label = phase === "posts" ? "Posts" : "Replies";

    await setState({
      scanStatus: deep
        ? `Deep Clean pass ${pass}/${maxPasses} · scanning ${label}…`
        : `Scanning ${label}…`,
      scanFound:collected.size,
      lastError:""
    });

    for(let round=0; round<maxRounds; round++){
      const live = await getFlags();
      if(!live.scanActive || live.jobId !== initial.jobId) return;

      for(const id of collectOwnStatusIds(initial.username)){
        phaseFound.add(id);
        collected.add(id);
      }

      stagnant = phaseFound.size === previous ? stagnant + 1 : 0;
      previous = phaseFound.size;

      // Only rewrite the (potentially large) ID array when it actually grew.
      if(collected.size !== lastWrittenSize){
        lastWrittenSize = collected.size;
        await setState({
          scanCollected:[...collected],
          scanFound:collected.size,
          scanStatus: deep
            ? `Deep Clean pass ${pass}/${maxPasses} · ${label}\n${phaseFound.size} this tab · ${collected.size} unique total`
            : `${label} scan\n${phaseFound.size} this tab · ${collected.size} unique total`
        });
      }

      if(stagnant >= stagnantLimit) break;

      // If X shows its "Something went wrong · Retry" block, click it and
      // give the timeline a fresh chance instead of counting toward stagnation.
      if(stagnant >= 3 && clickTimelineRetry()){
        stagnant = 0;
        await sleep(2500);
        continue;
      }

      window.scrollBy({
        top:Math.max(window.innerHeight * 0.9,700),
        behavior:"smooth"
      });

      await sleep(deep ? 700 : 450);

      window.scrollTo({
        top:document.documentElement.scrollHeight,
        behavior:"smooth"
      });

      await sleep(deep ? 850 : 650);
    }

    if(phase === "posts"){
      await setState({
        scanPhase:"replies",
        scanCollected:[...collected],
        scanFound:collected.size,
        scanStatus: deep
          ? `Deep Clean pass ${pass}/${maxPasses} · opening Replies…`
          : `Posts complete · opening Replies…`
      });

      await sleep(500);
      location.replace(phaseUrl(initial.username,"replies"));
      return;
    }

    const queue = [...collected];

    if(deep){
      if(queue.length === 0){
        await setState({
          queue:[],
          index:0,
          scanActive:false,
          running:false,
          deepCleanActive:false,
          scanPhase:"",
          scanCollected:[],
          verifyPending:false,
          verifyId:"",
          verifyAttempts:0,
          verifyReloads:0,
          scanFound:0,
          scanStatus:`Deep Clean complete · no surviving posts found after pass ${pass}`,
          lastError:"Deep Clean completed successfully."
        });

        await sleep(500);
        location.replace("https://x.com/home");
        return;
      }

      await setState({
        queue,
        index:0,
        scanActive:false,
        scanPhase:"",
        scanCollected:[],
        running:true,
        scanFound:queue.length,
        scanStatus:`Deep Clean pass ${pass}/${maxPasses} · ${queue.length} survivors queued`,
        verifyPending:false,
        verifyId:"",
        verifyAttempts:0,
        verifyReloads:0,
        lastError:""
      });

      await sleep(600);
      location.replace(`https://x.com/${initial.username}/status/${queue[0]}`);
      return;
    }

    await setState({
      queue,
      index:0,
      scanActive:false,
      scanPhase:"",
      scanCollected:[],
      scanFound:queue.length,
      scanStatus:`Scan complete · ${queue.length} unique Posts + Replies IDs queued`,
      running:false,
      deleted:0,
      skipped:0,
      failed:0,
      lastError:queue.length
        ? ""
        : "No posts or replies were found in the currently exposed profile timelines."
    });
  }

  async function waitFor(selector,timeout=5000){
    const start = Date.now();

    while(Date.now()-start < timeout){
      const el = document.querySelector(selector);
      if(el) return el;
      await sleep(140);
    }

    return null;
  }

  // Only look inside open menus — the old version scanned every button and
  // link on the page, which was slower and could match tweet text.
  const DELETE_LABELS = [
    /^delete$/i, /^delete post$/i,
    /^supprimer$/i, /^supprimer le post$/i, /^supprimer la publication$/i,
    /^eliminar$/i, /^löschen$/i, /^excluir$/i, /^elimina$/i, /^削除$/
  ];

  function findDeleteMenuItem(){
    for(const el of document.querySelectorAll('[role="menuitem"]')){
      const text = visibleText(el);
      if(DELETE_LABELS.some(rx => rx.test(text))) return el;
    }
    return null;
  }

  function findOwnArticle(username,id){
    const rx = statusHrefRx(username,id);

    for(const article of document.querySelectorAll('article[data-testid="tweet"]')){
      for(const a of article.querySelectorAll('a[href*="/status/"]')){
        if(rx.test(a.getAttribute("href") || "")) return article;
      }
    }

    return null;
  }

  async function waitForOwnArticle(username,id,timeout=15000){
    const start = Date.now();

    while(Date.now()-start < timeout){
      const article = findOwnArticle(username,id);
      if(article) return article;
      await sleep(300);
    }

    return null;
  }

  // Decide whether a post survived, based on the page actually having loaded
  // rather than a fixed 6.5s timer. A slow page load used to be counted as a
  // "verified deletion".
  async function waitForVerifyOutcome(username,id,timeout=15000){
    const start = Date.now();
    let quietSince = 0;

    while(Date.now()-start < timeout){
      if(findOwnArticle(username,id)) return "survived";

      const col = document.querySelector('[data-testid="primaryColumn"]');
      const elapsed = Date.now()-start;

      if(col){
        const errorShown = !!col.querySelector('[data-testid="error-detail"]');
        const otherContent = !!col.querySelector("article");
        const spinning = !!col.querySelector('[role="progressbar"]');

        if(!spinning){
          if(!quietSince) quietSince = Date.now();
        }else{
          quietSince = 0;
        }

        const settled = errorShown || otherContent || (quietSince && Date.now()-quietSince >= 2500);
        if(settled && elapsed >= 3000) return "gone";
      }

      await sleep(250);
    }

    // Column rendered but never clearly settled: fall back to the old
    // assumption, but only after a much longer wait.
    return document.querySelector('[data-testid="primaryColumn"]') ? "gone" : "unknown";
  }

  const ERROR_TOAST_RX = /rate limit|try again|something went wrong|went wrong|error|réessayer|erreur/i;

  // After clicking confirm, wait for X to actually finish the delete before
  // navigating away. Navigating after a fixed 1.1s could abort the request.
  async function waitForDeleteOutcome(username,id,article,timeout=10000){
    const start = Date.now();

    while(Date.now()-start < timeout){
      const toast = document.querySelector('[data-testid="toast"]');
      const toastText = visibleText(toast);

      if(toastText && ERROR_TOAST_RX.test(toastText)){
        return {status:"error",text:toastText};
      }

      if(!article.isConnected || !findOwnArticle(username,id)){
        // Give the request a moment to settle before the page is unloaded.
        await sleep(400);
        return {status:"removed"};
      }

      await sleep(200);
    }

    return {status:"unknown"};
  }

  // Sleep in small slices so Pause / Stop take effect quickly.
  async function interruptibleSleep(ms,jobId){
    const end = Date.now()+ms;
    while(Date.now() < end){
      await sleep(Math.min(5000,end-Date.now()));
      const f = await getFlags();
      if(!f.running || f.jobId !== jobId) return false;
    }
    return true;
  }

  async function advancePost(state,kind,error=""){
    const nextIndex = (state.index||0)+1;

    await setState({
      index:nextIndex,
      [kind]:(state[kind]||0)+1,
      verifyPending:false,
      verifyId:"",
      verifyAttempts:0,
      verifyReloads:0,
      rateLimitHits:0,
      lastError:error
    });

    if(nextIndex >= state.queue.length){
      if(state.deepCleanActive){
        const pass = state.deepCleanPass || 1;
        const maxPasses = state.deepCleanMaxPasses || 3;

        if(pass < maxPasses){
          const nextPass = pass + 1;

          await setState({
            running:false,
            scanActive:true,
            scanPhase:"posts",
            scanCollected:[],
            deepCleanActive:true,
            deepCleanPass:nextPass,
            scanFound:0,
            scanStatus:`Deep Clean pass ${nextPass}/${maxPasses} · rescanning Posts…`,
            queue:[],
            index:0,
            lastError:error
          });

          await sleep(650);
          location.replace(`https://x.com/${state.username}`);
          return;
        }

        await setState({
          running:false,
          scanActive:false,
          deepCleanActive:false,
          scanPhase:"",
          scanCollected:[],
          verifyPending:false,
          verifyId:"",
          verifyAttempts:0,
          lastError:error || `Deep Clean completed after ${maxPasses} passes.`
        });

        await sleep(500);
        location.replace("https://x.com/home");
        return;
      }

      await setState({
        running:false,
        scanActive:false,
        verifyPending:false,
        verifyId:"",
        verifyAttempts:0,
        lastError:error || "Post cleanup completed."
      });

      await sleep(450);
      location.replace("https://x.com/home");
      return;
    }

    const cooldown = nextIndex % 25 === 0 ? 8000 : 0;
    const jitter = 2400 + Math.floor(Math.random()*1200);

    if(!await interruptibleSleep(cooldown+jitter,state.jobId)) return;

    location.replace(
      `https://x.com/${state.username}/status/${state.queue[nextIndex]}`
    );
  }

  async function stopDeletion(lastError){
    await setState({
      running:false,
      deepCleanActive:false,
      verifyPending:false,
      verifyId:"",
      verifyAttempts:0,
      verifyReloads:0,
      rateLimitHits:0,
      lastError
    });
  }

  async function runPostDeletion(){
    await sleep(700);

    const state = await getState();

    if(
      !state.running ||
      !state.queue?.length ||
      !state.username ||
      !state.accountId
    ) return;

    if(!isWorker(state)) return;

    if((state.index||0) >= state.queue.length){
      await setState({
        running:false,
        verifyPending:false,
        verifyId:"",
        verifyAttempts:0,
        lastError:"Post cleanup completed."
      });
      return;
    }

    if(!accountMatches(state.accountId)){
      await stopDeletion("Safety stop: logged-in X account changed or could not be verified.");
      alert("Archive Cleaner stopped because the logged-in X account could not be verified.");
      return;
    }

    const id = state.queue[state.index||0];
    if(!id){
      await stopDeletion("");
      return;
    }

    if(state.verifyPending && state.verifyId === id){
      const outcome = await waitForVerifyOutcome(state.username,id);

      if(outcome === "gone"){
        await advancePost(state,"deleted","");
        return;
      }

      if(outcome === "unknown"){
        const reloads = (state.verifyReloads||0)+1;

        if(reloads > 2){
          await advancePost(state,"failed",`Could not confirm whether ${id} was deleted (page never loaded).`);
          return;
        }

        await setState({
          verifyReloads:reloads,
          lastError:`Verification page for ${id} did not load; reloading (${reloads}/2)…`
        });
        await sleep(1500);
        location.replace(`https://x.com/${state.username}/status/${id}?xac_verify=r${reloads}&t=${Date.now()}`);
        return;
      }

      const attempts = state.verifyAttempts || 1;

      if(attempts >= 3){
        await advancePost(
          state,
          "failed",
          `Post ${id} still exists after ${attempts} verified deletion attempts.`
        );
        return;
      }

      await setState({
        verifyPending:false,
        verifyId:"",
        verifyAttempts:attempts,
        verifyReloads:0,
        lastError:`Post ${id} survived attempt ${attempts}; retrying…`
      });

      await sleep(800);
    }

    const liveState = await getState();
    if(!liveState.running || !isWorker(liveState)) return;

    const article = await waitForOwnArticle(liveState.username,id,12000);

    if(!article){
      await advancePost(
        liveState,
        "skipped",
        `Post ${id} was unavailable or already deleted.`
      );
      return;
    }

    const menu = article.querySelector('button[data-testid="caret"]');

    if(!menu){
      await advancePost(
        liveState,
        "failed",
        `Could not open the menu for ${id}.`
      );
      return;
    }

    menu.click();
    await sleep(260);

    let del = null;
    const menuStart = Date.now();

    while(Date.now()-menuStart < 6000 && !del){
      del = findDeleteMenuItem();
      if(!del) await sleep(160);
    }

    if(!del){
      document.body.click();
      await advancePost(
        liveState,
        "failed",
        `No Delete action was available for ${id}.`
      );
      return;
    }

    del.click();

    const confirm = await waitFor(
      '[data-testid="confirmationSheetConfirm"]',
      6000
    );

    if(!confirm){
      await advancePost(
        liveState,
        "failed",
        `Delete confirmation did not appear for ${id}.`
      );
      return;
    }

    confirm.click();

    const result = await waitForDeleteOutcome(liveState.username,id,article);

    if(result.status === "error"){
      // X refused the delete (usually rate limiting). Back off and retry the
      // same post instead of burning through the queue marking failures.
      const hits = (liveState.rateLimitHits||0)+1;

      if(hits > 5){
        await stopDeletion(`Stopped: X kept rejecting deletes ("${result.text}"). Try again later.`);
        return;
      }

      const waitMs = Math.min(60000 * 2 ** (hits-1),15*60000);

      await setState({
        rateLimitHits:hits,
        verifyPending:false,
        verifyId:"",
        lastError:`X rejected the delete ("${result.text}"). Backing off ${Math.round(waitMs/60000)} min (${hits}/5)…`
      });

      if(!await interruptibleSleep(waitMs,liveState.jobId)) return;

      location.replace(`https://x.com/${liveState.username}/status/${id}?t=${Date.now()}`);
      return;
    }

    const attempt = Math.min((liveState.verifyAttempts||0)+1,3);

    await setState({
      verifyPending:true,
      verifyId:id,
      verifyAttempts:attempt,
      verifyReloads:0,
      lastError:`Verifying deletion of ${id} · attempt ${attempt}/3`
    });

    await sleep(result.status === "removed" ? 300 : 1100);

    location.replace(
      `https://x.com/${liveState.username}/status/${id}?xac_verify=${attempt}&t=${Date.now()}`
    );
  }

  runPostScanner().catch(async err => {
    await setState({
      scanActive:false,
      deepCleanActive:false,
      scanPhase:"",
      scanCollected:[],
      scanStatus:"Scan stopped",
      lastError:`Scan error: ${err?.message || err}`
    });
  });

  runPostDeletion().catch(async err => {
    const s = await getState();

    await setState({
      running:false,
      deepCleanActive:false,
      verifyPending:false,
      verifyId:"",
      verifyAttempts:0,
      verifyReloads:0,
      failed:(s.failed||0)+1,
      lastError:`Deletion error: ${err?.message || err}`
    });
  });
})();
