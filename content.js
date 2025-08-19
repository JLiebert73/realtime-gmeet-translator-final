let container;
let transcriptEl;
let isMinimized = false;
let originalHeight = null;

// ===== Lightweight Speaker Detection System =====
let participantTracks = new Map(); // Map<trackId, {track, analyser, audioContext, volume, isActive, lastActivity}>
let currentSpeaker = null;
let speakerThreshold = 0.01; // Volume threshold for speaker detection

// Override RTCPeerConnection to capture individual audio tracks
function setupLightweightSpeakerDetection() {
  console.log('[Speaker Detection] Setting up lightweight speaker detection');
  
  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  
  // Override addTrack method
  const originalAddTrack = OriginalRTCPeerConnection.prototype.addTrack;
  OriginalRTCPeerConnection.prototype.addTrack = function(track, ...streams) {
    if (track.kind === 'audio') {
      console.log('[Speaker Detection] Audio track added:', track.id);
      setupTrackAnalysis(track, 'outgoing');
    }
    return originalAddTrack.call(this, track, ...streams);
  };
  
  // Override addTransceiver method
  const originalAddTransceiver = OriginalRTCPeerConnection.prototype.addTransceiver;
  OriginalRTCPeerConnection.prototype.addTransceiver = function(trackOrKind, init) {
    const result = originalAddTransceiver.call(this, trackOrKind, init);
    
    if (result.receiver && result.receiver.track && result.receiver.track.kind === 'audio') {
      console.log('[Speaker Detection] Audio transceiver added:', result.receiver.track.id);
      setupTrackAnalysis(result.receiver.track, 'incoming');
    }
    
    return result;
  };
  
  // Listen for track events on all connections
  const originalConnect = OriginalRTCPeerConnection.prototype.addEventListener;
  OriginalRTCPeerConnection.prototype.addEventListener = function(type, listener, options) {
    if (type === 'track') {
      const wrappedListener = (event) => {
        if (event.track && event.track.kind === 'audio') {
          console.log('[Speaker Detection] Track event audio:', event.track.id);
          setupTrackAnalysis(event.track, 'event');
        }
        listener(event);
      };
      return originalConnect.call(this, type, wrappedListener, options);
    }
    return originalConnect.call(this, type, listener, options);
  };
}

// Set up volume analysis for an individual audio track
function setupTrackAnalysis(track, source) {
  const trackId = track.id;
  
  // Skip if already tracking this track
  if (participantTracks.has(trackId)) return;
  
  try {
    // Create MediaStream from the track
    const mediaStream = new MediaStream([track]);
    
    // Create AudioContext and AnalyserNode
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const analyser = audioContext.createAnalyser();
    
    // Configure analyser for volume detection
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    
    // Connect source to analyser
    sourceNode.connect(analyser);
    
    // Store track info
    const trackInfo = {
      track: track,
      analyser: analyser,
      audioContext: audioContext,
      volume: 0,
      isActive: false,
      lastActivity: 0,
      sourceNode: sourceNode
    };
    
    participantTracks.set(trackId, trackInfo);
    
    // Start volume monitoring
    startVolumeMonitoring(trackId);
    
    // Update speaker detection status in UI
    updateSpeakerDetectionStatus();
    
    console.log(`[Speaker Detection] Set up analysis for track ${trackId} from ${source}`);
    
  } catch (error) {
    console.error('[Speaker Detection] Error setting up track analysis:', error);
  }
}

// Monitor volume levels for speaker detection
function startVolumeMonitoring(trackId) {
  const trackInfo = participantTracks.get(trackId);
  if (!trackInfo) return;
  
  const { analyser } = trackInfo;
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  
  function checkVolume() {
    if (!participantTracks.has(trackId)) return; // Track was removed
    
    analyser.getByteFrequencyData(dataArray);
    
    // Calculate RMS volume
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sum / dataArray.length) / 255;
    
    trackInfo.volume = rms;
    const wasActive = trackInfo.isActive;
    trackInfo.isActive = rms > speakerThreshold;
    
    // Speaker state changed
    if (trackInfo.isActive && !wasActive) {
      trackInfo.lastActivity = Date.now();
      updateCurrentSpeaker(trackId);
    }
    
    // Continue monitoring
    requestAnimationFrame(checkVolume);
  }
  
  checkVolume();
}

