const MAX_LOG_ENTRIES = 600;
const TIMEOUT_MS = 320000;
const DOWNLOAD_GRACE_MS = 5000;
let isFetching = false;
let timerId = null;

// --- Timer lifecycle ---

async function startTimer(intervalSeconds) {
  await chrome.storage.local.set({ isRunning: true, intervalSeconds });
  scheduleNext(intervalSeconds);
}

async function stopTimer() {
  if (timerId) { clearTimeout(timerId); timerId = null; }
  await chrome.storage.local.set({ isRunning: false });
}

function scheduleNext(intervalSeconds) {
  if (timerId) { clearTimeout(timerId); timerId = null; }
  timerId = setTimeout(async () => {
    await performFetchAndMeasure();
    // After run finishes, schedule the next one (only if still running)
    const data = await chrome.storage.local.get(['isRunning', 'intervalSeconds']);
    if (data.isRunning) {
      scheduleNext(data.intervalSeconds);
    }
  }, intervalSeconds * 1000);
}

// --- Keep service worker alive while timer is active ---

chrome.alarms.onAlarm.addListener(async () => {
  // This just keeps the service worker alive — the actual work is done by setTimeout
});

async function ensureKeepAlive(running) {
  if (running) {
    await chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  } else {
    await chrome.alarms.clear('keepalive');
  }
}

// --- Core: open background tab, track download OR full page load ---

async function performFetchAndMeasure() {
  if (isFetching) return;
  isFetching = true;

  const data = await chrome.storage.local.get(['targetUrl']);
  const targetUrl = data.targetUrl;

  if (!targetUrl) {
    await appendLog({ success: false, error: 'No URL configured', durationMs: 0, fileSize: 0, type: '-' });
    isFetching = false;
    return;
  }

  const startTime = Date.now();
  let tabId = null;

  try {
    const tab = await chrome.tabs.create({ url: targetUrl, active: false });
    tabId = tab.id;

    const result = await waitForResult(tabId, startTime);

    try { await chrome.tabs.remove(tabId); } catch (e) {}

    await appendLog(result);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    if (tabId) {
      try { await chrome.tabs.remove(tabId); } catch (e) {}
    }
    await appendLog({ success: false, error: err.message, durationMs, fileSize: 0, type: '-' });
  } finally {
    isFetching = false;
  }
}

function waitForResult(tabId, startTime) {
  return new Promise((resolve, reject) => {
    let downloadStarted = false;
    let downloadId = null;
    let graceTimer = null;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout (60s)'));
    }, TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      if (graceTimer) clearTimeout(graceTimer);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
    }

    function onTabUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      if (downloadStarted) return;

      const pageLoadMs = Date.now() - startTime;

      graceTimer = setTimeout(() => {
        if (!downloadStarted) {
          cleanup();
          resolve({
            success: true,
            error: null,
            durationMs: pageLoadMs,
            fileSize: 0,
            type: 'page'
          });
        }
      }, DOWNLOAD_GRACE_MS);
    }

    function onCreated(downloadItem) {
      downloadStarted = true;
      downloadId = downloadItem.id;
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      chrome.downloads.onCreated.removeListener(onCreated);
    }

    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;

      if (delta.state.current === 'complete') {
        const dlMs = Date.now() - startTime;
        cleanup();
        chrome.downloads.search({ id: downloadId }, (results) => {
          const item = results[0];
          resolve({
            success: true,
            error: null,
            durationMs: dlMs,
            fileSize: item ? item.fileSize : 0,
            type: 'download'
          });
        });
      } else if (delta.state.current === 'interrupted') {
        const dlMs = Date.now() - startTime;
        cleanup();
        resolve({
          success: false,
          error: delta.error ? delta.error.current : 'Download interrupted',
          durationMs: dlMs,
          fileSize: 0,
          type: 'download'
        });
      }
    }

    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

// --- Helpers ---

async function appendLog(entry) {
  const fullEntry = { timestamp: Date.now(), ...entry };

  const data = await chrome.storage.local.get(['timingLogs']);
  const logs = data.timingLogs || [];

  logs.unshift(fullEntry);

  if (logs.length > MAX_LOG_ENTRIES) {
    logs.length = MAX_LOG_ENTRIES;
  }

  await chrome.storage.local.set({ timingLogs: logs });
}

// --- Message handler ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'start') {
    startTimer(message.intervalSeconds)
      .then(() => ensureKeepAlive(true))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.action === 'stop') {
    stopTimer()
      .then(() => ensureKeepAlive(false))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.action === 'runNow') {
    performFetchAndMeasure().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// --- Restore state on service worker startup ---

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(null);
  if (!data.timingLogs) {
    await chrome.storage.local.set({ timingLogs: [] });
  }
  if (data.isRunning === undefined) {
    await chrome.storage.local.set({ isRunning: false });
  }
});

async function restoreIfRunning() {
  const data = await chrome.storage.local.get(['isRunning', 'intervalSeconds']);
  if (data.isRunning && data.intervalSeconds) {
    await ensureKeepAlive(true);
    scheduleNext(data.intervalSeconds);
  }
}

chrome.runtime.onStartup.addListener(restoreIfRunning);
// Also restore when the service worker wakes up (e.g. after idle termination)
restoreIfRunning();
