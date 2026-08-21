const $ = id => document.getElementById(id);
let pendingAction = null;

function extractArray(text){
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if(first < 0 || last <= first) throw new Error("No archive array found");
  return JSON.parse(text.slice(first,last+1));
}

function extractIds(items){
  const out = new Set();
  const wrappers = ["tweet","post","communityTweet","community_tweet","communityPost","community_post"];
  for(const item of items){
    let obj = item;
    for(const key of wrappers){
      if(item && typeof item === "object" && item[key]){
        obj = item[key];
        break;
      }
    }
    const id = obj?.id_str ?? obj?.id ?? obj?.tweet_id ?? obj?.tweetId ?? obj?.post_id ?? obj?.postId;
    if(id && /^\d+$/.test(String(id))) out.add(String(id));
  }
  return [...out];
}

function setMainView(view){
  const posts = view !== "dm";
  $("postsNav").classList.toggle("active",posts);
  $("dmNav").classList.toggle("active",!posts);
  $("postsView").classList.toggle("active",posts);
  $("dmView").classList.toggle("active",!posts);
}

function setSource(which){
  const archive = which === "archive";
  $("archiveTab").classList.toggle("active",archive);
  $("scanTab").classList.toggle("active",!archive);
  $("archivePane").classList.toggle("active",archive);
  $("scanPane").classList.toggle("active",!archive);
}

async function refresh(){
  const s = await chrome.storage.local.get([
    "accountId","username",
    "queue","index","running","deleted","skipped","failed","lastError","sourceMode","scanActive","scanFound","scanStatus",
    "deepCleanActive","deepCleanPass","deepCleanMaxPasses","verifyPending","verifyAttempts",
    "dmQueue","dmIndex","dmRunning","dmDeleted","dmSkipped","dmFailed","dmLastError","dmScanActive","dmScanFound","dmScanStatus",
    "mainView"
  ]);

  $("accountName").textContent = s.username ? `@${s.username}` : "No account detected";
  $("accountId").textContent = s.accountId ? `Account ID: ${s.accountId}` : "Open x.com while logged in";

  const q = s.queue || [], i = s.index || 0;
  $("queued").textContent = q.length;
  $("processed").textContent = Math.min(i,q.length);
  $("deleted").textContent = s.deleted || 0;
  $("bar").style.width = q.length ? `${Math.min(100,(i/q.length)*100)}%` : "0%";
  let postStatus = s.running ? "Deleting…" : "Ready";
  if(s.deepCleanActive) postStatus = `Deep Clean pass ${s.deepCleanPass || 1}/${s.deepCleanMaxPasses || 3}…`;
  if(s.verifyPending) postStatus += `\nVerifying deletion · attempt ${s.verifyAttempts || 1}/3`;
  if(s.scanActive) postStatus = s.scanStatus || `Scanning… ${s.scanFound || 0} found`;
  if(!q.length && !s.scanActive) postStatus = s.lastError || "Nothing loaded yet.";
  else if(s.lastError) postStatus += `\n${s.lastError}`;
  if(q.length && !s.scanActive) postStatus += `\nSkipped ${s.skipped||0} · Failed ${s.failed||0}`;
  $("status").textContent = postStatus;

  const dq = s.dmQueue || [], di = s.dmIndex || 0;
  $("dmQueued").textContent = dq.length;
  $("dmProcessed").textContent = Math.min(di,dq.length);
  $("dmDeleted").textContent = s.dmDeleted || 0;
  $("dmBar").style.width = dq.length ? `${Math.min(100,(di/dq.length)*100)}%` : "0%";
  let dmStatus = s.dmRunning ? "Removing conversations…" : "Ready";
  if(s.dmScanActive) dmStatus = s.dmScanStatus || `Scanning inbox… ${s.dmScanFound || 0} found`;
  if(!dq.length && !s.dmScanActive) dmStatus = s.dmLastError || "Inbox has not been scanned.";
  else if(s.dmLastError) dmStatus += `\n${s.dmLastError}`;
  if(dq.length && !s.dmScanActive) dmStatus += `\nSkipped ${s.dmSkipped||0} · Failed ${s.dmFailed||0}`;
  $("dmStatus").textContent = dmStatus;

  if(s.sourceMode) setSource(s.sourceMode);
  setMainView(s.mainView || "posts");
}

