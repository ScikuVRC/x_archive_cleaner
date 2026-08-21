(() => {
  if(window.__xArchiveCleanerV11) return;
  window.__xArchiveCleanerV11 = true;

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
    if(match && !["home","explore","notifications","messages","i"].includes(match[1].toLowerCase())){
      return match[1];
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
    if(message?.cmd !== "detect-account") return;
    const accountId = accountIdFromSession();
    const username = usernameFromProfileLink();
    sendResponse(accountId ? {accountId,username} : {error:"No logged-in X session detected"});
  });

  async function getState(){
    return chrome.storage.local.get([
      "accountId","username",
      "queue","index","running","deleted","skipped","failed","scanActive",
      "scanFound","scanStatus","deepCleanActive","deepCleanPass","deepCleanMaxPasses",
      "verifyPending","verifyId","verifyAttempts",
      "dmQueue","dmIndex","dmRunning","dmDeleted","dmSkipped","dmFailed","dmScanActive"
    ]);
  }

  async function setState(patch){ await chrome.storage.local.set(patch); }

  function accountMatches(expectedId){
    const live = accountIdFromSession();
    return !!live && live === expectedId;
  }

  // ---------- post scanner ----------
  function collectOwnStatusIds(username){
    const ids = new Set();
    const wanted = username.toLowerCase();

    // Search every visible status link, not only links nested under the tweet
    // article selector. X sometimes changes or virtualizes article wrappers.
    for(const a of document.querySelectorAll('a[href*="/status/"]')){
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
      if(m && m[1].toLowerCase() === wanted) ids.add(m[2]);
    }
    return ids;
  }

  async function runPostScanner(){
    const initial = await getState();
    if(!initial.scanActive || !initial.accountId || !initial.username) return;

    if(!accountMatches(initial.accountId)){
      await setState({
        scanActive:false,deepCleanActive:false,
        scanStatus:"Scan stopped",
        lastError:"Safety stop: logged-in X account could not be verified."
      });
      return;
    }

    const expected = `/${initial.username.toLowerCase()}/with_replies`;
    if(!location.pathname.toLowerCase().startsWith(expected)){
      location.replace(`https://x.com/${initial.username}/with_replies`);
      return;
    }

    const found = new Set();
    let stagnant = 0;
    let previous = 0;
    const deep = !!initial.deepCleanActive;
    const pass = initial.deepCleanPass || 1;
    const maxPasses = initial.deepCleanMaxPasses || 3;
    const stagnantLimit = deep ? 22 : 14;
    const maxRounds = deep ? 520 : 380;

    await setState({
      scanStatus: deep
        ? `Deep Clean pass ${pass}/${maxPasses} · scanning Posts & Replies…`
        : "Scanning Posts & Replies…",
      scanFound:0,
      lastError:""
    });

    for(let round=0; round<maxRounds; round++){
      const live = await getState();
      if(!live.scanActive) return;

      for(const id of collectOwnStatusIds(initial.username)) found.add(id);

      stagnant = found.size === previous ? stagnant + 1 : 0;
      previous = found.size;

      await setState({
        scanFound:found.size,
        scanStatus: deep
          ? `Deep Clean pass ${pass}/${maxPasses} · scanning…\n${found.size} surviving post IDs found`
          : `Scanning Posts & Replies…\n${found.size} unique post IDs found`
      });

      if(stagnant >= stagnantLimit) break;

      // Scroll in two steps. This is slower than the normal scanner but gives
      // X's virtualized timeline more opportunities to materialize posts.
      window.scrollBy({top:Math.max(window.innerHeight * 0.9, 700),behavior:"smooth"});
      await sleep(deep ? 700 : 450);
      window.scrollTo({top:document.documentElement.scrollHeight,behavior:"smooth"});
      await sleep(deep ? 850 : 650);
    }

    if(deep){
      if(found.size === 0){
        await setState({
          queue:[],index:0,scanActive:false,running:false,
          deepCleanActive:false,verifyPending:false,verifyId:"",verifyAttempts:0,
          scanFound:0,
          scanStatus:`Deep Clean complete · no surviving posts found after pass ${pass}`,
          lastError:"Deep Clean completed successfully."
        });
        await sleep(500);
        location.replace("https://x.com/home");
        return;
      }

      await setState({
        queue:[...found],index:0,scanActive:false,running:true,
        scanFound:found.size,
        scanStatus:`Deep Clean pass ${pass}/${maxPasses} · ${found.size} survivors queued`,
        verifyPending:false,verifyId:"",verifyAttempts:0,
        lastError:""
      });
      await sleep(600);
      location.replace(`https://x.com/${initial.username}/status/${[...found][0]}`);
      return;
    }

    await setState({
      queue:[...found],index:0,scanActive:false,scanFound:found.size,
      scanStatus:`Scan complete · ${found.size} unique post IDs queued`,
      running:false,deleted:0,skipped:0,failed:0,
      lastError:found.size ? "" : "No posts were found in the currently exposed Posts & Replies timeline."
    });
  }

  // ---------- DM scanner ----------
  function normalizeConversationHref(href){
    if(!href) return null;
    const clean = href.split("?")[0].split("#")[0];
    if(clean === "/messages" || clean === "/messages/compose" || clean.startsWith("/messages/settings")) return null;
    const m = clean.match(/^\/messages\/([A-Za-z0-9_-]{4,})$/);
    return m ? `/messages/${m[1]}` : null;
  }

  function collectConversationHrefs(){
    const found = new Set();
    for(const a of document.querySelectorAll('a[href^="/messages/"]')){
      const href = normalizeConversationHref(a.getAttribute("href"));
      if(href) found.add(href);
    }
    return found;
  }

  function bestScrollableInbox(){
    const candidates = [...document.querySelectorAll("div")].filter(el => {
      const style = getComputedStyle(el);
      return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 200;
    });
    candidates.sort((a,b) => (b.scrollHeight-b.clientHeight) - (a.scrollHeight-a.clientHeight));
    return candidates[0] || document.scrollingElement;
  }

  async function runDmScanner(){
    const initial = await getState();
    if(!initial.dmScanActive || !initial.accountId) return;
    if(!accountMatches(initial.accountId)){
      await setState({dmScanActive:false,dmScanStatus:"DM scan stopped",dmLastError:"Safety stop: logged-in X account could not be verified."});
      return;
    }

    if(!location.pathname.startsWith("/messages")){
      location.href = "https://x.com/messages";
      return;
    }

    const found = new Set();
    let stagnant = 0, previous = 0;
    await sleep(1200);
    await setState({dmScanStatus:"Scanning DM inbox…",dmScanFound:0,dmLastError:""});

    for(let round=0; round<260; round++){
      const live = await getState();
      if(!live.dmScanActive) return;

      for(const href of collectConversationHrefs()) found.add(href);
      stagnant = found.size === previous ? stagnant + 1 : 0;
      previous = found.size;

      await setState({
        dmScanFound:found.size,
        dmScanStatus:`Scanning DM inbox…\n${found.size} unique conversations found`
      });
      if(stagnant >= 14) break;

      const scroller = bestScrollableInbox();
      if(scroller === document.scrollingElement){
        window.scrollTo({top:document.documentElement.scrollHeight,behavior:"smooth"});
      }else{
        scroller.scrollTo({top:scroller.scrollHeight,behavior:"smooth"});
      }
      await sleep(800);
    }

    await setState({
      dmQueue:[...found],dmIndex:0,dmScanActive:false,dmScanFound:found.size,
      dmScanStatus:`DM scan complete · ${found.size} conversations queued`,
      dmRunning:false,dmDeleted:0,dmSkipped:0,dmFailed:0,
      dmLastError:found.size ? "" : "No DM conversations were discovered in the currently loaded inbox."
    });
  }

  // ---------- shared helpers ----------
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
    const selectors = [
      'button','[role="button"]','[role="menuitem"]','a'
    ];
    for(const el of document.querySelectorAll(selectors.join(","))){
      const text = visibleText(el);
      if(patterns.some(rx => rx.test(text))) return el;
    }
    return null;
  }

  // ---------- post deletion ----------
  async function waitForOwnArticle(username,id,timeout=15000){
    const start = Date.now();
    const wanted = `/${username.toLowerCase()}/status/${id}`;
    while(Date.now()-start < timeout){
      for(const article of document.querySelectorAll('article[data-testid="tweet"]')){
        if([...article.querySelectorAll('a[href*="/status/"]')].some(a => (a.getAttribute("href")||"").toLowerCase().startsWith(wanted))){
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
            deepCleanActive:true,
            deepCleanPass:nextPass,
            scanFound:0,
            scanStatus:`Deep Clean pass ${nextPass}/${maxPasses} · rescanning for survivors…`,
            queue:[],
            index:0,
            lastError:error
          });
          await sleep(650);
          location.replace(`https://x.com/${state.username}/with_replies`);
          return;
        }

        await setState({
          running:false,
          scanActive:false,
          deepCleanActive:false,
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

    const processed = nextIndex;
    const cooldown = processed > 0 && processed % 25 === 0 ? 8000 : 0;
    const jitter = 2400 + Math.floor(Math.random() * 1200);
    await sleep(cooldown + jitter);

    const live = await getState();
    if(!live.running) return;

    location.replace(`https://x.com/${state.username}/status/${state.queue[nextIndex]}`);
  }

  async function runPostDeletion(){
    await sleep(700);
    const state = await getState();
    if(!state.running || !state.queue?.length || !state.username || !state.accountId) return;

    if((state.index || 0) >= state.queue.length){
      await setState({
        running:false,
        verifyPending:false,
        verifyId:"",
        verifyAttempts:0,
        lastError:"Post cleanup completed."
      });
      if(location.pathname.includes("/status/")) location.replace("https://x.com/home");
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

    const id = state.queue[state.index || 0];
    if(!id){
      await setState({running:false,verifyPending:false,verifyId:"",verifyAttempts:0});
      return;
    }

    // Verification stage: after a Delete confirmation, reload the exact status URL.
    // Only count it as deleted when the authored post no longer renders.
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
          `Post ${id} still exists after ${attempts} verified deletion attempts. Deep Clean can try it again on the next pass.`
        );
        return;
      }

      // Still present: clear verification and immediately retry the same post.
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
      // If this is an ordinary first visit and the post is already gone, treat it
      // as skipped/already deleted. During verification, absence is handled above.
      await advancePost(liveState,"skipped",`Post ${id} was unavailable or already deleted.`);
      return;
    }

    const menu = article.querySelector('button[data-testid="caret"]');
    if(!menu){
      await advancePost(liveState,"failed",`Could not open the menu for ${id}.`);
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
      await advancePost(liveState,"failed",`No Delete action was available for ${id}.`);
      return;
    }

    del.click();
    const confirm = await waitFor('[data-testid="confirmationSheetConfirm"]',6000);
    if(!confirm){
      await advancePost(liveState,"failed",`Delete confirmation did not appear for ${id}.`);
      return;
    }

    confirm.click();

    // Record a verification checkpoint BEFORE reloading. This prevents a successful
    // click from being counted without proof that the post disappeared.
    const priorAttempts = liveState.verifyAttempts || 0;
    const attempt = Math.min(priorAttempts + 1, 3);
    await setState({
      verifyPending:true,
      verifyId:id,
      verifyAttempts:attempt,
      lastError:`Verifying deletion of ${id} · attempt ${attempt}/3`
    });

    await sleep(1100);
    location.replace(`https://x.com/${liveState.username}/status/${id}?xac_verify=${attempt}&t=${Date.now()}`);
  }

  // ---------- DM deletion ----------
  async function clickConversationInfo(){
    const direct = document.querySelector(
      '[data-testid="conversationInfoButton"],button[aria-label*="conversation info" i],button[aria-label*="details" i],a[aria-label*="conversation info" i]'
    );
    if(direct){ direct.click(); return true; }

    const info = findClickableByText([/^conversation info$/i,/^info$/i,/^details$/i,/^informations sur la conversation$/i]);
    if(info){ info.click(); return true; }

    // Some current layouts expose a More/three-dot button first.
    const more = document.querySelector(
      'button[data-testid="caret"],button[aria-label*="more" i],[role="button"][aria-label*="more" i]'
    );
    if(more){
      more.click();
      await sleep(250);
      const item = findClickableByText([/^conversation info$/i,/^info$/i,/^details$/i]);
      if(item){ item.click(); return true; }
    }
    return false;
  }

  async function findConversationRemovalAction(timeout=6500){
    const removePatterns = [
      /^delete conversation$/i,
      /^delete$/i,
      /^leave conversation$/i,
      /^supprimer la conversation$/i,
      /^quitter la conversation$/i
    ];
    const start = Date.now();

    while(Date.now()-start < timeout){
      let action = findClickableByText(removePatterns);
      if(action) return action;

      // On some layouts Conversation Info has another three-dot/More menu.
      const moreButtons = [...document.querySelectorAll(
        'button[data-testid="caret"],button[aria-label*="more" i],[role="button"][aria-label*="more" i]'
      )];
      for(const button of moreButtons.slice(-3)){
        button.click();
        await sleep(220);
        action = findClickableByText(removePatterns);
        if(action) return action;
        document.body.click();
      }
      await sleep(220);
    }
    return null;
  }

  async function confirmConversationRemoval(timeout=5000){
    const start = Date.now();
    while(Date.now()-start < timeout){
      const testId = document.querySelector('[data-testid="confirmationSheetConfirm"]');
      if(testId) return testId;

      const btn = findClickableByText([
        /^delete$/i,/^delete conversation$/i,/^leave$/i,/^leave conversation$/i,
        /^supprimer$/i,/^supprimer la conversation$/i,/^quitter$/i,/^quitter la conversation$/i
      ]);
      if(btn) return btn;
      await sleep(160);
    }
    return null;
  }

  async function advanceDm(state,kind,error=""){
    const nextIndex = (state.dmIndex||0)+1;

    await setState({
      dmIndex:nextIndex,
      [kind]:(state[kind]||0)+1,
      dmLastError:error
    });

    // Critical hotfix:
    // Do not leave X on the URL of a conversation that was just removed.
    if(nextIndex >= state.dmQueue.length){
      await setState({
        dmRunning:false,
        dmScanActive:false,
        dmLastError:error || "DM cleanup completed."
      });
      await sleep(450);
      location.replace("https://x.com/messages");
      return;
    }

    const processed = nextIndex;
    const cooldown = processed > 0 && processed % 20 === 0 ? 7000 : 0;
    const jitter = 2200 + Math.floor(Math.random() * 1200);
    await sleep(cooldown + jitter);

    // Respect Pause / Stop All while waiting.
    const live = await getState();
    if(!live.dmRunning) return;

    location.replace(`https://x.com${state.dmQueue[nextIndex]}`);
  }

  async function runDmDeletion(){
    await sleep(1000);
    const state = await getState();
    if(!state.dmRunning || !state.dmQueue?.length || !state.accountId) return;

    // Never resume a finished DM job just because the deleted conversation route reloads.
    if((state.dmIndex || 0) >= state.dmQueue.length){
      await setState({dmRunning:false,dmLastError:"DM cleanup completed."});
      if(location.pathname.startsWith("/messages/")) location.replace("https://x.com/messages");
      return;
    }

    if(!accountMatches(state.accountId)){
      await setState({dmRunning:false,dmLastError:"Safety stop: logged-in X account changed or could not be verified."});
      alert("DM Cleaner stopped because the logged-in X account could not be verified.");
      return;
    }

    const href = state.dmQueue[state.dmIndex||0];
    if(!href){ await setState({dmRunning:false}); return; }

    if(!location.pathname.startsWith(href)){
      location.href = `https://x.com${href}`;
      return;
    }

    // Wait for the conversation view to render.
    await sleep(900);

    const openedInfo = await clickConversationInfo();
    if(!openedInfo){
      await advanceDm(state,"dmFailed",`Could not open Conversation info for ${href}.`);
      return;
    }

    await sleep(500);
    const remove = await findConversationRemovalAction();
    if(!remove){
      await advanceDm(state,"dmSkipped",`No Delete/Leave conversation action was found for ${href}.`);
      return;
    }

    remove.click();
    await sleep(300);

    const confirm = await confirmConversationRemoval();
    if(!confirm){
      await advanceDm(state,"dmFailed",`Removal confirmation did not appear for ${href}.`);
      return;
    }

    confirm.click();
    await sleep(700);
    await advanceDm(state,"dmDeleted");
  }

  runPostScanner().catch(async err => {
    await setState({scanActive:false,scanStatus:"Scan stopped",lastError:`Scan error: ${err?.message || err}`});
  });

  runDmScanner().catch(async err => {
    await setState({dmScanActive:false,dmScanStatus:"DM scan stopped",dmLastError:`DM scan error: ${err?.message || err}`});
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

  runDmDeletion().catch(async err => {
    const s = await getState();
    await setState({dmRunning:false,dmFailed:(s.dmFailed||0)+1,dmLastError:`DM removal error: ${err?.message || err}`});
  });
})();