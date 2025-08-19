// Background orchestrates tab capture + offscreen audio worker

const OFFSCREEN_URL = 'offscreen.html';
let offscreenCreated = false;
let currentTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'START_TRANSCRIBE') {
        currentTabId = msg.tabId;
        await ensureOffscreen();
        await startTranscription(currentTabId);
        await postStatus('Running');
      }
      if (msg?.type === 'STOP_TRANSCRIBE') {
        await stopAll();
        await postStatus('Stopped');
      }
    } catch (e) {
      await postStatus(`Error: ${e.message}`);
    }
  })();
});

async function ensureOffscreen() {
  if (offscreenCreated) return;
  const has = await chrome.offscreen.hasDocument?.();
  if (!has) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
      justification: 'Maintain WebSocket + audio processing for Deepgram transcription.'
    });
  }
  offscreenCreated = true;
}

async function startTranscription(tabId) {
  const { dgApiKey } = await chrome.storage.local.get('dgApiKey');
  if (!dgApiKey) throw new Error('Deepgram API key is not set. Open Options to configure.');
  const streamId = await new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    } catch (e) { reject(e); }
  });
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_START', streamId, dgApiKey });
}

async function stopAll() {
  try { await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }); } catch {}
  try {
    const has = await chrome.offscreen.hasDocument?.();
    if (has) await chrome.offscreen.closeDocument();
  } catch {}
  offscreenCreated = false;
}

async function postStatus(text) {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', text }).catch(() => {});
}

// Relay Deepgram transcript messages from offscreen to content on the active Meet tab
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen-port') return;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'DG_TRANSCRIPT_FINAL' || msg?.type === 'DG_TRANSCRIPT_INTERIM') {
      if (currentTabId) {
        try {
          await chrome.tabs.sendMessage(currentTabId, msg);
        } catch {}
      }
    }
  });
});


