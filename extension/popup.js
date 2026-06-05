const elements = {
  badge: document.getElementById("badge"),
  badgeIcon: document.getElementById("badgeIcon"),
  badgeText: document.getElementById("badgeText"),
  helpToggle: document.getElementById("helpToggle"),
  helpPanel: document.getElementById("helpPanel"),
  helpClose: document.getElementById("helpClose"),
  status: document.getElementById("status"),
  activity: document.getElementById("activity"),
  activityTitle: document.getElementById("activityTitle"),
  activityDetail: document.getElementById("activityDetail"),
  error: document.getElementById("error"),
  candidates: document.getElementById("candidates"),
  sourceSelect: document.getElementById("sourceSelect"),
  arm: document.getElementById("arm"),
  scan: document.getElementById("scan"),
  verifySource: document.getElementById("verifySource"),
  download: document.getElementById("download"),
  cancelDownload: document.getElementById("cancelDownload"),
  record: document.getElementById("record"),
  stop: document.getElementById("stop"),
  fallback: document.getElementById("fallback"),
  settingsToggle: document.getElementById("settingsToggle"),
  settingsPanel: document.getElementById("settingsPanel"),
  settingsClose: document.getElementById("settingsClose"),
  settingsSave: document.getElementById("settingsSave"),
  settingsDefaults: document.getElementById("settingsDefaults"),
  ytDlpPath: document.getElementById("ytDlpPath"),
  ffmpegDir: document.getElementById("ffmpegDir"),
  downloadDir: document.getElementById("downloadDir"),
  maxDownloadGb: document.getElementById("maxDownloadGb"),
  mergeFormat: document.getElementById("mergeFormat"),
  fragmentRetries: document.getElementById("fragmentRetries"),
  socketTimeout: document.getElementById("socketTimeout")
};

const DEFAULT_SETTINGS = {
  ytDlpPath: "C:\\yt-dlp\\yt-dlp.exe",
  ffmpegDir: "C:\\yt-dlp\\ffmpeg\\ffmpeg-7.1-essentials_build\\bin",
  downloadDir: "D:\\MyGitProjects\\chrome-course-capture\\downloads",
  maxDownloadGb: 10,
  mergeFormat: "mp4",
  fragmentRetries: 10,
  socketTimeout: 20
};

let activeTabId = null;
let lastState = null;
let timerId = null;
let renderThrottleId = null;
let pendingState = null;
let stopPending = false;

document.addEventListener("DOMContentLoaded", init);

chrome.runtime.onMessage.addListener(message => {
  if (message.type === "STATE_CHANGED" && message.tabId === activeTabId) {
    scheduleRender(message.state);
  }
});

async function init() {
  try {
    const config = await chrome.storage.local.get({ autoRecordFallback: true });
    elements.fallback.checked = !!config.autoRecordFallback;
    elements.fallback.addEventListener("change", () => {
      chrome.storage.local.set({ autoRecordFallback: elements.fallback.checked });
    });

    elements.arm.addEventListener("click", () => send("ARM"));
    elements.scan.addEventListener("click", () => send("SCAN_PAGE"));
    elements.sourceSelect.addEventListener("change", () => {
      if (lastState) render(lastState);
    });
    elements.verifySource.addEventListener("click", verifySelectedSource);
    elements.download.addEventListener("click", downloadSelectedSource);
    elements.cancelDownload.addEventListener("click", () => send("CANCEL_DOWNLOAD", { tabId: activeTabId }));
    elements.record.addEventListener("click", () => send("START_RECORD"));
    elements.stop.addEventListener("click", stopRecording);
    elements.helpToggle.addEventListener("click", toggleHelp);
    elements.helpClose.addEventListener("click", () => {
      elements.helpPanel.hidden = true;
    });
    elements.settingsToggle.addEventListener("click", toggleSettings);
    elements.settingsClose.addEventListener("click", () => {
      elements.settingsPanel.hidden = true;
    });
    elements.settingsSave.addEventListener("click", saveSettings);
    elements.settingsDefaults.addEventListener("click", () => fillSettings(DEFAULT_SETTINGS));

    const response = await send("GET_STATE");
    activeTabId = response.tabId;
    fillSettings(response.settings || DEFAULT_SETTINGS);
    render(response.state);
  } catch (error) {
    showError(`Popup не смог подключиться к background: ${error.message}`);
  }
}

function toggleSettings() {
  elements.helpPanel.hidden = true;
  elements.settingsPanel.hidden = !elements.settingsPanel.hidden;
}

