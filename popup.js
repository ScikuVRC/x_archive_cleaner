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
  const wrappers = [
    "tweet","post","communityTweet","community_tweet",
    "communityPost","community_post"
  ];

  for(const item of items){
    let obj = item;
    for(const key of wrappers){
      if(item && typeof item === "object" && item[key]){
        obj = item[key];
        break;
      }
    }

    const id =
      obj?.id_str ?? obj?.id ??
      obj?.tweet_id ?? obj?.tweetId ??
      obj?.post_id ?? obj?.postId;

    if(id && /^\d+$/.test(String(id))) out.add(String(id));
  }

  return [...out];
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
    "queue","index","running","deleted","skipped","failed","lastError",
    "sourceMode","scanActive","scanFound","scanStatus",
    "scanPhase","scanCollected",
    "deepCleanActive","deepCleanPass","deepCleanMaxPasses",
    "verifyPending","verifyAttempts"
  ]);

  $("accountName").textContent = s.username ? `@${s.username}` : "No account detected";
  $("accountId").textContent = s.accountId ? `Account ID: ${s.accountId}` : "Open x.com while logged in";

  const q = s.queue || [];
  const i = s.index || 0;

  $("queued").textContent = q.length;
  $("processed").textContent = Math.min(i,q.length);
  $("deleted").textContent = s.deleted || 0;
  $("bar").style.width = q.length ? `${Math.min(100,(i/q.length)*100)}%` : "0%";

  let status = s.running ? "Deleting…" : "Ready";

  if(s.deepCleanActive){
    status = `Deep Clean pass ${s.deepCleanPass || 1}/${s.deepCleanMaxPasses || 3}…`;
  }

  if(s.verifyPending){
    status += `\nVerifying deletion · attempt ${s.verifyAttempts || 1}/3`;
  }

  if(s.scanActive){
    status = s.scanStatus || `Scanning… ${s.scanFound || 0} found`;
  }

  if(!q.length && !s.scanActive && !s.deepCleanActive){
    status = s.lastError || "Nothing loaded yet.";
  }else if(s.lastError){
    status += `\n${s.lastError}`;
  }

  if(q.length && !s.scanActive){
    status += `\nSkipped ${s.skipped||0} · Failed ${s.failed||0}`;
  }

  $("status").textContent = status;

  if(s.sourceMode) setSource(s.sourceMode);
}

$("archiveTab").addEventListener("click", async () => {
  setSource("archive");
  await chrome.storage.local.set({sourceMode:"archive"});
});

$("scanTab").addEventListener("click", async () => {
  setSource("scan");
  await chrome.storage.local.set({sourceMode:"scan"});
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

    await chrome.storage.local.set({
      accountId:result.accountId,
      username:result.username || "",
      lastError:""
    });

    await refresh();
  }catch{
    alert("Could not detect the logged-in X account. Refresh x.com and try again.");
  }
});

$("stopAllBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({
    running:false,
    scanActive:false,
    deepCleanActive:false,
    verifyPending:false,
    verifyId:"",
    verifyAttempts:0,
    lastError:"Automation stopped manually."
  });

  await refresh();
});

$("importBtn").addEventListener("click", async () => {
  const files = [...$("archiveFiles").files];
  if(!files.length) return alert("Choose one or more archive .js/.json files first.");

  const all = new Set();

  for(const file of files){
    try{
      for(const id of extractIds(extractArray(await file.text()))) all.add(id);
    }catch(err){
      console.warn("Could not parse",file.name,err);
    }
  }

  const queue = [...all];
  if(!queue.length) return alert("No post IDs were found in the selected archive files.");

  await chrome.storage.local.set({
    sourceMode:"archive",
    queue,
    index:0,
    running:false,
    deleted:0,
    skipped:0,
    failed:0,
    scanActive:false,
    scanPhase:"",
    scanCollected:[],
    deepCleanActive:false,
    verifyPending:false,
    verifyId:"",
    verifyAttempts:0,
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
    sourceMode:"scan",
    scanActive:true,
    scanPhase:"posts",
    scanCollected:[],
    scanFound:0,
    scanStatus:"Opening Posts timeline…",
    queue:[],
    index:0,
    running:false,
    deleted:0,
    skipped:0,
    failed:0,
    deepCleanActive:false,
    verifyPending:false,
    verifyId:"",
    verifyAttempts:0,
    lastError:""
  });

  await chrome.tabs.update(tab.id,{url:`https://x.com/${s.username}`});
  window.close();
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

$("deepCleanBtn").addEventListener("click", async () => {
  const s = await chrome.storage.local.get(["accountId","username","scanActive","running"]);

  if(!s.accountId || !s.username) return alert("Press Get Account first.");
  if(s.scanActive || s.running) return alert("Pause the current job before starting Deep Clean.");

  pendingAction = "deep";
  $("confirmTitle").textContent = "Run Deep Clean?";
  $("confirmCopy").textContent = "Deep Clean will repeatedly scan Posts and Replies and verify deletion for up to";
  $("confirmCount").textContent = "3 passes";
  $("confirmFoot").textContent = "Posts that survive a deletion attempt will be retried up to 3 times.";
  $("confirmModal").classList.add("show");
});

$("sureBtn").addEventListener("click", async () => {
  $("sureBtn").disabled = true;

  if(pendingAction === "posts"){
    const s = await chrome.storage.local.get(["queue","index","username"]);
    const id = s.queue?.[s.index||0];
    if(!id) return;

    await chrome.storage.local.set({
      running:true,
      lastError:"",
      verifyPending:false,
      verifyId:"",
      verifyAttempts:0
    });

    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if(tab?.id){
      await chrome.tabs.update(tab.id,{url:`https://x.com/${s.username}/status/${id}`});
    }
  }

  if(pendingAction === "deep"){
    const s = await chrome.storage.local.get(["username"]);
    if(!s.username) return;

    await chrome.storage.local.set({
      deepCleanActive:true,
      deepCleanPass:1,
      deepCleanMaxPasses:3,
      scanActive:true,
      scanPhase:"posts",
      scanCollected:[],
      scanFound:0,
      scanStatus:"Deep Clean pass 1/3 · scanning Posts…",
      queue:[],
      index:0,
      running:false,
      verifyPending:false,
      verifyId:"",
      verifyAttempts:0,
      lastError:""
    });

    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if(tab?.id){
      await chrome.tabs.update(tab.id,{url:`https://x.com/${s.username}`});
    }
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
    running:false,
    scanActive:false,
    deepCleanActive:false,
    verifyPending:false,
    verifyId:"",
    verifyAttempts:0,
    scanStatus:"Paused"
  });
  await refresh();
});

$("resetBtn").addEventListener("click", async () => {
  if(!confirm("Reset the post queue, scan state, and deletion progress?")) return;

  await chrome.storage.local.set({
    queue:[],
    index:0,
    running:false,
    deleted:0,
    skipped:0,
    failed:0,
    scanActive:false,
    scanFound:0,
    scanStatus:"",
    scanPhase:"",
    scanCollected:[],
    deepCleanActive:false,
    deepCleanPass:0,
    verifyPending:false,
    verifyId:"",
    verifyAttempts:0,
    lastError:""
  });

  await refresh();
});

chrome.storage.onChanged.addListener(refresh);
refresh();