// Update current active speaker
function updateCurrentSpeaker(trackId) {
  const trackInfo = participantTracks.get(trackId);
  if (!trackInfo) return;
  
  // Simple logic: most recent active speaker wins
  currentSpeaker = trackId;
  
  console.log(`[Speaker Detection] Active speaker: ${trackId} (volume: ${trackInfo.volume.toFixed(3)})`);
  
  // Update speaker indicator with activity
  const indicator = document.getElementById("speaker-detection-status");
  if (indicator) {
    indicator.innerHTML = "🎤"; // Microphone when someone is speaking
    indicator.style.opacity = "1";
    
    // Reset to group icon after 2 seconds of inactivity
    setTimeout(() => {
      if (currentSpeaker === trackId && !trackInfo.isActive) {
        indicator.innerHTML = "👥";
        indicator.style.opacity = "0.8";
      }
    }, 2000);
  }
  
  // Broadcast speaker change
  window.dispatchEvent(new CustomEvent('speakerChanged', {
    detail: {
      speakerId: trackId,
      volume: trackInfo.volume,
      timestamp: Date.now()
    }
  }));
}

// Get current active speaker ID
function getCurrentSpeaker() {
  // Return the most recently active speaker, or fall back to highest volume
  if (currentSpeaker && participantTracks.has(currentSpeaker)) {
    const trackInfo = participantTracks.get(currentSpeaker);
    if (trackInfo.isActive || (Date.now() - trackInfo.lastActivity) < 2000) {
      return currentSpeaker;
    }
  }
  
  // Find speaker with highest current volume
  let maxVolume = 0;
  let loudestSpeaker = null;
  
  for (const [trackId, trackInfo] of participantTracks) {
    if (trackInfo.isActive && trackInfo.volume > maxVolume) {
      maxVolume = trackInfo.volume;
      loudestSpeaker = trackId;
    }
  }
  
  return loudestSpeaker;
}

// Clean up removed tracks
function cleanupRemovedTracks() {
  for (const [trackId, trackInfo] of participantTracks) {
    if (trackInfo.track.readyState === 'ended') {
      console.log(`[Speaker Detection] Cleaning up ended track: ${trackId}`);
      try {
        trackInfo.audioContext.close();
      } catch (e) {}
      participantTracks.delete(trackId);
    }
  }
  
  // Update speaker detection status in UI
  updateSpeakerDetectionStatus();
}

// Update speaker detection status indicator
function updateSpeakerDetectionStatus() {
  const indicator = document.getElementById("speaker-detection-status");
  if (indicator) {
    indicator.style.opacity = participantTracks.size > 0 ? "0.8" : "0.3";
    indicator.title = participantTracks.size > 0 ? 
      `Speaker Detection: Active (${participantTracks.size} tracks)` : 
      "Speaker Detection: Waiting for participants";
  }
}

// ===== End Speaker Detection System =====

// ⚠️ Your Google Cloud Translate API key
let GOOGLE_API_KEY = "";

try {
  chrome.storage.local.get("googleApiKey", (data) => {
    if (chrome.runtime.lastError) {
      console.warn("⚠️ Could not access storage for Google API key");
      return;
    }
    if (data.googleApiKey) {
      GOOGLE_API_KEY = data.googleApiKey;
      console.log("Loaded Google Translate API key:", GOOGLE_API_KEY);
    } else {
      console.warn("⚠️ No Google Translate API key found in options");
    }
  });
} catch (error) {
  console.warn("⚠️ Extension context invalidated - could not load Google API key");
}

// Detect current meeting platform
function detectMeetingPlatform() {
  const hostname = window.location.hostname;
  if (hostname.includes('meet.google.com')) return 'google-meet';
  if (hostname.includes('zoom.us')) return 'zoom';
  if (hostname.includes('teams.microsoft.com')) return 'teams';
  if (hostname.includes('webex.com')) return 'webex';
  if (hostname.includes('app.slack.com')) return 'slack';
  if (hostname.includes('gotomeeting.com')) return 'gotomeeting';
  if (hostname.includes('bluejeans.com')) return 'bluejeans';
  return 'unknown';
}

