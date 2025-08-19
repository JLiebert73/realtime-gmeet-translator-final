const keyInput = document.getElementById('dgKey');
const saveBtn = document.getElementById('save');
const revealBtn = document.getElementById('reveal');
const hideBtn = document.getElementById('hide');
const testBtn = document.getElementById('test');
const dgStatusEl = document.getElementById('dgStatus');

const googleKeyInput = document.getElementById('googleKey');
const saveGoogleBtn = document.getElementById('saveGoogle');
const revealGoogleBtn = document.getElementById('revealGoogle');
const hideGoogleBtn = document.getElementById('hideGoogle');
const testGoogleBtn = document.getElementById('testGoogle');
const googleStatusEl = document.getElementById('googleStatus');

function showStatus(element, message, isSuccess = true) {
  element.textContent = message;
  element.className = `status-message ${isSuccess ? 'status-success' : 'status-error'}`;
  element.style.display = 'block';
  
  // Auto-hide after 5 seconds
  setTimeout(() => {
    element.style.display = 'none';
  }, 5000);
}

async function load() {
  const { dgApiKey, googleApiKey } = await chrome.storage.local.get(['dgApiKey', 'googleApiKey']);
  if (dgApiKey) {
    keyInput.value = dgApiKey;
    showStatus(dgStatusEl, '✅ Deepgram API key loaded successfully', true);
  }
  if (googleApiKey) {
    googleKeyInput.value = googleApiKey;
    showStatus(googleStatusEl, '✅ Google Translate API key loaded successfully', true);
  }
}

// Deepgram API key handlers
saveBtn.addEventListener('click', async () => {
  const value = keyInput.value.trim();
  if (!value) {
    showStatus(dgStatusEl, '❌ Please enter a valid API key', false);
    return;
  }
  
  if (!value.startsWith('dg_')) {
    showStatus(dgStatusEl, '⚠️ Deepgram API keys typically start with "dg_"', false);
    return;
  }
  
  await chrome.storage.local.set({ dgApiKey: value });
  showStatus(dgStatusEl, '✅ Deepgram API key saved successfully!', true);
});

revealBtn.addEventListener('click', () => {
  keyInput.type = 'text';
  revealBtn.style.display = 'none';
  hideBtn.style.display = 'inline-flex';
});

hideBtn.addEventListener('click', () => {
  keyInput.type = 'password';
  hideBtn.style.display = 'none';
  revealBtn.style.display = 'inline-flex';
});

testBtn.addEventListener('click', async () => {
  const apiKey = keyInput.value.trim();
  if (!apiKey) {
    showStatus(dgStatusEl, '❌ Please enter an API key first', false);
    return;
  }
  
  showStatus(dgStatusEl, '🧪 Testing Deepgram connection...', true);
  
  try {
    // Test the API key with a simple request
    const response = await fetch('https://api.deepgram.com/v1/projects', {
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      showStatus(dgStatusEl, '🎉 Deepgram API key is valid and working!', true);
    } else {
      showStatus(dgStatusEl, `❌ API key test failed: ${response.status} ${response.statusText}`, false);
    }
  } catch (error) {
    showStatus(dgStatusEl, `❌ Connection error: ${error.message}`, false);
  }
});

// Google Translate API key handlers
saveGoogleBtn.addEventListener('click', async () => {
  const value = googleKeyInput.value.trim();
  if (!value) {
    showStatus(googleStatusEl, '❌ Please enter a valid API key', false);
    return;
  }
  
  if (!value.startsWith('AIza')) {
    showStatus(googleStatusEl, '⚠️ Google API keys typically start with "AIza"', false);
    return;
  }
  
  await chrome.storage.local.set({ googleApiKey: value });
  showStatus(googleStatusEl, '✅ Google Translate API key saved successfully!', true);
});

revealGoogleBtn.addEventListener('click', () => {
  googleKeyInput.type = 'text';
  revealGoogleBtn.style.display = 'none';
  hideGoogleBtn.style.display = 'inline-flex';
});

hideGoogleBtn.addEventListener('click', () => {
  googleKeyInput.type = 'password';
  hideGoogleBtn.style.display = 'none';
  revealGoogleBtn.style.display = 'inline-flex';
});

testGoogleBtn.addEventListener('click', async () => {
  const apiKey = googleKeyInput.value.trim();
  if (!apiKey) {
    showStatus(googleStatusEl, '❌ Please enter an API key first', false);
    return;
  }
  
  showStatus(googleStatusEl, '🧪 Testing Google Translate API...', true);
  
  try {
    // Test with a simple translation
    const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: 'Hello',
        target: 'es',
        format: 'text'
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.data?.translations?.[0]) {
        showStatus(googleStatusEl, '🎉 Google Translate API key is valid and working!', true);
      } else {
        showStatus(googleStatusEl, '❌ Unexpected response from Google Translate API', false);
      }
    } else {
      const errorData = await response.json();
      showStatus(googleStatusEl, `❌ API test failed: ${errorData.error?.message || response.statusText}`, false);
    }
  } catch (error) {
    showStatus(googleStatusEl, `❌ Connection error: ${error.message}`, false);
  }
});

load();