function toggleHelp() {
  elements.settingsPanel.hidden = true;
  elements.helpPanel.hidden = !elements.helpPanel.hidden;
}

async function saveSettings() {
  const settings = readSettings();
  const response = await send("SAVE_SETTINGS", { settings });
  if (response.settings) fillSettings(response.settings);
  elements.status.textContent = "Настройки сохранены. Следующий запуск yt-dlp возьмет эти пути и лимиты.";
}

function fillSettings(settings) {
  const value = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  elements.ytDlpPath.value = value.ytDlpPath;
  elements.ffmpegDir.value = value.ffmpegDir;
  elements.downloadDir.value = value.downloadDir;
  elements.maxDownloadGb.value = value.maxDownloadGb;
  elements.mergeFormat.value = value.mergeFormat;
  elements.fragmentRetries.value = value.fragmentRetries;
  elements.socketTimeout.value = value.socketTimeout;
}

function readSettings() {
  return {
    ytDlpPath: elements.ytDlpPath.value.trim(),
    ffmpegDir: elements.ffmpegDir.value.trim(),
    downloadDir: elements.downloadDir.value.trim(),
    maxDownloadGb: Number(elements.maxDownloadGb.value),
    mergeFormat: elements.mergeFormat.value,
    fragmentRetries: Number(elements.fragmentRetries.value),
    socketTimeout: Number(elements.socketTimeout.value)
  };
}

async function send(type, extra = {}) {
  try {
    const timeoutMs = type === "START_RECORD" ? 120000 : 5000;
    const response = await sendWithTimeout({ type, ...extra }, timeoutMs);
    if (response && response.state) render(response.state);
    if (response && response.error) showError(response.error);
    return response || {};
  } catch (error) {
    showError(`Нет ответа от расширения: ${error.message}`);
    return {};
  }
}

async function stopRecording() {
  if (stopPending) return;
  stopPending = true;
  elements.stop.disabled = true;
  elements.stop.textContent = "…";
  await send("STOP_RECORD", { tabId: activeTabId });
}

