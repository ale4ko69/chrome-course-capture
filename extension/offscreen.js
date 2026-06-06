// Video Course Capture
// Developed and maintained by Alexey Kagansky
// Copyright (c) 2026 Alexey Kagansky
// Repository: https://github.com/ale4ko69/chrome-course-capture

let recorder = null;
let currentTabId = null;
let currentTitle = "course-recording";
let currentRecordingId = "";
let currentFilename = "";
let stream = null;
let outputStream = null;
let sourceVideo = null;
let cropCanvas = null;
let cropContext = null;
let drawFrameId = 0;
let drawTimerId = 0;
let sampleCanvas = null;
let sampleContext = null;
let freezeTimer = 0;
let freezeLastPixels = null;
let freezeSince = 0;
let freezeStartedAt = 0;
let freezeAnalyser = null;
let freezeAudioData = null;
let audioContext = null;
let chunkQueue = Promise.resolve();
let chunkError = null;
let chunkIndex = 0;

const FREEZE_CHECK_MS = 2000;
const FREEZE_GRACE_MS = 20000;
const FREEZE_STOP_AFTER_MS = 45000;
const FREEZE_PIXEL_DELTA = 1.5;
const FREEZE_AUDIO_RMS = 0.01;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !["START_OFFSCREEN_RECORDING", "STOP_OFFSCREEN_RECORDING"].includes(message.type)) {
    return false;
  }

  handleMessage(message).then(sendResponse).catch(error => {
    sendStatus(currentTabId, `Ошибка записи: ${error.message}`, false, error.message);
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

async function handleMessage(message) {
  if (message.type === "START_OFFSCREEN_RECORDING") {
    await startRecording(message.tabId, message.streamId, message.title, message.crop);
    return { ok: true };
  }
  if (message.type === "STOP_OFFSCREEN_RECORDING") {
    stopRecording(message.tabId);
    return { ok: true };
  }
  return { ok: false, error: "Unknown offscreen message" };
}

async function startRecording(tabId, streamId, title, crop) {
  if (recorder && recorder.state !== "inactive") {
    throw new Error("Recorder is already running");
  }

  currentTabId = tabId;
  currentTitle = title || "course-recording";
  currentRecordingId = `${tabId}-${Date.now()}`;
  currentFilename = `${sanitizeFileName(currentTitle)}-${timestamp()}.webm`;
  chunkQueue = Promise.resolve();
  chunkError = null;
  chunkIndex = 0;

  const startResponse = await chrome.runtime.sendMessage({
    type: "RECORDING_START",
    tabId,
    recordingId: currentRecordingId,
    filename: currentFilename
  });
  if (!startResponse || !startResponse.ok) {
    throw new Error(startResponse && startResponse.error ? startResponse.error : "Native recording start failed");
  }

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  });

  audioContext = new AudioContext();
  const audioSource = audioContext.createMediaStreamSource(stream);
  audioSource.connect(audioContext.destination);
  freezeAnalyser = audioContext.createAnalyser();
  freezeAnalyser.fftSize = 512;
  freezeAudioData = new Uint8Array(freezeAnalyser.fftSize);
  audioSource.connect(freezeAnalyser);

  outputStream = crop && crop.rect
    ? await createCroppedStream(stream, crop, audioSource)
    : stream;
  if (crop && crop.rect) {
    startFreezeMonitor();
  }

  const mimeType = pickMimeType();
  recorder = new MediaRecorder(outputStream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = event => {
    if (event.data && event.data.size > 0) {
      const index = chunkIndex++;
      chunkQueue = chunkQueue
        .then(() => sendChunk(event.data, index))
        .catch(error => {
          chunkError = error;
          sendStatus(currentTabId, `Ошибка записи чанка: ${error.message}`, true, error.message);
        });
    }
  };
  recorder.onstop = finishRecording;
  recorder.start(1000);
  sendStatus(tabId, crop && crop.rect ? "Идет запись области плеера вместе с аудио..." : "Идет запись текущей вкладки вместе с аудио...", true);
}

async function createCroppedStream(inputStream, crop, audioSource) {
  sourceVideo = document.createElement("video");
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  sourceVideo.srcObject = inputStream;
  await sourceVideo.play();
  await waitForVideoSize(sourceVideo);

  const rect = crop.rect || {};
  const viewport = crop.viewport || {};
  const viewportWidth = Number(viewport.width) || sourceVideo.videoWidth;
  const viewportHeight = Number(viewport.height) || sourceVideo.videoHeight;
  const scaleX = sourceVideo.videoWidth / viewportWidth;
  const scaleY = sourceVideo.videoHeight / viewportHeight;
  const sourceX = clamp(Math.round((Number(rect.x) || 0) * scaleX), 0, sourceVideo.videoWidth - 1);
  const sourceY = clamp(Math.round((Number(rect.y) || 0) * scaleY), 0, sourceVideo.videoHeight - 1);
  const sourceWidth = clamp(Math.round((Number(rect.width) || sourceVideo.videoWidth) * scaleX), 1, sourceVideo.videoWidth - sourceX);
  const sourceHeight = clamp(Math.round((Number(rect.height) || sourceVideo.videoHeight) * scaleY), 1, sourceVideo.videoHeight - sourceY);
  sendStatus(
    currentTabId,
    `Кроп записи: ${Math.round(Number(rect.width) || 0)}x${Math.round(Number(rect.height) || 0)} CSS -> ${sourceWidth}x${sourceHeight} видео.`,
    true
  );

  cropCanvas = document.createElement("canvas");
  cropCanvas.width = sourceWidth;
  cropCanvas.height = sourceHeight;
  cropContext = cropCanvas.getContext("2d", { alpha: false });

  const videoTrack = cropCanvas.captureStream(0).getVideoTracks()[0];
  const audioDestination = audioContext.createMediaStreamDestination();
  audioSource.connect(audioDestination);

  function draw() {
    if (!sourceVideo || !cropContext) return;
    cropContext.drawImage(sourceVideo, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
    if (typeof videoTrack.requestFrame === "function") {
      videoTrack.requestFrame();
    }
  }
  draw();
  drawTimerId = setInterval(draw, 1000 / 30);

  return new MediaStream([
    videoTrack,
    ...audioDestination.stream.getAudioTracks()
  ]);
}

function startFreezeMonitor() {
  sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = 32;
  sampleCanvas.height = 18;
  sampleContext = sampleCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  freezeLastPixels = null;
  freezeSince = 0;
  freezeStartedAt = Date.now();
  freezeTimer = setInterval(checkForFrozenStream, FREEZE_CHECK_MS);
}

function checkForFrozenStream() {
  if (!recorder || recorder.state !== "recording" || !cropCanvas || !sampleContext) return;
  if (Date.now() - freezeStartedAt < FREEZE_GRACE_MS) return;

  sampleContext.drawImage(cropCanvas, 0, 0, sampleCanvas.width, sampleCanvas.height);
  const pixels = sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
  const audioLevel = getAudioRms();
  if (!freezeLastPixels) {
    freezeLastPixels = new Uint8ClampedArray(pixels);
    return;
  }

  const delta = averagePixelDelta(pixels, freezeLastPixels);
  freezeLastPixels.set(pixels);
  const looksFrozen = delta < FREEZE_PIXEL_DELTA && audioLevel < FREEZE_AUDIO_RMS;
  if (!looksFrozen) {
    freezeSince = 0;
    return;
  }

  if (!freezeSince) {
    freezeSince = Date.now();
    return;
  }

  if (Date.now() - freezeSince >= FREEZE_STOP_AFTER_MS) {
    sendStatus(currentTabId, "Похоже, поток завис: картинка не меняется и звук молчит. Останавливаю запись текущего куска...", true);
    stopRecording(currentTabId, "Поток завис. Сохраняю текущий кусок...");
  }
}

function averagePixelDelta(current, previous) {
  let total = 0;
  for (let index = 0; index < current.length; index += 4) {
    total += Math.abs(current[index] - previous[index]);
    total += Math.abs(current[index + 1] - previous[index + 1]);
    total += Math.abs(current[index + 2] - previous[index + 2]);
  }
  return total / ((current.length / 4) * 3);
}

function getAudioRms() {
  if (!freezeAnalyser || !freezeAudioData) return 1;
  freezeAnalyser.getByteTimeDomainData(freezeAudioData);
  let sum = 0;
  for (const value of freezeAudioData) {
    const centered = (value - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / freezeAudioData.length);
}

function waitForVideoSize(video) {
  if (video.videoWidth && video.videoHeight) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Не смог получить размер потока вкладки.")), 5000);
    video.onloadedmetadata = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}

function stopRecording(tabId, reason = "") {
  const statusTabId = typeof currentTabId === "number" ? currentTabId : tabId;
  if (!recorder || recorder.state === "inactive") {
    sendStatus(statusTabId, "Запись уже не идет.", false);
    return;
  }
  if (freezeTimer) {
    clearInterval(freezeTimer);
    freezeTimer = 0;
  }
  sendStatus(statusTabId, reason || "Останавливаю запись и сохраняю файл...", true);
  if (recorder.state === "recording") {
    recorder.requestData();
  }
  recorder.stop();
}

async function finishRecording() {
  const tabId = currentTabId;
  try {
    await chunkQueue;
    if (chunkError) {
      throw chunkError;
    }
    const response = await chrome.runtime.sendMessage({
      type: "RECORDING_STOP",
      tabId,
      recordingId: currentRecordingId
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Native recording stop failed");
    }
    const message = response.response && response.response.message || `Запись сохранена: ${currentFilename}`;
    sendStatus(tabId, message, false);
  } catch (error) {
    sendStatus(tabId, `Не смог сохранить запись: ${error.message}`, false, error.message);
  } finally {
    cleanup();
  }
}

function cleanup() {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
  if (outputStream && outputStream !== stream) {
    for (const track of outputStream.getTracks()) track.stop();
  }
  if (drawFrameId) cancelAnimationFrame(drawFrameId);
  if (drawTimerId) clearInterval(drawTimerId);
  if (freezeTimer) clearInterval(freezeTimer);
  if (sourceVideo) {
    sourceVideo.pause();
    sourceVideo.srcObject = null;
  }
  if (audioContext) audioContext.close().catch(() => {});
  recorder = null;
  currentTabId = null;
  currentRecordingId = "";
  currentFilename = "";
  stream = null;
  outputStream = null;
  sourceVideo = null;
  cropCanvas = null;
  cropContext = null;
  drawFrameId = 0;
  drawTimerId = 0;
  sampleCanvas = null;
  sampleContext = null;
  freezeTimer = 0;
  freezeLastPixels = null;
  freezeSince = 0;
  freezeStartedAt = 0;
  freezeAnalyser = null;
  freezeAudioData = null;
  audioContext = null;
  chunkQueue = Promise.resolve();
  chunkError = null;
  chunkIndex = 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function sendChunk(blob, index) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const data = bytesToBase64(bytes);
  const response = await chrome.runtime.sendMessage({
    type: "RECORDING_CHUNK",
    tabId: currentTabId,
    recordingId: currentRecordingId,
    index,
    size: bytes.byteLength,
    data
  });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "Native recording chunk failed");
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

function pickMimeType() {
  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return types.find(type => MediaRecorder.isTypeSupported(type)) || "";
}

function sendStatus(tabId, status, recording, error = "") {
  if (typeof tabId !== "number") return;
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_STATUS",
    tabId,
    status,
    recording,
    error
  }).catch(() => {});
}

function sanitizeFileName(value) {
  return String(value || "course-recording")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "course-recording";
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
