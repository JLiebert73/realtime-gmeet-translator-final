const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const langSelect = document.getElementById("targetLang");
const settingsLink = document.getElementById("settingsLink");

function setStatus(text, type = 'default') {
  statusEl.textContent = text || 'Ready to start';
  
  // Remove existing status classes
  statusEl.classList.remove('running', 'stopped', 'error', 'pulse');
  
  // Add appropriate class based on status type
  if (type === 'running') {
    statusEl.classList.add('running', 'pulse');
  } else if (type === 'stopped') {
    statusEl.classList.add('stopped');
  } else if (type === 'error') {
    statusEl.classList.add('error');
  }
}

async function queryActiveMeetingTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    throw new Error('No active tab found.');
  }
  
  // Check if current tab is a supported meeting platform
  const meetingPlatforms = [
    'meet.google.com',
    'zoom.us',
    'teams.microsoft.com',
    'webex.com',
    'app.slack.com',
    'gotomeeting.com',
    'bluejeans.com'
  ];
  
  const isValidMeetingTab = meetingPlatforms.some(platform => 
    tab.url.includes(platform)
  );
  
  if (!isValidMeetingTab) {
    throw new Error('Open this popup on a supported meeting platform tab (Google Meet, Zoom, Teams, Webex, Slack, GoToMeeting, or BlueJeans).');
  }
  
  return tab.id;
}

// ---------- Start ----------
startBtn.addEventListener('click', async () => {
  try {
    setStatus('Starting transcription...', 'default');
    const tabId = await queryActiveMeetingTab();
    const lang = langSelect.value;

    await chrome.storage.sync.set({ targetLang: lang });
    await chrome.runtime.sendMessage({ type: 'START_TRANSCRIBE', tabId });

    // Save running state
    await chrome.storage.local.set({ isRunning: true });

    // Update UI
    startBtn.disabled = true;
    stopBtn.disabled = false;
    const langName = langSelect.options[langSelect.selectedIndex].text;
    setStatus(`Translating to ${langName}`, 'running');
  } catch (e) {
    setStatus(`❌ ${e.message}`, 'error');
  }
});

// ---------- Stop ----------
stopBtn.addEventListener('click', async () => {
  try {
    setStatus('Stopping transcription...', 'default');
    await chrome.runtime.sendMessage({ type: 'STOP_TRANSCRIBE' });

    // Save running state
    await chrome.storage.local.set({ isRunning: false });

    // Update UI
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('Translation stopped', 'stopped');
  } catch (e) {
    setStatus(`❌ ${e.message}`, 'error');
  }
});

// ---------- Background messages ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'STATUS_UPDATE') {
    if (msg.text.includes('Error') || msg.text.includes('error')) {
      setStatus(`Error: ${msg.text}`, 'error');
    } else if (msg.text.includes('Running') || msg.text.includes('Connected')) {
      setStatus(`${msg.text}`, 'running');
    } else if (msg.text.includes('Stopped') || msg.text.includes('closed')) {
      setStatus(`${msg.text}`, 'stopped');
    } else {
      setStatus(msg.text, 'default');
    }
  }
});

// ---------- Settings Link ----------
settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ---------- Language dropdown ----------
langSelect.addEventListener("change", (e) => {
  const lang = e.target.value;
  chrome.storage.sync.set({ targetLang: lang });
  console.log("🔤 Language set to:", lang);
});

// ---------- On popup open ----------
chrome.storage.sync.get("targetLang", (data) => {
  if (data.targetLang) langSelect.value = data.targetLang;
});

chrome.storage.local.get("isRunning", (data) => {
  if (data.isRunning) {
    // If running, keep Stop enabled
    startBtn.disabled = true;
    stopBtn.disabled = false;
    const langName = langSelect.options[langSelect.selectedIndex].text;
    setStatus(`Translating to ${langName}`, 'running');
  } else {
    // Default: not running
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('Ready to start', 'default');
  }
});
