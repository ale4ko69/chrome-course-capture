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
  settingsToggle: document.getElementById("settingsToggle"),
  settingsPanel: document.getElementById("settingsPanel"),
  settingsClose: document.getElementById("settingsClose"),
  settingsSave: document.getElementById("settingsSave"),
  settingsDefaults: document.getElementById("settingsDefaults"),
  language: document.getElementById("language"),
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
let currentLanguage = "ru";
let messages = {};

document.addEventListener("DOMContentLoaded", init);

chrome.runtime.onMessage.addListener(message => {
  if (message.type === "STATE_CHANGED" && message.tabId === activeTabId) {
    scheduleRender(message.state);
  }
});

async function init() {
  try {
    const config = await chrome.storage.local.get(["language"]);
    currentLanguage = normalizeLanguage(config.language || detectDefaultLanguage());
    messages = await loadMessages(currentLanguage);
    elements.language.value = currentLanguage;
    applyTranslations();

    elements.language.addEventListener("change", changeLanguage);

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
    showError(t("errors.popupConnect", { error: error.message }));
  }
}

async function changeLanguage() {
  currentLanguage = normalizeLanguage(elements.language.value);
  messages = await loadMessages(currentLanguage);
  await chrome.storage.local.set({ language: currentLanguage });
  applyTranslations();
  if (lastState) render(lastState);
}

function normalizeLanguage(language) {
  return language === "en" ? "en" : "ru";
}

function detectDefaultLanguage() {
  const locales = [
    chrome.i18n && typeof chrome.i18n.getUILanguage === "function" ? chrome.i18n.getUILanguage() : "",
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language || ""
  ];
  return locales.some(isRussianLocale) ? "ru" : "en";
}

function isRussianLocale(locale) {
  const language = String(locale || "").trim().toLowerCase().split(/[-_]/)[0];
  return ["ru", "be", "uk", "kk", "ky", "uz", "tg", "az", "hy", "ka", "mo"].includes(language);
}

