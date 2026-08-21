(() => {
  if(window.__xArchiveCleanerPostsOnly) return;
  window.__xArchiveCleanerPostsOnly = true;

  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

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
      "accountId","username",
      "queue","index","running","deleted","skipped","failed",
      "scanActive","scanFound","scanStatus","scanPhase","scanCollected",
      "deepCleanActive","deepCleanPass","deepCleanMaxPasses",
      "verifyPending","verifyId","verifyAttempts"
    ]);
  }

  async function setState(patch){
    await chrome.storage.local.set(patch);
  }

  function accountMatches(expectedId){
    const live = accountIdFromSession();
    return !!live && live === expectedId;
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

  async function runPostScanner(){
    const initial = await getState();

    if(!initial.scanActive || !initial.accountId || !initial.username) return;

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

    const deep = !!initial.deepCleanActive;
    const pass = initial.deepCleanPass || 1;
    const maxPasses = initial.deepCleanMaxPasses || 3;
    const stagnantLimit = deep ? 22 : 14;
    const maxRounds = deep ? 520 : 380;

    await setState({
      scanStatus: deep
        ? `Deep Clean pass ${pass}/${maxPasses} · scanning ${phase === "posts" ? "Posts" : "Replies"}…`
        : `Scanning ${phase === "posts" ? "Posts" : "Replies"}…`,
      scanFound:collected.size,
      lastError:""
    });

    for(let round=0; round<maxRounds; round++){
      const live = await getState();
      if(!live.scanActive) return;

      for(const id of collectOwnStatusIds(initial.username)){
        phaseFound.add(id);
        collected.add(id);
      }

      stagnant = phaseFound.size === previous ? stagnant + 1 : 0;
      previous = phaseFound.size;

      await setState({
        scanCollected:[...collected],
        scanFound:collected.size,
        scanStatus: deep
          ? `Deep Clean pass ${pass}/${maxPasses} · ${phase === "posts" ? "Posts" : "Replies"}\n${phaseFound.size} this tab · ${collected.size} unique total`
          : `${phase === "posts" ? "Posts" : "Replies"} scan\n${phaseFound.size} this tab · ${collected.size} unique total`
      });

      if(stagnant >= stagnantLimit) break;

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

  function visibleText(el){
    return ((el?.innerText || el?.textContent || "") + "").trim();
  }

  function findClickableByText(patterns){
    for(const el of document.querySelectorAll(
      'button,[role="button"],[role="menuitem"],a'
    )){
      const text = visibleText(el);
      if(patterns.some(rx => rx.test(text))) return el;
    }

    return null;
  }

  async function waitForOwnArticle(username,id,timeout=15000){
    const start = Date.now();
    const wanted = `/${username.toLowerCase()}/status/${id}`;

    while(Date.now()-start < timeout){
      for(const article of document.querySelectorAll('article[data-testid="tweet"]')){
        const links = [...article.querySelectorAll('a[href*="/status/"]')];

        if(
          links.some(a =>
            (a.getAttribute("href") || "")
              .toLowerCase()
              .startsWith(wanted)
          )
        ){
          return article;
        }
      }

      await sleep(350);
    }

    return null;
  }

  async function advancePost(state,kind,error=""){
    const nextIndex = (state.index||0)+1;

    await setState({
      index:nextIndex,
      [kind]:(state[kind]||0)+1,
      verifyPending:false,
      verifyId:"",
      verifyAttempts:0,
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

    const cooldown = nextIndex > 0 && nextIndex % 25 === 0 ? 8000 : 0;
    const jitter = 2400 + Math.floor(Math.random()*1200);

    await sleep(cooldown+jitter);

    const live = await getState();
    if(!live.running) return;

    location.replace(
      `https://x.com/${state.username}/status/${state.queue[nextIndex]}`
    );
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
      await setState({
        running:false,
        deepCleanActive:false,
        verifyPending:false,
        verifyId:"",
        verifyAttempts:0,
        lastError:"Safety stop: logged-in X account changed or could not be verified."
      });

      alert("Archive Cleaner stopped because the logged-in X account could not be verified.");
      return;
    }

    const id = state.queue[state.index||0];
    if(!id){
      await setState({
        running:false,
        verifyPending:false,
        verifyId:"",
        verifyAttempts:0
      });
      return;
    }

    if(state.verifyPending && state.verifyId === id){
      const survivor = await waitForOwnArticle(state.username,id,6500);

      if(!survivor){
        await advancePost(state,"deleted","");
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
        lastError:`Post ${id} survived attempt ${attempts}; retrying…`
      });

      await sleep(800);
    }

    const liveState = await getState();
    if(!liveState.running) return;

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
      del = findClickableByText([
        /^delete$/i,
        /^delete post$/i,
        /^supprimer$/i,
        /^supprimer le post$/i,
        /^supprimer la publication$/i
      ]);

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

    const attempt = Math.min((liveState.verifyAttempts||0)+1,3);

    await setState({
      verifyPending:true,
      verifyId:id,
      verifyAttempts:attempt,
      lastError:`Verifying deletion of ${id} · attempt ${attempt}/3`
    });

    await sleep(1100);

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
      verifyPending:false,
      verifyId:"",
      verifyAttempts:0,
      failed:(s.failed||0)+1,
      lastError:`Deletion error: ${err?.message || err}`
    });
  });
})();