const $ = id => document.getElementById(id);
let pendingAction = null;

// Each job gets a fresh token. Only the tab opened with this token acts on it,
// so other x.com tabs can't hijack or double-advance the queue.
function newJobId(){
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function withJob(url,jobId){
  const u = new URL(url);
  u.searchParams.set("xac_job",jobId);
  return u.toString();
}

function extractArray(text){
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if(first < 0 || last <= first) throw new Error("No archive array found");
  return JSON.parse(text.slice(first,last+1));
}

function extractIds(items){
  const out = new Set();
  let reposts = 0;
  let unsafe = 0;
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

    // Reposts (retweets) can't be removed with "Delete" — they need
    // "Undo repost" — so they'd only ever be counted as skipped.
    const text = obj?.full_text ?? obj?.text ?? "";
    if(obj?.retweeted_status || /^RT @/.test(text)){
      reposts++;
      continue;
    }

    const id =
      obj?.id_str ?? obj?.id ??
      obj?.tweet_id ?? obj?.tweetId ??
      obj?.post_id ?? obj?.postId;

    // Post IDs exceed 2^53; a value parsed as a JSON number has already lost
    // precision and would point at the wrong post.
    if(typeof id === "number" && !Number.isSafeInteger(id)){
      unsafe++;
      continue;
    }

    if(id && /^\d+$/.test(String(id))) out.add(String(id));
  }

  return {ids:[...out],reposts,unsafe};
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
    "sourceMode","scanActive","scanFound","scanStatus"
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

  if(s.scanActive){
    status = s.scanStatus || `Scanning… ${s.scanFound || 0} found`;
  }

  if(!q.length && !s.scanActive){
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
    jobId:"",
    rateLimitHits:0,
    lastError:"Automation stopped manually."
  });

  await refresh();
});

$("importBtn").addEventListener("click", async () => {
  const files = [...$("archiveFiles").files];
  if(!files.length) return alert("Choose one or more archive .js/.json files first.");

  const all = new Set();
  let reposts = 0;
  let unsafe = 0;
  const badFiles = [];

  for(const file of files){
    try{
      const r = extractIds(extractArray(await file.text()));
      for(const id of r.ids) all.add(id);
      reposts += r.reposts;
      unsafe += r.unsafe;
    }catch(err){
      badFiles.push(file.name);
      console.warn("Could not parse",file.name,err);
    }
  }

  const queue = [...all];
  if(!queue.length) return alert("No post IDs were found in the selected archive files.");

  const notes = [`Imported ${queue.length} unique post IDs from archive.`];
  if(reposts) notes.push(`Ignored ${reposts} reposts (undo those on X directly).`);
  if(unsafe) notes.push(`Ignored ${unsafe} entries with unreadable numeric IDs.`);
  if(badFiles.length) notes.push(`Could not read: ${badFiles.join(", ")}`);

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
    lastError:notes.join("\n")
  });

  await refresh();
});

$("scanBtn").addEventListener("click", async () => {
  const s = await chrome.storage.local.get(["accountId","username"]);
  if(!s.accountId || !s.username) return alert("Press Get Account first.");

  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id) return;

  const jobId = newJobId();

  await chrome.storage.local.set({
    jobId,
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
    lastError:""
  });

  await chrome.tabs.update(tab.id,{url:withJob(`https://x.com/${s.username}`,jobId)});
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

function closeConfirm(){
  pendingAction = null;
  $("sureBtn").disabled = false;
  $("confirmModal").classList.remove("show");
}

$("sureBtn").addEventListener("click", async () => {
  $("sureBtn").disabled = true;
  const jobId = newJobId();

  if(pendingAction === "posts"){
    const s = await chrome.storage.local.get(["queue","index","username"]);
    const id = s.queue?.[s.index||0];
    if(!id) return closeConfirm();

    await chrome.storage.local.set({
      jobId,
      running:true,
      rateLimitHits:0,
      lastError:""
    });

    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if(tab?.id){
      await chrome.tabs.update(tab.id,{url:withJob(`https://x.com/${s.username}/status/${id}`,jobId)});
    }
  }

  window.close();
});

$("cancelBtn").addEventListener("click", closeConfirm);

$("pauseBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({
    running:false,
    scanActive:false,
    jobId:"",
    rateLimitHits:0,
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
    jobId:"",
    rateLimitHits:0,
    lastError:""
  });

  await refresh();
});

chrome.storage.onChanged.addListener(refresh);
refresh();