async function loadMessages(language) {
  const url = chrome.runtime.getURL(`locales/${language}.json`);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (language !== "ru") return loadMessages("ru");
    console.warn("Course Capture could not load locale", language, error);
    return {};
  }
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach(element => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-html]").forEach(element => {
    element.innerHTML = t(element.dataset.i18nHtml);
  });
  document.querySelectorAll("[data-i18n-title]").forEach(element => {
    element.title = t(element.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach(element => {
    element.setAttribute("aria-label", t(element.dataset.i18nAria));
  });
  document.documentElement.lang = currentLanguage;
}

function t(key, params = {}) {
  let value = getMessageValue(key);
  if (typeof value !== "string") return key;
  for (const [name, replacement] of Object.entries(params)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

function getMessageValue(key) {
  return String(key || "").split(".").reduce((value, part) => {
    return value && Object.prototype.hasOwnProperty.call(value, part) ? value[part] : undefined;
  }, messages);
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
  elements.status.textContent = t("status.settingsSaved");
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
    const timeoutMs = commandTimeoutMs(type);
    const response = await sendWithTimeout({ type, ...extra }, timeoutMs);
    if (response && response.state) render(response.state);
    if (response && response.error && !shouldSuppressCommandError(type, response.state || lastState)) {
      showError(response.error);
    }
    return response || {};
  } catch (error) {
    if (shouldSuppressCommandError(type, lastState)) {
      return {};
    }
    showError(t("errors.noExtensionResponse", { error: error.message }));
    return {};
  }
}

function commandTimeoutMs(type) {
  if (type === "START_RECORD") return 120000;
  if (type === "VERIFY_CANDIDATE") return 90000;
  if (type === "DOWNLOAD_CANDIDATE" || type === "DOWNLOAD_BEST") return 30000;
  return 5000;
}

function shouldSuppressCommandError(type, state) {
  if (!state) return false;
  if (type === "VERIFY_CANDIDATE") return !!state.verifyingSource;
  if (type === "DOWNLOAD_CANDIDATE" || type === "DOWNLOAD_BEST") {
    return !!(state.downloading || state.busy || state.downloadProgress);
  }
  return false;
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
  setBadge("error", "!", t("badges.error"));
  elements.status.textContent = t("errors.reloadExtension");
  elements.error.hidden = false;
  elements.error.textContent = message;
}

function render(state) {
  if (!state) return;
  lastState = state;
  ensureTimer(state);
  renderBadge(state);
  elements.status.textContent = localizeStatus(state.status) || t("status.idle");
  renderActivity(state);

  elements.error.hidden = !state.error && !state.lastNativeError;
  elements.error.textContent = state.error || state.lastNativeError || "";
  renderSourceSelect(state);

  elements.arm.disabled = state.armed || state.busy || state.recording;
  elements.scan.disabled = state.busy || state.recording;
  elements.verifySource.disabled = state.busy || state.recording || !state.candidates.length || state.verifyingSource;
  elements.verifySource.textContent = state.verifyingSource ? "…" : t("actions.verify");
  elements.download.disabled = state.busy || state.recording || !selectedCandidateIsVerified(state);
  elements.cancelDownload.disabled = !state.downloading || state.cancellingDownload;
  elements.cancelDownload.textContent = state.cancellingDownload ? "…" : "■";
  elements.record.disabled = state.busy || state.recording;
  if (!state.recording) stopPending = false;
  elements.stop.disabled = !state.recording || stopPending;
  elements.stop.textContent = stopPending ? "…" : t("actions.stop");

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
    source.textContent = t("sources.foundVia", { source: translateSource(candidate.source) });
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
    option.textContent = t("sources.none");
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
    box.textContent = t("check.failed", { error: check.error || t("check.noMetadata") });
    return box;
  }
  if (!check.confirmed) {
    box.textContent = [
      t("check.notConfirmed", { warning: check.warning || t("check.noReliableMetadata") }),
      check.title ? `title: ${check.title}` : "",
      check.extractor || ""
    ].filter(Boolean).join(" · ");
    return box;
  }
  const lines = [
    t("check.confirmed", { title: check.title || t("check.untitled") }),
    check.duration ? t("check.duration", { duration: check.duration }) : "",
    check.extractor ? t("check.extractor", { extractor: check.extractor }) : "",
    check.size ? t("check.size", { size: check.size }) : ""
  ].filter(Boolean);
  box.textContent = lines.join(" · ");
  return box;
}

function renderBadge(state) {
  if (state.error || state.lastNativeError) {
    setBadge("error", "!", t("badges.error"));
    return;
  }
  if (state.recording) {
    setBadge("recording", "●", t("badges.recording"));
    return;
  }
  if (state.downloading || state.busy) {
    setBadge("downloading", "↓", t("badges.downloading"));
    return;
  }
  if (state.armed) {
    setBadge("armed", "◎", t("badges.armed"));
    return;
  }
  setBadge("waiting", "⌛", t("badges.waiting"));
}

function displayCandidateHost(candidate) {
  return `${candidate.host || "unknown host"}${candidate.path ? ` / ${displayCandidatePath(candidate)}` : ""}`;
}

function candidateOptionLabel(index, candidate, candidates) {
  const videoNumber = candidateVideoNumber(candidate, candidates);
  return t("candidate.option", {
    index: index + 1,
    type: candidateTypeLabel(candidate),
    video: videoNumber,
    variant: candidateVariantLabel(candidate)
  });
}

function candidateTypeLabel(candidate) {
  if (candidate.kind === "youtube") return "YouTube";
  if (candidate.kind === "vkvideo") return "VK Video";
  if (candidate.kind === "embed") return t("candidate.types.player");
  if (candidate.kind === "hls") return "HLS PL";
  if (candidate.kind === "dash") return "DASH";
  if (candidate.kind === "file") return t("candidate.types.file");
  if (candidate.kind === "segment") return t("candidate.types.segment");
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
    const youtubeId = youtubeVideoIdFromUrl(parsed);
    if (youtubeId) return `youtube:video:${youtubeId}`;
    const vkId = vkVideoIdFromUrl(parsed);
    if (vkId) return `vkvideo:video:${vkId}`;
    if (/googlevideo\.com$/i.test(parsed.hostname) || /videoplayback/i.test(parsed.pathname)) {
      return `youtube:playback:${parsed.searchParams.get("id") || "current"}`;
    }
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
  if (candidate.kind === "vkvideo") return t("candidate.variants.currentVideo");
  if (candidate.kind === "youtube") return t("candidate.variants.currentVideo");
  if (/master|get-master-playlist|\/master(\/|$|\?)/i.test(text)) return "master";
  if (/sign-player/i.test(text)) return "sign/API";
  const quality = text.match(/(?:\/|_|-)(240|360|480|540|720|1080|1440|2160)(?:p)?(?:\/|\.|_|-|\?|$)/i);
  if (quality) {
    const height = Number(quality[1]);
    if (height < 720) return t("candidate.lowFallback", { height });
    if (height < 1080) return `HD ${height}p`;
    return `FullHD ${height}p`;
  }
  if (candidate.kind === "hls") return "HLS";
  if (candidate.kind === "dash") return "DASH";
  if (candidate.kind === "embed") return t("candidate.variants.player");
  if (candidate.kind === "file") return t("candidate.variants.file");
  return candidate.label || t("candidate.variants.source");
}

function youtubeVideoIdFromUrl(parsed) {
  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  if (host === "youtube.com" || host === "m.youtube.com") {
    if (parsed.pathname === "/watch") return cleanYouTubeId(parsed.searchParams.get("v"));
    const embedMatch = parsed.pathname.match(/^\/embed\/([^/?#]+)/i);
    if (embedMatch) return cleanYouTubeId(embedMatch[1]);
    const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/?#]+)/i);
    if (shortsMatch) return cleanYouTubeId(shortsMatch[1]);
  }
  if (host === "youtu.be") {
    return cleanYouTubeId(parsed.pathname.split("/").filter(Boolean)[0]);
  }
  return "";
}

function cleanYouTubeId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{6,20}$/.test(id) ? id : "";
}

function vkVideoIdFromUrl(parsed) {
  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "vkvideo.ru" && host !== "m.vkvideo.ru") return "";
  const match = parsed.pathname.match(/^\/video(-?\d+_\d+)/i);
  return match ? match[1] : "";
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
    elements.activityTitle.textContent = t("activity.recordingTitle", { elapsed: formatElapsed(state.recordingStartedAt) });
    const recordedSize = formatBytes(state.recordingBytes || 0);
    elements.activityDetail.textContent = recordedSize
      ? t("activity.recordingDetailWithSize", { size: recordedSize })
      : t("activity.recordingDetail");
    return;
  }
  if (state.busy) {
    elements.activity.classList.add("downloading");
    elements.activityTitle.textContent = t("activity.downloadingTitle");
    elements.activityDetail.textContent = t("activity.downloadingDetail");
    return;
  }
  if (state.armed) {
    elements.activity.classList.add("armed");
    elements.activityTitle.textContent = t("activity.armedTitle");
    elements.activityDetail.textContent = t("activity.armedDetail");
    return;
  }
  elements.activity.classList.add("idle");
  elements.activityTitle.textContent = t("activity.idleTitle");
  elements.activityDetail.textContent = t("activity.idleDetail");
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
  if (!source) return t("sources.unknown");
  if (source === "video") return t("sources.videoTag");
  if (source === "iframe") return t("sources.iframe");
  if (source === "response") return t("sources.response");
  if (source === "page") return t("sources.page");
  if (source.startsWith("network:")) return t("sources.network", { type: source.slice("network:".length) });
  return source;
}

function localizeStatus(status) {
  const value = String(status || "").trim();
  if (!value) return "";
  const exact = {
    "Ожидание.": "status.idle",
    "Загрузка...": "status.loading",
    "Сначала нажми Проверить и подтверди, что это нужное видео.": "status.verifyFirst",
    "Пока не нашел URL для скачивания.": "status.noCandidate",
    "Останавливаю скачивание yt-dlp...": "status.stoppingDownload",
    "Скачивание остановлено.": "status.downloadStopped",
    "Ищу область плеера для записи...": "status.findingRecordingArea",
    "Выбор области записи отменен.": "status.recordingAreaCancelled",
    "Плеер выбран. Нажми Play на видео, запись начнется через 5 секунд.": "status.playerSelectedCountdown"
  };
  if (exact[value]) return t(exact[value]);
  let match = value.match(/^Найдено вариантов для проверки: (\d+)\./);
  if (match) return t("status.candidatesFound", { count: match[1] });
  match = value.match(/^Скан готов: video (\d+), iframe (\d+), res (\d+)\./);
  if (match) return t("status.scanDone", { videos: match[1], embeds: match[2], resources: match[3] });
  if (/^Проверяю источник через yt-dlp:/i.test(value)) return t("status.verifying");
  if (/^Источник подтвержден:/i.test(value)) return value.replace("Источник подтвержден:", t("status.sourceConfirmedPrefix"));
  if (/^Источник читается, но НЕ подтвержден:/i.test(value)) return value.replace("Источник читается, но НЕ подтвержден:", t("status.sourceReadableNotConfirmedPrefix"));
  if (/^Проверка не прошла:/i.test(value)) return value.replace("Проверка не прошла:", t("status.verificationFailedPrefix"));
  return value;
}
