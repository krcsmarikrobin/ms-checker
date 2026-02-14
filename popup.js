document.addEventListener('DOMContentLoaded', async () => {
  const urlInput = document.getElementById('url-input');
  const intervalInput = document.getElementById('interval-input');
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const runNowBtn = document.getElementById('run-now-btn');
  const exportBtn = document.getElementById('export-btn');
  const statusDiv = document.getElementById('status');
  const logTable = document.getElementById('log-table');
  const logBody = document.getElementById('log-body');
  const clearLogBtn = document.getElementById('clear-log-btn');
  const emptyLog = document.getElementById('empty-log');

  // Load saved settings
  const data = await chrome.storage.local.get(['targetUrl', 'intervalSeconds', 'isRunning', 'timingLogs']);
  urlInput.value = data.targetUrl || '';
  intervalInput.value = data.intervalSeconds || 300;
  updateUIState(data.isRunning || false);
  renderLogs(data.timingLogs || []);

  // Save settings on input change
  urlInput.addEventListener('change', () => {
    chrome.storage.local.set({ targetUrl: urlInput.value.trim() });
  });

  intervalInput.addEventListener('change', () => {
    const val = parseInt(intervalInput.value);
    if (val >= 10) {
      chrome.storage.local.set({ intervalSeconds: val });
    }
  });

  // Start
  startBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    const interval = parseFloat(intervalInput.value);

    if (!url) {
      statusDiv.textContent = 'Add meg az URL-t!';
      statusDiv.className = 'status error';
      return;
    }
    if (!interval || interval < 10) {
      statusDiv.textContent = 'Minimum interval: 10 mp';
      statusDiv.className = 'status error';
      return;
    }

    await chrome.storage.local.set({ targetUrl: url, intervalSeconds: interval });
    chrome.runtime.sendMessage({ action: 'start', intervalSeconds: interval });
    updateUIState(true);
  });

  // Stop
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stop' });
    updateUIState(false);
  });

  // Run Now
  runNowBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) {
      statusDiv.textContent = 'Add meg az URL-t!';
      statusDiv.className = 'status error';
      return;
    }
    chrome.storage.local.set({ targetUrl: url });
    statusDiv.textContent = 'Futás...';
    statusDiv.className = 'status running';
    chrome.runtime.sendMessage({ action: 'runNow' });
  });

  // CSV Export
  exportBtn.addEventListener('click', async () => {
    const store = await chrome.storage.local.get(['timingLogs']);
    const logs = store.timingLogs || [];
    if (logs.length === 0) return;

    const csv = logsToCSV(logs);

    // Download as file via blob URL
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url: url,
      filename: 'pdf-timer-export.csv',
      conflictAction: 'uniquify'
    });
  });

  // Clear log
  clearLogBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({ timingLogs: [] });
    renderLogs([]);
  });

  // Real-time updates from storage changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.timingLogs) {
        renderLogs(changes.timingLogs.newValue || []);
      }
      if (changes.isRunning) {
        updateUIState(changes.isRunning.newValue);
      }
    }
  });

  // --- Helpers ---

  function updateUIState(isRunning) {
    startBtn.disabled = isRunning;
    stopBtn.disabled = !isRunning;
    urlInput.disabled = isRunning;
    intervalInput.disabled = isRunning;
    statusDiv.textContent = isRunning ? 'Fut' : 'Idle';
    statusDiv.className = isRunning ? 'status running' : 'status';
  }

  function logsToCSV(logs) {
    let csv = 'timestamp,durationMs,fileSize,type,success,error\n';
    for (const e of logs) {
      const time = new Date(e.timestamp).toISOString();
      csv += `${time},${e.durationMs},${e.fileSize},${e.type},${e.success},${e.error || ''}\n`;
    }
    return csv;
  }

  function renderLogs(logs) {
    logBody.innerHTML = '';

    if (logs.length === 0) {
      logTable.classList.remove('visible');
      emptyLog.style.display = 'block';
      return;
    }

    logTable.classList.add('visible');
    emptyLog.style.display = 'none';

    for (const entry of logs) {
      const row = document.createElement('tr');
      row.className = entry.success ? 'success' : 'failure';

      const timeCell = document.createElement('td');
      timeCell.textContent = new Date(entry.timestamp).toLocaleTimeString('hu-HU');

      const durationCell = document.createElement('td');
      durationCell.textContent = entry.durationMs.toLocaleString('hu-HU');

      const sizeCell = document.createElement('td');
      sizeCell.textContent = entry.fileSize
        ? (entry.fileSize / 1024).toFixed(1)
        : '-';

      const typeCell = document.createElement('td');
      typeCell.textContent = entry.type === 'download' ? 'PDF' : entry.type === 'page' ? 'Page' : '-';

      const statusCell = document.createElement('td');
      statusCell.textContent = entry.success ? 'OK' : entry.error;
      if (entry.error) {
        statusCell.title = entry.error;
      }

      row.append(timeCell, durationCell, sizeCell, typeCell, statusCell);
      logBody.appendChild(row);
    }
  }
});
