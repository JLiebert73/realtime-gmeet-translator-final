// Offscreen document: uses tabCapture streamId to getUserMedia, streams PCM to Deepgram, relays transcripts back

let mediaStream;
let ws;
let bgPort;
let keepAliveTimer = null;
let triedOpusFallback = false;

let audioContext;
let sourceNode;
let processorNode;
let destinationNode;
const TARGET_SAMPLE_RATE = 16000;
let currentMode = 'pcm'; // 'pcm' | 'opus'
let mediaRecorder;
let lastApiKey = '';
let pcmQueue = [];
let pcmBytesPending = 0;
const PCM_TARGET_CHUNK_BYTES = 3200; // ~100ms at 16kHz mono 16-bit

function connectBg() {
  if (!bgPort) bgPort = chrome.runtime.connect({ name: 'offscreen-port' });
}

function postStatus(text) {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', text }).catch(() => {});
}

async function startWithStreamId(streamId, apiKey) {
  lastApiKey = apiKey;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
  } catch (e) {
    if (e?.name === 'NotAllowedError' || e?.message?.toLowerCase().includes('dismissed')) {
      postStatus('Please allow the capture prompt, then press Start again.');
      throw e;
    }
    throw e;
  }
  await setupAudioPipeline();
  openDeepgramPCM(apiKey);
}

function openDeepgramPCM(apiKey) {
  // All config in query string - add diarization and multilingual support
  const params = new URLSearchParams({
    model: 'nova-3-general',          // Use Nova-3 for multilingual support
    language: 'multi',               // Enable multilingual code-switching
    encoding: 'linear16',
    sample_rate: TARGET_SAMPLE_RATE.toString(),
    channels: '1',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    vad_events: 'true',
    diarize: 'true',                 // Enable speaker diarization
    endpointing: '100'               // Recommended 100ms for code-switching
  });
  const url = `wss://api.deepgram.com/v1/listen?${params}`;

  ws = new WebSocket(url, ['token', apiKey]);
  currentMode = 'pcm';
  attachWsHandlers();
}

async function stopAll() {
  try { processorNode?.disconnect(); } catch {}
  try { sourceNode?.disconnect(); } catch {}
  try { destinationNode?.disconnect(); } catch {}
  try { await audioContext?.close(); } catch {}
  audioContext = null;
  try { mediaStream?.getTracks().forEach(t => t.stop()); } catch {}
  mediaStream = null;
  try { ws?.close(); } catch {}
  ws = null;
  if (keepAliveTimer) { try { clearInterval(keepAliveTimer); } catch {} keepAliveTimer = null; }
  try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch {}
}

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type === 'OFFSCREEN_START') {
    try {
      await startWithStreamId(msg.streamId, msg.dgApiKey);
    } catch (e) {
      postStatus(`Error: ${e.message}`);
    }
  }
  if (msg?.type === 'OFFSCREEN_STOP') {
    await stopAll();
  }
});

async function setupAudioPipeline() {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    try { await audioContext.resume(); } catch {}
  }
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  
  // Create destination for playback
  destinationNode = audioContext.createMediaStreamDestination();
  
  // Set up audio playback
  const playbackAudio = document.getElementById('playbackAudio');
  if (playbackAudio) {
    playbackAudio.srcObject = destinationNode.stream;
  }
  
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL('worklet.js'));
  processorNode = new AudioWorkletNode(audioContext, 'pcm-worklet');
  processorNode.port.onmessage = (evt) => {
    const input = evt.data;
    if (!input) return;
    console.log("Captured samples:", input.length);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (currentMode !== 'pcm') return;
    const down = downsampleBuffer(input, audioContext.sampleRate, TARGET_SAMPLE_RATE);
    const pcm = floatTo16BitPCM(down);
    enqueuePcm(pcm);
  };
  
  // Connect audio for both transcription and playback
  sourceNode.connect(processorNode);
  sourceNode.connect(destinationNode);
}