$("postsNav").addEventListener("click", async () => {
  setMainView("posts"); await chrome.storage.local.set({mainView:"posts"});
});
$("dmNav").addEventListener("click", async () => {
  setMainView("dm"); await chrome.storage.local.set({mainView:"dm"});
});
$("stopAllBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({
    running:false,
    scanActive:false,
    dmRunning:false,
    dmScanActive:false,
    deepCleanActive:false,
    verifyPending:false,
    verifyId:"",
    verifyAttempts:0,
    lastError:"Automation stopped manually.",
    dmLastError:"Automation stopped manually."
  });
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if(tab?.id && /^https:\/\/(x|twitter)\.com\//.test(tab.url || "")){
    await chrome.tabs.update(tab.id,{url:"https://x.com/home"});
  }
  await refresh();
});

$("archiveTab").addEventListener("click", async () => {
  setSource("archive"); await chrome.storage.local.set({sourceMode:"archive"});
});
$("scanTab").addEventListener("click", async () => {
  setSource("scan"); await chrome.storage.local.set({sourceMode:"scan"});
});

$("grabId").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id || !/^https:\/\/(x|twitter)\.com\//.test(tab.url || "")){
    alert("Open x.com in this tab while logged in, then press Get Account.");
    return;
  }
  try{
    const result = await chrome.tabs.sendMessage(tab.id,{cmd:"detect-account"});
    if(!result?.accountId) throw new Error(result?.error || "Account ID unavailable");
    await chrome.storage.local.set({accountId:result.accountId,username:result.username||"",lastError:"",dmLastError:""});
    await refresh();
  }catch{
    alert("Could not detect the logged-in X account. Refresh x.com and try again.");
  }
});

$("importBtn").addEventListener("click", async () => {
  const files = [...$("archiveFiles").files];
  if(!files.length) return alert("Choose one or more archive .js/.json files first.");
  const all = new Set();
  for(const file of files){
    try{ for(const id of extractIds(extractArray(await file.text()))) all.add(id); }
    catch(err){ console.warn("Could not parse",file.name,err); }
  }
  const queue = [...all];
  if(!queue.length) return alert("No post IDs were found in the selected archive files.");
  await chrome.storage.local.set({
    sourceMode:"archive",queue,index:0,running:false,deleted:0,skipped:0,failed:0,
    lastError:`Imported ${queue.length} unique post IDs from archive.`
  });
  await refresh();
});

$("scanBtn").addEventListener("click", async () => {
  const s = await chrome.storage.local.get(["accountId","username"]);
  if(!s.accountId || !s.username) return alert("Press Get Account first.");
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id) return;
  await chrome.storage.local.set({
    sourceMode:"scan",scanActive:true,scanFound:0,scanStatus:"Opening Posts & Replies…",
    queue:[],index:0,running:false,deleted:0,skipped:0,failed:0,lastError:""
  });
  await chrome.tabs.update(tab.id,{url:`https://x.com/${s.username}/with_replies`});
  window.close();
});

$("deepCleanBtn").addEventListener("click", async () => {
  const s = await chrome.storage.local.get(["accountId","username","scanActive","running"]);
  if(!s.accountId || !s.username) return alert("Press Get Account first.");
  if(s.scanActive || s.running) return alert("Pause the current job before starting Deep Clean.");

  pendingAction = "deep";
  $("confirmTitle").textContent = "Run Deep Clean?";
  $("confirmCopy").textContent = "Deep Clean will repeatedly scan Posts & Replies and verify every deletion for up to";
  $("confirmCount").textContent = "3 passes";
  $("confirmFoot").textContent = "Posts that survive a deletion attempt will be retried up to 3 times.";
  $("confirmModal").classList.add("show");
});

$("startBtn").addEventListener("click", async () => {
  const s = await chrome.storage.local.get(["accountId","username","queue","index","scanActive"]);
  if(s.scanActive) return alert("The account scan is still running.");
  if(!s.accountId || !s.username) return alert("Press Get Account first.");
  if(!s.queue?.length) return alert("Import an archive or scan your account first.");
  const remaining = s.queue.length - (s.index||0);
  if(remaining <= 0) return alert("The queue is already complete.");
  pendingAction = "posts";
  $("confirmTitle").textContent = "Delete posts permanently?";
  $("confirmCopy").textContent = "You are about to permanently delete";
  $("confirmCount").textContent = String(remaining);
  $("confirmFoot").textContent = "queued posts. Deleted posts cannot be restored.";
  $("confirmModal").classList.add("show");
});