// Get platform-specific positioning
function getPlatformPositioning(platform) {
  const positions = {
    'google-meet': { top: '20px', right: '20px' },
    'zoom': { top: '80px', right: '20px' }, // Avoid Zoom's top controls
    'teams': { top: '70px', right: '20px' }, // Avoid Teams header
    'webex': { top: '60px', right: '20px' },
    'slack': { top: '50px', right: '20px' },
    'gotomeeting': { top: '60px', right: '20px' },
    'bluejeans': { top: '60px', right: '20px' },
    'unknown': { top: '20px', right: '20px' }
  };
  return positions[platform] || positions['unknown'];
}

const currentPlatform = detectMeetingPlatform();
const defaultPosition = getPlatformPositioning(currentPlatform);

// Initialize speaker detection for supported platforms
if (['google-meet', 'zoom', 'teams'].includes(currentPlatform)) {
  setupLightweightSpeakerDetection();
  
  // Cleanup ended tracks periodically
  setInterval(cleanupRemovedTracks, 5000);
  
  console.log(`[Speaker Detection] Lightweight speaker detection initialized for ${currentPlatform}`);
}

// Default target language (will be overridden if user sets one in popup)
let TARGET_LANG = "hi";

// Load stored language if user selected via popup/options
try {
  chrome.storage.sync.get("targetLang", (data) => {
    if (chrome.runtime.lastError) {
      console.warn("⚠️ Could not access storage for target language");
      return;
    }
    if (data.targetLang) {
      TARGET_LANG = data.targetLang;
      console.log("🔤 Loaded target language from storage:", TARGET_LANG);
    } else {
      console.log("🔤 Using default target language:", TARGET_LANG);
    }
  });
} catch (error) {
  console.warn("⚠️ Extension context invalidated - could not load target language");
}

// Also watch for runtime changes (user switching language while Meet is open)
try {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.targetLang?.newValue) {
      TARGET_LANG = changes.targetLang.newValue;
      console.log("🔄 Target language switched to:", TARGET_LANG);
    }
  });
} catch (error) {
  console.warn("⚠️ Extension context invalidated - could not add storage change listener");
}