function sendWithTimeout(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    chrome.runtime.sendMessage(message).then(response => {
      clearTimeout(timeout);
      resolve(response);
    }).catch(error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function showError(message) {
  setBadge("error", "!", "Ошибка");
  elements.status.textContent = "Ошибка расширения. Нажми Reload в chrome://extensions и попробуй снова.";
  elements.error.hidden = false;
  elements.error.textContent = message;
}

function render(state) {
  if (!state) return;
  lastState = state;
  ensureTimer(state);
  renderBadge(state);
  elements.status.textContent = state.status || "Ожидание.";
  renderActivity(state);

  elements.error.hidden = !state.error && !state.lastNativeError;
  elements.error.textContent = state.error || state.lastNativeError || "";
  renderSourceSelect(state);

  elements.arm.disabled = state.armed || state.busy || state.recording;
  elements.scan.disabled = state.busy || state.recording;
  elements.verifySource.disabled = state.busy || state.recording || !state.candidates.length || state.verifyingSource;
  elements.verifySource.textContent = state.verifyingSource ? "…" : "Проверить";
  elements.download.disabled = state.busy || state.recording || !selectedCandidateIsVerified(state);
  elements.cancelDownload.disabled = !state.downloading || state.cancellingDownload;
  elements.cancelDownload.textContent = state.cancellingDownload ? "…" : "■";
  elements.record.disabled = state.busy || state.recording;
  if (!state.recording) stopPending = false;
  elements.stop.disabled = !state.recording || stopPending;
  elements.stop.textContent = stopPending ? "…" : "Стоп";

  elements.candidates.innerHTML = "";
  for (const [index, candidate] of (state.candidates || []).entries()) {
    const item = document.createElement("li");
    const title = document.createElement("span");
    const url = document.createElement("button");
    const source = document.createElement("span");
    const detail = document.createElement("span");
    title.textContent = candidateOptionLabel(index, candidate, state.candidates || []);
    title.className = `candidate-title ${candidate.kind || "unknown"}`;
    url.textContent = displayCandidatePath(candidate);
    url.className = "url";
    url.title = candidate.url;
    url.addEventListener("click", () => navigator.clipboard.writeText(candidate.url));
    detail.textContent = displayCandidateHost(candidate);
    detail.className = "candidate-detail";
    source.textContent = `Найдено через: ${translateSource(candidate.source)}. Нажми URL, чтобы скопировать.`;
    source.className = "source";
    const check = renderCandidateCheck(candidate);
    item.append(title, detail, url, source);
    if (check) item.append(check);
    elements.candidates.append(item);
  }
}

function renderSourceSelect(state) {
  const previous = elements.sourceSelect.value;
  elements.sourceSelect.innerHTML = "";
  const candidates = state.candidates || [];
  if (!candidates.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Источники пока не найдены";
    elements.sourceSelect.append(option);
    elements.sourceSelect.disabled = true;
    return;
  }

  for (const [index, candidate] of candidates.entries()) {
    const option = document.createElement("option");
    option.value = candidate.url;
    option.textContent = candidateOptionLabel(index, candidate, candidates);
    option.title = candidate.url;
    elements.sourceSelect.append(option);
  }
  elements.sourceSelect.disabled = state.busy || state.recording;
  if ([...elements.sourceSelect.options].some(option => option.value === previous)) {
    elements.sourceSelect.value = previous;
  }
}

function verifySelectedSource() {
  const url = elements.sourceSelect.value;
  if (!url) return;
  send("VERIFY_CANDIDATE", { url });
}

function downloadSelectedSource() {
  const url = elements.sourceSelect.value;
  if (url) {
    send("DOWNLOAD_CANDIDATE", { url });
    return;
  }
  send("DOWNLOAD_BEST");
}

function selectedCandidateIsVerified(state) {
  const url = elements.sourceSelect.value;
  if (!url) return false;
  const candidate = (state.candidates || []).find(item => item.url === url);
  return !!(candidate && candidate.check && candidate.check.confirmed);
}

function renderCandidateCheck(candidate) {
  const check = candidate.check;
  if (!check) return null;
  const box = document.createElement("section");
  box.className = `source-check ${check.confirmed ? "ok" : "bad"}`;
  if (!check.ok) {
    box.textContent = `Проверка не прошла: ${check.error || "не удалось получить метаданные"}`;
    return box;
  }
  if (!check.confirmed) {
    box.textContent = `Не подтверждено: ${check.warning || "нет надежных метаданных"}${check.title ? ` · title: ${check.title}` : ""}${check.extractor ? ` · ${check.extractor}` : ""}`;
    return box;
  }
  const lines = [
    `Подтверждено: ${check.title || "без названия"}`,
    check.duration ? `Длительность: ${check.duration}` : "",
    check.extractor ? `Источник: ${check.extractor}` : "",
    check.size ? `Размер: ${check.size}` : ""
  ].filter(Boolean);
  box.textContent = lines.join(" · ");
  return box;
}

function renderBadge(state) {
  if (state.error || state.lastNativeError) {
    setBadge("error", "!", "Ошибка");
    return;
  }
  if (state.recording) {
    setBadge("recording", "●", "Запись");
    return;
  }
  if (state.downloading || state.busy) {
    setBadge("downloading", "↓", "Скачивает");
    return;
  }
  if (state.armed) {
    setBadge("armed", "◎", "Перехват");
    return;
  }
  setBadge("waiting", "⌛", "Ожидание");
}

function displayCandidateHost(candidate) {
  return `${candidate.host || "unknown host"}${candidate.path ? ` / ${displayCandidatePath(candidate)}` : ""}`;
}

function candidateOptionLabel(index, candidate, candidates) {
  const videoNumber = candidateVideoNumber(candidate, candidates);
  return `${index + 1}. ${candidateTypeLabel(candidate)} - видео ${videoNumber} - ${candidateVariantLabel(candidate)}`;
}

function candidateTypeLabel(candidate) {
  if (candidate.kind === "embed") return "плеер";
  if (candidate.kind === "hls") return "HLS PL";
  if (candidate.kind === "dash") return "DASH";
  if (candidate.kind === "file") return "видеофайл";
  if (candidate.kind === "segment") return "сегмент";
  if (candidate.kind === "playback") return "video playback";
  return "URL";
}

function candidateVideoNumber(candidate, candidates) {
  const keys = [];
  for (const item of candidates) {
    const key = candidateGroupKey(item);
    if (!keys.includes(key)) keys.push(key);
  }
  return Math.max(1, keys.indexOf(candidateGroupKey(candidate)) + 1);
}

function candidateGroupKey(candidate) {
  try {
    const parsed = new URL(candidate.url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const playlistIndex = parts.findIndex(part => /^(master|media|get-master-playlist|get-media-playlist)$/i.test(part));
    if (playlistIndex >= 0 && parts[playlistIndex + 1]) {
      return `${parsed.host}:video:${parts[playlistIndex + 1]}`;
    }
    const videoId = parsed.searchParams.get("id") || parsed.searchParams.get("video") || parsed.searchParams.get("oid");
    if (videoId) return `${parsed.host}:video:${videoId}`;
    return `${parsed.host}:${parts.slice(0, 4).join("/") || parsed.pathname}`;
  } catch {
    return `${candidate.host || "unknown"}:${candidate.kind || "unknown"}`;
  }
}

function candidateVariantLabel(candidate) {
  const text = `${candidate.url} ${candidate.path || ""}`;
  if (/master|get-master-playlist|\/master(\/|$|\?)/i.test(text)) return "master";
  if (/sign-player/i.test(text)) return "sign/API";
  const quality = text.match(/(?:\/|_|-)(240|360|480|540|720|1080|1440|2160)(?:p)?(?:\/|\.|_|-|\?|$)/i);
  if (quality) {
    const height = Number(quality[1]);
    if (height < 720) return `${height}p (нет 720+)`;
    if (height < 1080) return `HD ${height}p`;
    return `FullHD ${height}p`;
  }
  if (candidate.kind === "hls") return "HLS";
  if (candidate.kind === "dash") return "DASH";
  if (candidate.kind === "embed") return "player";
  if (candidate.kind === "file") return "file";
  return candidate.label || "source";
}

function displayCandidatePath(candidate) {
  const value = String(candidate.path || "");
  if (!value) return shortUrl(candidate.url);
  return value
    .replace(/[?&#].*$/, "")
    .replace(/([A-Za-z0-9_-]{18,})/g, token => `${token.slice(0, 8)}...`)
    .slice(0, 90);
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.split("/").filter(Boolean).slice(-2).join("/");
    return path || parsed.host;
  } catch {
    return String(url || "").slice(0, 90);
  }
}

function setBadge(kind, icon, text) {
  elements.badge.className = kind;
  elements.badgeIcon.textContent = icon;
  elements.badgeText.textContent = text;
}

function scheduleRender(state) {
  pendingState = state;
  if (renderThrottleId) return;
  renderThrottleId = setTimeout(() => {
    renderThrottleId = null;
    render(pendingState);
    pendingState = null;
  }, 500);
}

function renderActivity(state) {
  elements.activity.className = "activity";
  if (state.recording) {
    elements.activity.classList.add("recording");
    elements.activityTitle.textContent = `ИДЕТ ЗАПИСЬ ${formatElapsed(state.recordingStartedAt)}`;
    const recordedSize = formatBytes(state.recordingBytes || 0);
    elements.activityDetail.textContent = recordedSize
      ? `Пишу текущую вкладку вместе с аудио. Уже записано ${recordedSize}. Нажми Стоп, чтобы сохранить .webm.`
      : "Пишу текущую вкладку вместе с аудио. Нажми Стоп, чтобы сохранить .webm.";
    return;
  }
  if (state.busy) {
    elements.activity.classList.add("downloading");
    elements.activityTitle.textContent = "⌛ ИДЕТ СКАЧИВАНИЕ";
    elements.activityDetail.textContent = "Работает yt-dlp. Файл появится в папке \"Куда сохранять\", если скачивание успешно.";
    return;
  }
  if (state.armed) {
    elements.activity.classList.add("armed");
    elements.activityTitle.textContent = "ПЕРЕХВАТ ВКЛЮЧЕН";
    elements.activityDetail.textContent = "Запусти видео на странице. Если найденный URL не скачается, включится запись вкладки.";
    return;
  }
  elements.activity.classList.add("idle");
  elements.activityTitle.textContent = "ОЖИДАНИЕ";
  elements.activityDetail.textContent = "Нажми Начать перехват видео, затем запусти видео.";
}

function ensureTimer(state) {
  if (state.recording && !timerId) {
    timerId = setInterval(() => {
      if (lastState) renderActivity(lastState);
    }, 1000);
  }
  if (!state.recording && timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

function formatElapsed(startedAt) {
  if (!startedAt) return "00:00";
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = size >= 10 || index === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[index]}`;
}

function translateSource(source) {
  if (!source) return "неизвестно";
  if (source === "video") return "тег video на странице";
  if (source === "iframe") return "iframe-плеер";
  if (source === "response") return "ответ JS/API запроса";
  if (source === "page") return "ресурсы страницы";
  if (source.startsWith("network:")) return `сетевой запрос ${source.slice("network:".length)}`;
  return source;
}