$("dmScanBtn").addEventListener("click", async () => {
  const s = await chrome.storage.local.get(["accountId","username"]);
  if(!s.accountId) return alert("Press Get Account first.");
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id) return;
  await chrome.storage.local.set({
    mainView:"dm",dmScanActive:true,dmScanFound:0,dmScanStatus:"Opening DM inbox…",
    dmQueue:[],dmIndex:0,dmRunning:false,dmDeleted:0,dmSkipped:0,dmFailed:0,dmLastError:""
  });
  await chrome.tabs.update(tab.id,{url:"https://x.com/messages"});
  window.close();
});

$("dmDeleteBtn").addEventListener("click", async () => {
  const s = await chrome.storage.local.get(["accountId","dmQueue","dmIndex","dmScanActive"]);
  if(s.dmScanActive) return alert("The DM scan is still running.");
  if(!s.accountId) return alert("Press Get Account first.");
  if(!s.dmQueue?.length) return alert("Scan your DM inbox first.");
  const remaining = s.dmQueue.length - (s.dmIndex||0);
  if(remaining <= 0) return alert("The DM queue is already complete.");
  pendingAction = "dm";
  $("confirmTitle").textContent = "Remove DM conversations?";
  $("confirmCopy").textContent = "You are about to remove";
  $("confirmCount").textContent = String(remaining);
  $("confirmFoot").textContent = "conversations from your account. Other participants may still retain their copies.";
  $("confirmModal").classList.add("show");
});

$("sureBtn").addEventListener("click", async () => {
  $("sureBtn").disabled = true;
  if(pendingAction === "posts"){
    const s = await chrome.storage.local.get(["queue","index","username"]);
    const id = s.queue?.[s.index||0];
    if(!id) return;
    await chrome.storage.local.set({
      running:true,lastError:"",
      verifyPending:false,verifyId:"",verifyAttempts:0
    });
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if(tab?.id) await chrome.tabs.update(tab.id,{url:`https://x.com/${s.username}/status/${id}`});
  }else if(pendingAction === "deep"){
    const s = await chrome.storage.local.get(["username"]);
    if(!s.username) return;
    await chrome.storage.local.set({
      deepCleanActive:true,
      deepCleanPass:1,
      deepCleanMaxPasses:3,
      scanActive:true,
      scanFound:0,
      scanStatus:"Deep Clean pass 1/3 · scanning Posts & Replies…",
      queue:[],
      index:0,
      running:false,
      verifyPending:false,
      verifyId:"",
      verifyAttempts:0,
      lastError:""
    });
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if(tab?.id) await chrome.tabs.update(tab.id,{url:`https://x.com/${s.username}/with_replies`});
  }else if(pendingAction === "dm"){
    const s = await chrome.storage.local.get(["dmQueue","dmIndex"]);
    const href = s.dmQueue?.[s.dmIndex||0];
    if(!href) return;
    await chrome.storage.local.set({dmRunning:true,dmLastError:"",mainView:"dm"});
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if(tab?.id) await chrome.tabs.update(tab.id,{url:`https://x.com${href}`});
  }
  window.close();
});

$("cancelBtn").addEventListener("click", () => {
  pendingAction = null;
  $("sureBtn").disabled = false;
  $("confirmModal").classList.remove("show");
});

$("pauseBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({
    running:false,scanActive:false,deepCleanActive:false,
    verifyPending:false,verifyId:"",verifyAttempts:0,scanStatus:"Paused"
  });
  await refresh();
});
$("resetBtn").addEventListener("click", async () => {
  if(!confirm("Reset the post queue, scan state, and deletion progress?")) return;
  await chrome.storage.local.set({
    queue:[],index:0,running:false,deleted:0,skipped:0,failed:0,
    scanActive:false,scanFound:0,scanStatus:"",
    deepCleanActive:false,deepCleanPass:0,verifyPending:false,verifyId:"",verifyAttempts:0,lastError:""
  });
  await refresh();
});

$("dmPauseBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({dmRunning:false,dmScanActive:false,dmScanStatus:"Paused"});
  await refresh();
});
$("dmResetBtn").addEventListener("click", async () => {
  if(!confirm("Reset the DM queue, scan state, and removal progress?")) return;
  await chrome.storage.local.set({
    dmQueue:[],dmIndex:0,dmRunning:false,dmDeleted:0,dmSkipped:0,dmFailed:0,
    dmScanActive:false,dmScanFound:0,dmScanStatus:"",dmLastError:""
  });
  await refresh();
});

chrome.storage.onChanged.addListener(refresh);
refresh();