async function translateText(text, targetLang = TARGET_LANG, sourceLang = 'auto') {
  if (!text || text.trim().length === 0) return "";
  try {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_API_KEY}`;
    
    // Build request body with source language if provided
    const requestBody = {
      q: text,
      target: targetLang,
      format: "text"
    };
    
    // Add source language if it's not 'auto' and is a valid language code
    if (sourceLang && sourceLang !== 'auto') {
      requestBody.source = sourceLang;
    }
    
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

    const data = await resp.json();
    if (data.error) {
      console.error("Translation API error:", data.error);
      return text;
    }

    const sourceDetected = data.data?.translations?.[0]?.detectedSourceLanguage || sourceLang;
    console.log(`🌍 Translated (${sourceDetected} → ${targetLang}):`, text, "→", data.data.translations[0].translatedText);
    return data.data?.translations?.[0]?.translatedText || text;
  } catch (e) {
    console.error("Translation fetch error:", e);
    return text;
  }
}

// Professional clean translation pane
function ensureUi() {
  if (container && document.body.contains(container)) return;
  
  container = document.createElement("div");
  container.style.position = "fixed";
  container.style.top = defaultPosition.top;
  container.style.right = defaultPosition.right;
  container.style.width = "400px";
  container.style.maxHeight = "65vh";
  container.style.background = "rgba(30, 30, 30, 0.12)";
  container.style.color = "white";
  container.style.fontFamily = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  container.style.fontSize = "16px";
  container.style.borderRadius = "10px";
  container.style.backdropFilter = "blur(20px)";
  container.style.webkitBackdropFilter = "blur(20px)";
  container.style.border = "1px solid rgba(255, 255, 255, 0.06)";
  container.style.boxShadow = "0 12px 40px rgba(0, 0, 0, 0.15)";
  container.style.padding = "20px";
  container.style.paddingBottom = "28px"; // Extra padding for resize handle
  container.style.zIndex = "2147483647";
  container.style.overflow = "hidden";
  container.style.transition = "opacity 0.2s ease, transform 0.2s ease";

  // Restore saved position if available
  try {
    chrome.storage.local.get(["translationPanePosition", "translationPaneHeight"], (data) => {
      if (chrome.runtime.lastError) {
        console.warn("⚠️ Could not access storage for translation pane position");
        return;
      }
      if (data.translationPanePosition) {
        const pos = data.translationPanePosition;
        // Ensure position is still within viewport
        const maxTop = window.innerHeight - container.offsetHeight;
        const maxLeft = window.innerWidth - container.offsetWidth;
        
        const top = Math.max(0, Math.min(pos.top, maxTop));
        const left = Math.max(0, Math.min(pos.left, maxLeft));
        
        container.style.top = top + "px";
        container.style.left = left + "px";
        container.style.right = "auto";
      }
    
      if (data.translationPaneHeight) {
        const height = data.translationPaneHeight;
        // Ensure height is reasonable
        const minHeight = 200;
        const maxHeight = window.innerHeight - (container.offsetTop || 20) - 20;
        const validHeight = Math.max(minHeight, Math.min(height, maxHeight));
        
        container.style.height = validHeight + "px";
        container.style.maxHeight = validHeight + "px";
        
        // Update transcript area height accordingly
        const headerHeight = 60;
        const padding = 40;
        const transcriptHeight = validHeight - headerHeight - padding;
        transcriptEl.style.maxHeight = transcriptHeight + "px";
      }
    });
  } catch (error) {
    console.warn("⚠️ Extension context invalidated - could not load translation pane position");
  }

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.justifyContent = "space-between";
  header.style.marginBottom = "16px";
  header.style.paddingBottom = "12px";
  header.style.borderBottom = "1px solid rgba(255, 255, 255, 0.08)";
  header.style.cursor = "move";
  header.style.userSelect = "none";
  header.title = "Drag to move";
  
  const title = document.createElement("div");
  title.textContent = "Translation";
  title.style.fontSize = "17px";
  title.style.fontWeight = "500";
  title.style.opacity = "0.9";
  title.style.letterSpacing = "0.3px";
  title.style.display = "flex";
  title.style.alignItems = "center";
  title.style.gap = "8px";
  
  // Add drag handle icon
  const dragIcon = document.createElement("span");
  dragIcon.innerHTML = "⋮⋮";
  dragIcon.style.fontSize = "12px";
  dragIcon.style.opacity = "0.5";
  dragIcon.style.letterSpacing = "-2px";
  dragIcon.style.lineHeight = "1";
  title.appendChild(dragIcon);
  
  // Add speaker detection status indicator
  const speakerIndicator = document.createElement("span");
  speakerIndicator.id = "speaker-detection-status";
  speakerIndicator.innerHTML = "👥";
  speakerIndicator.style.fontSize = "14px";
  speakerIndicator.style.opacity = participantTracks.size > 0 ? "0.8" : "0.3";
  speakerIndicator.title = participantTracks.size > 0 ? 
    `Speaker Detection: Active (${participantTracks.size} tracks)` : 
    "Speaker Detection: Waiting for participants";
  title.appendChild(speakerIndicator);

  const clearBtn = document.createElement("button");
  clearBtn.innerHTML = "Clear";
  clearBtn.title = "Clear translation";
  Object.assign(clearBtn.style, {
    cursor: "pointer",
    background: "rgba(255, 255, 255, 0.08)",
    color: "white",
    border: "none",
    borderRadius: "5px",
    padding: "6px 14px",
    fontSize: "13px",
    fontWeight: "400",
    opacity: "0.7",
    transition: "opacity 0.2s ease"
  });
  clearBtn.onmouseenter = () => clearBtn.style.opacity = "1";
  clearBtn.onmouseleave = () => clearBtn.style.opacity = "0.7";
  clearBtn.onclick = () => { 
    transcriptEl.innerHTML = "";
    showPlaceholder();
  };
  
  header.appendChild(title);
  header.appendChild(clearBtn);

  transcriptEl = document.createElement("div");
  transcriptEl.style.overflowY = "auto";
  transcriptEl.style.maxHeight = "55vh";
  transcriptEl.style.lineHeight = "1.6";
  transcriptEl.style.scrollbarWidth = "none";
  transcriptEl.style.msOverflowStyle = "none";
  transcriptEl.style.fontSize = "16px";
  transcriptEl.style.color = "rgba(255, 255, 255, 0.92)";

  // Hide scrollbar for webkit browsers
  const scrollStyle = document.createElement('style');
  scrollStyle.textContent = `
    div::-webkit-scrollbar { display: none; }
  `;
  document.head.appendChild(scrollStyle);

  container.appendChild(header);
  container.appendChild(transcriptEl);
  
  // Add resize handle for height adjustment
  const resizeHandle = document.createElement("div");
  resizeHandle.style.position = "absolute";
  resizeHandle.style.bottom = "0";
  resizeHandle.style.left = "0";
  resizeHandle.style.right = "0";
  resizeHandle.style.height = "8px";
  resizeHandle.style.cursor = "ns-resize";
  resizeHandle.style.background = "transparent";
  resizeHandle.style.borderBottom = "2px solid rgba(255, 255, 255, 0.1)";
  resizeHandle.style.borderRadius = "0 0 10px 10px";
  resizeHandle.title = "Drag to resize height";
  
  // Add subtle visual indicator for resize handle
  const resizeIndicator = document.createElement("div");
  resizeIndicator.style.position = "absolute";
  resizeIndicator.style.bottom = "2px";
  resizeIndicator.style.left = "50%";
  resizeIndicator.style.transform = "translateX(-50%)";
  resizeIndicator.style.width = "30px";
  resizeIndicator.style.height = "2px";
  resizeIndicator.style.background = "rgba(255, 255, 255, 0.3)";
  resizeIndicator.style.borderRadius = "1px";
  resizeHandle.appendChild(resizeIndicator);
  
  container.appendChild(resizeHandle);
  document.body.appendChild(container);
  
  // Make the pane draggable and resizable
  makeDraggable(container, header);
  makeResizable(container, resizeHandle);
  
  showPlaceholder();
}

function showPlaceholder() {
  const placeholder = document.createElement("div");
  placeholder.style.textAlign = "center";
  placeholder.style.color = "rgba(255, 255, 255, 0.4)";
  placeholder.style.padding = "40px 20px";
  placeholder.style.fontStyle = "italic";
  placeholder.style.fontSize = "15px";
  placeholder.innerHTML = "Listening for speech...";
  placeholder.id = "translation-placeholder";
  transcriptEl.appendChild(placeholder);
}

function makeDraggable(element, handle) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  
  handle.onmousedown = dragMouseDown;
  
  function dragMouseDown(e) {
    e = e || window.event;
    e.preventDefault();
    // Get the mouse cursor position at startup
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
    
    // Add visual feedback during drag
    element.style.opacity = "0.8";
    element.style.transform = "scale(1.02)";
    element.style.transition = "none";
  }
  
  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    // Calculate the new cursor position
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    
    // Calculate new position
    let newTop = element.offsetTop - pos2;
    let newLeft = element.offsetLeft - pos1;
    
    // Keep the element within viewport bounds
    const maxTop = window.innerHeight - element.offsetHeight;
    const maxLeft = window.innerWidth - element.offsetWidth;
    
    newTop = Math.max(0, Math.min(newTop, maxTop));
    newLeft = Math.max(0, Math.min(newLeft, maxLeft));
    
    // Set the element's new position
    element.style.top = newTop + "px";
    element.style.left = newLeft + "px";
    element.style.right = "auto"; // Remove right positioning
  }
  
  function closeDragElement() {
    // Stop moving when mouse button is released
    document.onmouseup = null;
    document.onmousemove = null;
    
    // Remove visual feedback
    element.style.opacity = "1";
    element.style.transform = "scale(1)";
    element.style.transition = "opacity 0.2s ease, transform 0.2s ease";
    
    // Save position to storage for persistence (with error handling)
    try {
      const rect = element.getBoundingClientRect();
      chrome.storage.local.set({
        translationPanePosition: {
          top: rect.top,
          left: rect.left
        }
      });
    } catch (error) {
      // Ignore storage errors (extension context may be invalidated)
      console.log('[Storage] Could not save position - extension context may be invalidated');
    }
  }
}

function makeResizable(element, handle) {
  let startY = 0;
  let startHeight = 0;
  
  handle.onmousedown = resizeMouseDown;
  
  function resizeMouseDown(e) {
    e = e || window.event;
    e.preventDefault();
    e.stopPropagation(); // Prevent triggering drag
    
    // Get initial values
    startY = e.clientY;
    startHeight = parseInt(document.defaultView.getComputedStyle(element).height, 10);
    
    document.onmouseup = closeResizeElement;
    document.onmousemove = elementResize;
    
    // Add visual feedback during resize
    element.style.transition = "none";
    handle.style.background = "rgba(100, 181, 246, 0.2)";
  }
  
  function elementResize(e) {
    e = e || window.event;
    e.preventDefault();
    
    // Calculate new height
    const deltaY = e.clientY - startY;
    let newHeight = startHeight + deltaY;
    
    // Set minimum and maximum height constraints
    const minHeight = 200; // Minimum height to keep functionality
    const maxHeight = window.innerHeight - element.offsetTop - 20; // Leave some margin from bottom
    
    newHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));
    
    // Apply new height
    element.style.height = newHeight + "px";
    element.style.maxHeight = newHeight + "px";
    
    // Update transcript area height accordingly
    const headerHeight = 60; // Approximate header height
    const padding = 40; // Top and bottom padding
    const transcriptHeight = newHeight - headerHeight - padding;
    transcriptEl.style.maxHeight = transcriptHeight + "px";
  }
  
  function closeResizeElement() {
    // Stop resizing when mouse button is released
    document.onmouseup = null;
    document.onmousemove = null;
    
    // Remove visual feedback
    element.style.transition = "opacity 0.2s ease, transform 0.2s ease";
    handle.style.background = "transparent";
    
    // Save height to storage for persistence (with error handling)
    try {
      const height = parseInt(document.defaultView.getComputedStyle(element).height, 10);
      chrome.storage.local.set({
        translationPaneHeight: height
      });
    } catch (error) {
      // Ignore storage errors (extension context may be invalidated)
      console.log('[Storage] Could not save height - extension context may be invalidated');
    }
  }
}

ensureUi();

let translationSegments = [];
let isFirstTranslation = true;

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type === "DG_TRANSCRIPT_FINAL") {
    ensureUi();
    
    // Use detected language for better translation if available
    const sourceLanguage = msg.language || 'auto'; // Use detected language or auto-detect
    const translated = await translateText(msg.text, TARGET_LANG, sourceLanguage);
    
    // Enhanced speaker identification
    let speaker = msg.speaker || "Speaker";
    
    // Use lightweight speaker detection if available
    const activeSpeaker = getCurrentSpeaker();
    if (activeSpeaker) {
      // Map track ID to human-readable speaker name
      const speakerNumber = Array.from(participantTracks.keys()).indexOf(activeSpeaker) + 1;
      speaker = `Speaker ${speakerNumber}`;
      console.log(`[Speaker Detection] Mapped track ${activeSpeaker} to ${speaker}`);
    } else if (msg.speaker && msg.speaker !== "Speaker") {
      // Use Deepgram diarization as fallback
      speaker = msg.speaker;
    }
    
    // Log detected languages for debugging
    if (msg.detectedLanguages && msg.detectedLanguages.length > 0) {
      console.log(`🌍 Detected languages: ${msg.detectedLanguages.join(', ')}, dominant: ${msg.language}`);
    }
    
    // Remove placeholder if it exists
    const placeholder = document.getElementById("translation-placeholder");
    if (placeholder) {
      placeholder.remove();
    }
    
    // Add translation segment with speaker and language info
    if (translated && translated.trim()) {
      translationSegments.push({
        text: translated,
        originalText: msg.text,
        speaker: speaker,
        sourceLanguage: msg.language,
        detectedLanguages: msg.detectedLanguages,
        timestamp: Date.now(),
        trackId: activeSpeaker // Store track ID for debugging
      });
      
      // Update the display
      updateTranslationDisplay();
    }
    
    console.log(`${speaker} (${msg.language || 'unknown'}): ${translated}`);
  }

  if (msg?.type === "DG_TRANSCRIPT_INTERIM") {
    // Show interim translation subtly
    if (msg.text && msg.text.trim()) {
      const sourceLanguage = msg.language || 'auto';
      const translated = await translateText(msg.text, TARGET_LANG, sourceLanguage);
      
      // Enhanced speaker identification for interim transcripts
      let speaker = msg.speaker || "Speaker";
      const activeSpeaker = getCurrentSpeaker();
      if (activeSpeaker) {
        const speakerNumber = Array.from(participantTracks.keys()).indexOf(activeSpeaker) + 1;
        speaker = `Speaker ${speakerNumber}`;
      }
      
      showInterimTranslation(translated, speaker, msg.language);
    }
  }
});

function updateTranslationDisplay() {
  // Clear existing content
  transcriptEl.innerHTML = "";
  
  // Group segments by speaker and time proximity
  const groupedSegments = groupSegmentsBySpeaker(translationSegments);
  
  groupedSegments.forEach((group, index) => {
    // Create speaker section
    const speakerSection = document.createElement("div");
    speakerSection.style.marginBottom = index < groupedSegments.length - 1 ? "16px" : "8px";
    
    // Speaker label
    const speakerLabel = document.createElement("div");
    speakerLabel.style.fontSize = "13px";
    speakerLabel.style.fontWeight = "500";
    speakerLabel.style.color = "rgba(100, 181, 246, 0.8)";
    speakerLabel.style.marginBottom = "4px";
    speakerLabel.style.opacity = "0.9";
    speakerLabel.textContent = group.speaker;
    
    // Combined text for this speaker
    const textElement = document.createElement("div");
    textElement.style.fontSize = "16px";
    textElement.style.lineHeight = "1.6";
    textElement.style.color = "rgba(255, 255, 255, 0.95)";
    textElement.style.whiteSpace = "pre-wrap";
    textElement.style.wordWrap = "break-word";
    textElement.textContent = group.text;
    
    speakerSection.appendChild(speakerLabel);
    speakerSection.appendChild(textElement);
    transcriptEl.appendChild(speakerSection);
  });
  
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function groupSegmentsBySpeaker(segments) {
  if (segments.length === 0) return [];
  
  const groups = [];
  let currentGroup = {
    speaker: segments[0].speaker,
    text: segments[0].text,
    lastTimestamp: segments[0].timestamp
  };
  
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    const timeDiff = segment.timestamp - currentGroup.lastTimestamp;
    
    // If same speaker and within 5 seconds, append to current group
    if (segment.speaker === currentGroup.speaker && timeDiff < 5000) {
      currentGroup.text += " " + segment.text;
      currentGroup.lastTimestamp = segment.timestamp;
    } else {
      // Different speaker or long pause, start new group
      groups.push(currentGroup);
      currentGroup = {
        speaker: segment.speaker,
        text: segment.text,
        lastTimestamp: segment.timestamp
      };
    }
  }
  
  // Add the last group
  groups.push(currentGroup);
  return groups;
}

function showInterimTranslation(translatedText, speaker, sourceLanguage) {
  if (!translatedText || !translatedText.trim()) return;
  
  // Remove any existing interim element
  const existingInterim = document.getElementById("interim-translation");
  if (existingInterim) {
    existingInterim.remove();
  }
  
  // Create interim translation element
  const interimElement = document.createElement("div");
  interimElement.id = "interim-translation";
  interimElement.style.marginTop = "12px";
  interimElement.style.paddingTop = "8px";
  interimElement.style.borderTop = "1px solid rgba(255, 255, 255, 0.08)";
  
  // Interim speaker label
  const speakerLabel = document.createElement("div");
  speakerLabel.style.fontSize = "12px";
  speakerLabel.style.fontWeight = "500";
  speakerLabel.style.color = "rgba(100, 181, 246, 0.6)";
  speakerLabel.style.marginBottom = "3px";
  speakerLabel.textContent = speaker;
  
  // Interim text
  const textElement = document.createElement("div");
  textElement.style.fontSize = "15px";
  textElement.style.lineHeight = "1.5";
  textElement.style.color = "rgba(255, 255, 255, 0.6)";
  textElement.style.fontStyle = "italic";
  textElement.textContent = translatedText;
  
  interimElement.appendChild(speakerLabel);
  interimElement.appendChild(textElement);
  transcriptEl.appendChild(interimElement);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}