function attachWsHandlers() {
  if (!ws) return;
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    postStatus('Connected to Deepgram');
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      } catch {}
    }, 5000);
  };

  ws.onmessage = (evt) => {
    console.log("Deepgram msg:", evt.data); // debug
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type === 'Results' && msg.channel?.alternatives?.[0]) {
      const alt = msg.channel.alternatives[0];
      const text = alt.transcript || '';
      if (!text) return;
      
      // Extract speaker information from diarization
      let speaker = "Unknown Speaker";
      if (alt.words && alt.words.length > 0) {
        // Find the most frequent speaker in this segment
        const speakerCounts = {};
        alt.words.forEach(word => {
          if (word.speaker !== undefined) {
            const speakerId = `Speaker ${word.speaker}`;
            speakerCounts[speakerId] = (speakerCounts[speakerId] || 0) + 1;
          }
        });
        
        // Get the speaker with the most words in this segment
        const dominantSpeaker = Object.keys(speakerCounts).reduce((a, b) => 
          speakerCounts[a] > speakerCounts[b] ? a : b, Object.keys(speakerCounts)[0]);
        
        if (dominantSpeaker) {
          speaker = dominantSpeaker;
        }
      }
      
      // Extract language information for multilingual support
      let detectedLanguages = [];
      let dominantLanguage = 'en'; // default fallback
      
      // Get languages from the alternative level (overall detected languages)
      if (alt.languages && Array.isArray(alt.languages)) {
        detectedLanguages = alt.languages;
        dominantLanguage = alt.languages[0] || 'en'; // First is most dominant
      }
      
      // If we have word-level language detection, find the dominant language in this segment
      if (alt.words && alt.words.length > 0) {
        const languageCounts = {};
        alt.words.forEach(word => {
          if (word.language) {
            languageCounts[word.language] = (languageCounts[word.language] || 0) + 1;
          }
        });
        
        if (Object.keys(languageCounts).length > 0) {
          dominantLanguage = Object.keys(languageCounts).reduce((a, b) => 
            languageCounts[a] > languageCounts[b] ? a : b);
        }
      }
      
      const isFinal = msg.is_final === true;
      connectBg();
      bgPort?.postMessage({
        type: isFinal ? 'DG_TRANSCRIPT_FINAL' : 'DG_TRANSCRIPT_INTERIM',
        text,
        speaker,
        language: dominantLanguage,
        detectedLanguages: detectedLanguages,
        words: alt.words // Include word-level data for advanced processing
      });
    } else if (msg.type && msg.type.toLowerCase().includes('error')) {
      postStatus(`Deepgram error: ${msg.message || msg.reason || msg.type}`);
    }
  };

  ws.onerror = () => {
    postStatus('Deepgram socket error');
  };

  ws.onclose = (evt) => {
    if (keepAliveTimer) { try { clearInterval(keepAliveTimer); } catch {} keepAliveTimer = null; }
    postStatus(`Deepgram socket closed (${evt.code}) ${evt.reason || ''}`);
    if (currentMode === 'pcm' && !triedOpusFallback) {
      triedOpusFallback = true;
      try {
        startOpusFallback();
      } catch {}
    }
  };
}

function startOpusFallback() {
  const params = new URLSearchParams({
    model: 'nova-3-general',          // Use Nova-3 for multilingual support
    language: 'multi',               // Enable multilingual code-switching
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    vad_events: 'true',
    encoding: 'opus',
    container: 'webm',
    diarize: 'true',                 // Enable speaker diarization in fallback mode too
    endpointing: '100'               // Recommended 100ms for code-switching
  });
  const url = `wss://api.deepgram.com/v1/listen?${params}`;
  try { ws?.close(); } catch {}
  ws = new WebSocket(url, ['token', lastApiKey]);
  currentMode = 'opus';
  attachWsHandlers();

  const mimeType = 'audio/webm;codecs=opus';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    postStatus('Opus fallback unsupported');
    return;
  }
  try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch {}
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType, audioBitsPerSecond: 64000 });
  mediaRecorder.ondataavailable = async (e) => {
    if (!e.data || e.data.size === 0) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(await e.data.arrayBuffer()); } catch {}
  };
  mediaRecorder.start(250);
}

function downsampleBuffer(buffer, sampleRate, outSampleRate) {
  if (outSampleRate === sampleRate) return buffer;
  if (outSampleRate > sampleRate) throw new Error('Downsampling rate should be smaller than original');
  const sampleRateRatio = sampleRate / outSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0, count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = accum / (count || 1);
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function enqueuePcm(arrayBuffer) {
  pcmQueue.push(arrayBuffer);
  pcmBytesPending += arrayBuffer.byteLength;
  while (pcmBytesPending >= PCM_TARGET_CHUNK_BYTES) {
    let toSend = PCM_TARGET_CHUNK_BYTES;
    const out = new Uint8Array(PCM_TARGET_CHUNK_BYTES);
    let offset = 0;
    while (toSend > 0 && pcmQueue.length) {
      const head = new Uint8Array(pcmQueue[0]);
      const take = Math.min(toSend, head.byteLength);
      out.set(head.subarray(0, take), offset);
      offset += take;
      toSend -= take;
      if (take < head.byteLength) {
        const remaining = head.subarray(take);
        pcmQueue[0] = remaining.buffer.slice(remaining.byteOffset, remaining.byteOffset + remaining.byteLength);
      } else {
        pcmQueue.shift();
      }
    }
    pcmBytesPending -= PCM_TARGET_CHUNK_BYTES;
    console.log("Sending PCM chunk of", out.byteLength, "bytes"); // debug
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(out.buffer); } catch {}
  }
}
