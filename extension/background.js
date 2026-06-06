const NATIVE_HOST = "com.video_course_capture.native_host";
const MEDIA_EXTENSIONS = /\.(mp4|m4v|mov|webm|mkv|m3u8|mpd|ts|m4s)(\?|#|$)/i;
const DIRECT_FILE_EXTENSIONS = /\.(mp4|m4v|mov|webm|mkv)(\?|#|$)/i;
const STREAM_EXTENSIONS = /\.(m3u8|mpd)(\?|#|$)/i;
const HLS_EXTENSION = /\.m3u8(\?|#|$)/i;
const DASH_EXTENSION = /\.mpd(\?|#|$)/i;
const SEGMENT_EXTENSION = /\.(ts|m4s)(\?|#|$)/i;
const EMBED_PLAYER_PATTERNS = [
  /vk\.com\/video_ext\.php/i,
  /youtube\.com\/embed\//i,
  /player\.vimeo\.com\/video\//i,
  /rutube\.ru\/play\/embed\//i,
  /kinescope\.io\/embed\//i,
  /\/embed\//i
];
const DEFAULT_SETTINGS = {
  ytDlpPath: "C:\\yt-dlp\\yt-dlp.exe",
  ffmpegDir: "C:\\yt-dlp\\ffmpeg\\ffmpeg-7.1-essentials_build\\bin",
  downloadDir: "D:\\MyGitProjects\\chrome-course-capture\\downloads",
  maxDownloadGb: 10,
  mergeFormat: "mp4",
  fragmentRetries: 10,
  socketTimeout: 20
};

const state = {
  tabs: new Map(),
  nativePort: null,
  nativeReady: false,
  lastNativeError: null
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(DEFAULT_SETTINGS).then(values => {
    chrome.storage.local.set(values);
  });
});

chrome.webRequest.onBeforeRequest.addListener(
  details => {
    if (details.tabId < 0 || !details.url || !isMediaCandidate(details.url)) {
      return;
    }
    rememberNetworkCandidate(details.tabId, details.url, details.type);
  },
  { urls: ["<all_urls>"] }
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(error => {
    sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
  });
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  state.tabs.delete(tabId);
});

chrome.commands.onCommand.addListener(command => {
  if (command === "stop-recording") {
    stopCurrentRecording().catch(error => {
      console.warn("Video Course Capture could not stop recording from shortcut", error);
    });
  }
});

async function handleMessage(message, sender) {
  if (!message || !message.type) {
    return { ok: false, error: "Unknown message" };
  }

  if (message.type === "VIDEO_PLAY") {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== "number") return { ok: false, error: "No tab id" };
    const tabState = getTabState(tabId);
    tabState.lastTitle = message.title || tabState.lastTitle;
    tabState.playbackObserved = true;
    let changedAny = false;
    const pageVideoUrl = canonicalPageVideoUrl(sender.tab && sender.tab.url);
    if (pageVideoUrl) {
      changedAny = rememberCandidate(tabId, {
        url: pageVideoUrl,
        source: "tab:url",
        score: scoreUrl(pageVideoUrl) + 100,
        at: Date.now()
      }) || changedAny;
      if (changedAny && tabState.armed && tabState.playbackObserved && !tabState.busy) {
        scheduleAutoCapture(tabId);
      }
      return { ok: true };
    }
    if (isSingleVideoPageUrl(sender.tab && sender.tab.url)) return { ok: true };
    if (message.url) {
      changedAny = rememberCandidate(tabId, {
        url: message.url,
        source: "video",
        score: scoreUrl(message.url) + 10,
        at: Date.now()
      }) || changedAny;
    }
    if (Array.isArray(message.candidates)) {
      for (const url of message.candidates) {
        changedAny = rememberCandidate(tabId, { url, source: "page", score: scoreUrl(url), at: Date.now() }) || changedAny;
      }
    }
    if (changedAny && tabState.armed && tabState.playbackObserved && !tabState.busy) {
      scheduleAutoCapture(tabId);
    }
    return { ok: true };
  }

  if (message.type === "EMBED_FOUND") {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== "number") return { ok: false, error: "No tab id" };
    const tabState = getTabState(tabId);
    tabState.lastTitle = message.title || tabState.lastTitle;
    let changedAny = false;
    if (Array.isArray(message.candidates)) {
      for (const url of message.candidates) {
        changedAny = rememberCandidate(tabId, {
          url,
          source: "iframe",
          score: scoreUrl(url),
          at: Date.now()
        }) || changedAny;
      }
    }
    if (changedAny && tabState.armed && tabState.playbackObserved && !tabState.busy) {
      scheduleAutoCapture(tabId);
    }
    return { ok: true };
  }

  if (message.type === "HLS_FOUND") {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== "number") return { ok: false, error: "No tab id" };
    const tabState = getTabState(tabId);
    tabState.lastTitle = message.title || tabState.lastTitle;
    tabState.playlistObserved = true;
    let changedAny = false;
    const pageVideoUrl = canonicalPageVideoUrl(sender.tab && sender.tab.url);
    if (pageVideoUrl) {
      changedAny = rememberCandidate(tabId, {
        url: pageVideoUrl,
        source: "tab:url",
        score: scoreUrl(pageVideoUrl) + 100,
        at: Date.now()
      }) || changedAny;
      if (changedAny && tabState.armed && !tabState.busy) {
        scheduleAutoCapture(tabId, 300);
      }
      return { ok: true };
    }
    if (isSingleVideoPageUrl(sender.tab && sender.tab.url)) return { ok: true };
    if (message.url) {
      changedAny = rememberCandidate(tabId, {
        url: message.url,
        source: "response",
        score: scoreUrl(message.url) + 30,
        at: Date.now()
      }) || changedAny;
    }
    if (Array.isArray(message.candidates)) {
      for (const url of message.candidates) {
        changedAny = rememberCandidate(tabId, {
          url,
          source: "response",
          score: scoreUrl(url) + 30,
          at: Date.now()
        }) || changedAny;
      }
    }
    if (changedAny && tabState.armed && !tabState.busy) {
      scheduleAutoCapture(tabId, 300);
    }
    return { ok: true };
  }

  if (message.type === "GET_STATE") {
    const tab = await getActiveTab();
    rememberCurrentPageCandidate(tab.id, tab.url);
    return { ok: true, tabId: tab.id, state: publicTabState(tab.id), settings: await getSettings() };
  }

  if (message.type === "GET_SETTINGS") {
    return { ok: true, settings: await getSettings() };
  }

  if (message.type === "SAVE_SETTINGS") {
    const settings = normalizeSettings(message.settings);
    await chrome.storage.local.set(settings);
    return { ok: true, settings };
  }

  if (message.type === "ARM") {
    const tab = await getActiveTab();
    const tabState = getTabState(tab.id);
    tabState.armed = true;
    tabState.playbackObserved = false;
    tabState.playlistObserved = false;
    tabState.status = "Готово. Теперь нажми Play на странице курса.";
    tabState.error = "";
    notifyPopup(tab.id);
    return { ok: true, state: publicTabState(tab.id) };
  }

  if (message.type === "SCAN_PAGE") {
    const tab = await getActiveTab();
    return scanPage(tab.id);
  }

  if (message.type === "DISARM") {
    const tab = await getActiveTab();
    const tabState = getTabState(tab.id);
    tabState.armed = false;
    tabState.status = "Ожидание.";
    notifyPopup(tab.id);
    return { ok: true, state: publicTabState(tab.id) };
  }

  if (message.type === "DOWNLOAD_BEST") {
    const tab = await getActiveTab();
    return downloadBestCandidate(tab.id, "manual");
  }

  if (message.type === "DOWNLOAD_CANDIDATE") {
    const tab = await getActiveTab();
    return downloadCandidateByUrl(tab.id, message.url, "manual");
  }

  if (message.type === "VERIFY_CANDIDATE") {
    const tab = await getActiveTab();
    return verifyCandidateByUrl(tab.id, message.url);
  }

  if (message.type === "CANCEL_DOWNLOAD") {
    const result = await cancelDownload(message.tabId);
    return { ok: true, state: publicTabState(result.tabId) };
  }

  if (message.type === "START_RECORD") {
    const tab = await getActiveTab();
    await startRecording(tab.id);
    return { ok: true, state: publicTabState(tab.id) };
  }

  if (message.type === "STOP_RECORD") {
    const result = await stopRecording(message.tabId);
    return { ok: true, state: publicTabState(result.tabId) };
  }

  if (message.type === "SAVE_RECORDING") {
    const tabState = getTabState(message.tabId);
    try {
      await chrome.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: true
      });
      tabState.recording = false;
      tabState.busy = false;
      tabState.recordingStartedAt = 0;
      tabState.recordingBytes = 0;
      tabState.status = `Запись сохранена: ${message.filename}`;
      notifyPopup(message.tabId);
      return { ok: true };
    } catch (error) {
      tabState.recording = false;
      tabState.busy = false;
      tabState.recordingStartedAt = 0;
      tabState.recordingBytes = 0;
      tabState.error = String(error && error.message ? error.message : error);
      tabState.status = `Не смог сохранить запись: ${tabState.error}`;
      notifyPopup(message.tabId);
      return { ok: false, error: tabState.error };
    }
  }

  if (message.type === "RECORDING_START") {
    const response = await sendNative({
      command: "recording_start",
      tabId: message.tabId,
      recordingId: message.recordingId,
      filename: message.filename,
      settings: await getSettings()
    });
    return { ok: true, response };
  }

  if (message.type === "RECORDING_CHUNK") {
    const response = await sendNative({
      command: "recording_chunk",
      tabId: message.tabId,
      recordingId: message.recordingId,
      index: message.index,
      size: message.size,
      data: message.data
    });
    return { ok: true, response };
  }

  if (message.type === "RECORDING_STOP") {
    const response = await sendNative({
      command: "recording_stop",
      tabId: message.tabId,
      recordingId: message.recordingId
    });
    const tabState = getTabState(message.tabId);
    tabState.recording = false;
    tabState.busy = false;
    tabState.recordingStartedAt = 0;
    tabState.recordingBytes = 0;
    tabState.status = response.message || "Запись сохранена в папку downloads.";
    notifyPopup(message.tabId);
    return { ok: true, response };
  }

  if (message.type === "OFFSCREEN_STATUS") {
    const tabState = getTabState(message.tabId);
    tabState.status = message.status || tabState.status;
    const wasRecording = tabState.recording;
    tabState.recording = !!message.recording;
    tabState.busy = !!message.recording;
    if (tabState.recording && !wasRecording) {
      tabState.recordingStartedAt = Date.now();
    }
    if (!tabState.recording) {
      tabState.recordingStartedAt = 0;
      tabState.recordingBytes = 0;
      unlockRecordingView(message.tabId);
    }
    if (message.error) tabState.error = message.error;
    notifyPopup(message.tabId);
    return { ok: true };
  }

  return { ok: false, error: `Unknown message type: ${message.type}` };
}

function isMediaCandidate(url) {
  return MEDIA_EXTENSIONS.test(url) || /m3u8|mpd|hls|dash|videoplayback|playlist|manifest|master/i.test(url) || isEmbedPlayerUrl(url);
}

function scoreUrl(url) {
  if (canonicalVkVideoUrl(url)) return 168;
  if (canonicalYouTubeWatchUrl(url)) return 170;
  if (/\/api\/playlist\/master\/|get-master-playlist/i.test(url)) return 180;
  if (/\/api\/playlist\/media\/|get-media-playlist/i.test(url)) return 145;
  if (HLS_EXTENSION.test(url)) return 160;
  if (DASH_EXTENSION.test(url)) return 150;
  if (/m3u8|hls|master|playlist/i.test(url)) return 140;
  if (/mpd|dash|manifest/i.test(url)) return 130;
  if (DIRECT_FILE_EXTENSIONS.test(url)) return 120;
  if (/videoplayback/i.test(url)) return 115;
  if (/vk\.com\/video_ext\.php/i.test(url)) return 85;
  if (/kinescope\.io\/embed\//i.test(url)) return 84;
  if (isEmbedPlayerUrl(url)) return 80;
  if (/\.(ts|m4s)(\?|#|$)/i.test(url)) return 25;
  return 35;
}

function isEmbedPlayerUrl(url) {
  return EMBED_PLAYER_PATTERNS.some(pattern => pattern.test(url));
}

function getTabState(tabId) {
  if (!state.tabs.has(tabId)) {
    state.tabs.set(tabId, {
      armed: false,
      busy: false,
      recording: false,
      status: "Ожидание.",
      error: "",
      candidates: [],
      lastTitle: "",
      autoTimer: null,
      recordingStartedAt: 0,
      recordingBytes: 0,
      playbackObserved: false,
      playlistObserved: false,
      lastProgressUiAt: 0,
      downloading: false,
      cancellingDownload: false,
      downloadOutcome: "",
      downloadProgress: null,
      verifyingSource: false,
      verifiedStatus: ""
    });
  }
  return state.tabs.get(tabId);
}

function rememberCandidate(tabId, candidate) {
  if (!candidate.url || !/^https?:\/\//i.test(candidate.url)) return false;
  const tabState = getTabState(tabId);
  const enriched = enrichCandidate(candidate);
  const existing = tabState.candidates.find(item => item.url === candidate.url);
  if (existing) {
    const oldScore = existing.score;
    const oldSource = existing.source;
    const oldKind = existing.kind;
    existing.at = Date.now();
    existing.score = Math.max(existing.score, enriched.score || 0);
    existing.source = enriched.source || existing.source;
    existing.kind = enriched.kind;
    existing.label = enriched.label;
    existing.host = enriched.host;
    existing.path = enriched.path;
    if (oldScore === existing.score && oldSource === existing.source && oldKind === existing.kind) {
      return false;
    }
  } else {
    tabState.candidates.unshift(enriched);
  }
  tabState.candidates = limitCandidatesPreservingConfirmed(tabState.candidates);
  if (!tabState.recording && !tabState.busy && !tabState.verifyingSource && !tabState.verifiedStatus) {
    tabState.status = `Найдено вариантов для проверки: ${publicCandidates(tabState.candidates).length}. Выбери вариант и нажми Проверить.`;
  }
  notifyPopup(tabId);
  return true;
}

async function rememberNetworkCandidate(tabId, url, type) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const pageVideoUrl = canonicalPageVideoUrl(tab && tab.url);
    if (pageVideoUrl) {
      rememberCandidate(tabId, {
        url: pageVideoUrl,
        source: "tab:url",
        score: scoreUrl(pageVideoUrl) + 100,
        at: Date.now()
      });
      return;
    }
    if (isSingleVideoPageUrl(tab && tab.url)) return;
  } catch (_) {
    // Fall through to the observed network URL if tab metadata is unavailable.
  }
  rememberCandidate(tabId, {
    url,
    source: `network:${type}`,
    score: scoreUrl(url),
    at: Date.now()
  });
}

function rememberCurrentPageCandidate(tabId, url) {
  const pageVideoUrl = canonicalPageVideoUrl(url);
  if (!pageVideoUrl) return false;
  return rememberCandidate(tabId, {
    url: pageVideoUrl,
    source: "tab:url",
    score: scoreUrl(pageVideoUrl) + 100,
    at: Date.now()
  });
}

function publicTabState(tabId) {
  const tabState = getTabState(tabId);
  return {
    armed: tabState.armed,
    busy: tabState.busy,
    downloading: tabState.downloading,
    cancellingDownload: tabState.cancellingDownload,
    recording: tabState.recording,
    status: tabState.status,
    error: tabState.error,
    candidates: publicCandidates(tabState.candidates),
    lastTitle: tabState.lastTitle,
    nativeReady: state.nativeReady,
    lastNativeError: state.lastNativeError,
    recordingStartedAt: tabState.recordingStartedAt || 0,
    recordingBytes: tabState.recordingBytes || 0,
    downloadProgress: tabState.downloadProgress || null,
    verifyingSource: !!tabState.verifyingSource
  };
}

function scheduleAutoCapture(tabId, delay = null) {
  const tabState = getTabState(tabId);
  if (tabState.autoTimer) clearTimeout(tabState.autoTimer);
  const best = tabState.candidates[0];
  const waitMs = typeof delay === "number" ? delay : delayForCandidate(best);
  if (!tabState.verifiedStatus) {
    tabState.status = best && best.kind === "embed"
      ? "Нашел iframe-плеер. Жду HLS/API playlist перед проверкой..."
      : "Видео стартовало. Ищу файл, playlist или страницу плеера...";
    notifyPopup(tabId);
  }
  tabState.autoTimer = setTimeout(async () => {
    const current = getTabState(tabId);
    if (!current.armed || current.busy || current.verifiedStatus) return;
    current.status = "Вариант найден. Выбери его, нажми Проверить, затем Скачать станет доступно только после подтверждения.";
    notifyPopup(tabId);
  }, waitMs);
}

function limitCandidatesPreservingConfirmed(candidates) {
  const sorted = [...candidates].sort((a, b) => (b.score - a.score) || (b.at - a.at));
  const limited = sorted.slice(0, 80);
  for (const candidate of sorted) {
    if (!(candidate.check && candidate.check.confirmed)) continue;
    if (limited.some(item => item.url === candidate.url)) continue;
    const replaceIndex = [...limited].reverse().findIndex(item => !(item.check && item.check.confirmed));
    if (replaceIndex < 0) continue;
    limited[limited.length - 1 - replaceIndex] = candidate;
  }
  return limited.sort((a, b) => (b.score - a.score) || (b.at - a.at));
}

function publicCandidates(candidates) {
  const sorted = [...candidates].sort((a, b) => (b.score - a.score) || (b.at - a.at));
  const groups = [];
  const byKey = new Map();
  for (const candidate of sorted) {
    const key = candidateGroupKey(candidate);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      groups.push(key);
    }
    byKey.get(key).push(candidate);
  }

  const result = [];
  const hasStrongGroup = groups.some(key => groupHasStrongPublicCandidate(byKey.get(key)));
  for (const key of groups) {
    const group = byKey.get(key);
    if (hasStrongGroup && isWeakTechnicalGroup(group)) continue;
    const selected = selectPublicCandidatesForGroup(group);
    for (const candidate of selected) {
      if (!result.some(item => item.url === candidate.url)) result.push(candidate);
    }
  }
  return result.slice(0, 30);
}

function groupHasStrongPublicCandidate(group) {
  return group.some(candidate => {
    if (candidate.check && candidate.check.confirmed) return true;
    if (isMasterCandidate(candidate)) return true;
    if (candidateQualityHeight(candidate) >= 720) return true;
    return ["youtube", "vkvideo", "embed", "hls", "dash", "file"].includes(candidate.kind);
  });
}

function isWeakTechnicalGroup(group) {
  return !group.some(candidate => {
    if (candidate.check && candidate.check.confirmed) return true;
    if (isMasterCandidate(candidate)) return true;
    if (candidateQualityHeight(candidate) >= 720) return true;
    return ["youtube", "vkvideo", "embed", "hls", "dash", "file"].includes(candidate.kind);
  });
}

function selectPublicCandidatesForGroup(group) {
  const confirmed = group.filter(candidate => candidate.check && candidate.check.confirmed);
  const playable = group.filter(candidate => candidate.kind !== "segment");
  const master = playable.filter(isMasterCandidate);
  const high = playable.filter(candidate => !isMasterCandidate(candidate) && candidateQualityHeight(candidate) >= 720);
  const preferred = [...confirmed, ...master, ...high];
  if (preferred.length) return sortPublicCandidates(uniqueCandidates(preferred));

  const fallback = playable.length ? [bestFallbackCandidate(playable)] : [bestFallbackCandidate(group)];
  return fallback.filter(Boolean);
}

function sortPublicCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const aRank = publicCandidateRank(a);
    const bRank = publicCandidateRank(b);
    return (aRank - bRank) || (candidateQualityHeight(b) - candidateQualityHeight(a)) || (b.score - a.score) || (b.at - a.at);
  });
}

function publicCandidateRank(candidate) {
  if (candidate.check && candidate.check.confirmed) return 0;
  if (isMasterCandidate(candidate)) return 1;
  const height = candidateQualityHeight(candidate);
  if (candidate.kind === "vkvideo") return 2;
  if (candidate.kind === "youtube") return 2;
  if (height >= 1080) return 2;
  if (height >= 720) return 3;
  if (candidate.kind === "embed") return 4;
  if (candidate.kind === "file") return 5;
  return 6;
}

function bestFallbackCandidate(candidates) {
  return [...candidates].sort((a, b) => {
    return (candidateQualityHeight(b) - candidateQualityHeight(a)) || (b.score - a.score) || (b.at - a.at);
  })[0] || null;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    if (!candidate || seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

function isMasterCandidate(candidate) {
  const text = `${candidate.url || ""} ${candidate.path || ""}`;
  return /master|get-master-playlist|\/master(\/|$|\?)/i.test(text);
}

function candidateQualityHeight(candidate) {
  const text = `${candidate.url || ""} ${candidate.path || ""}`;
  const quality = text.match(/(?:\/|_|-)(240|360|480|540|720|1080|1440|2160)(?:p)?(?:\/|\.|_|-|\?|$)/i);
  return quality ? Number(quality[1]) : 0;
}

function delayForCandidate(candidate) {
  if (!candidate) return 2500;
  if (["hls", "dash", "file", "playback"].includes(candidate.kind)) return 300;
  if (candidate.kind === "embed") return 5000;
  return 3000;
}

async function downloadBestCandidate(tabId, reason) {
  const tabState = getTabState(tabId);
  const candidate = tabState.candidates[0];
  if (!candidate) {
    tabState.status = "Пока не нашел URL для скачивания.";
    notifyPopup(tabId);
    return { ok: false, error: "No candidate" };
  }
  if (reason === "manual" && !(candidate.check && candidate.check.confirmed)) {
    tabState.status = "Сначала нажми Проверить и подтверди, что это нужное видео.";
    notifyPopup(tabId);
    return { ok: false, error: "Source is not confirmed", state: publicTabState(tabId) };
  }

  return downloadCandidate(tabId, candidate, reason);
}

async function scanPage(tabId) {
  const tabState = getTabState(tabId);
  tabState.status = "Сканирую страницу без перезагрузки...";
  tabState.error = "";
  notifyPopup(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (isSingleVideoPageUrl(tab && tab.url)) {
    const added = rememberCurrentPageCandidate(tabId, tab.url);
    return finishScan(tabId, { videos: added ? 1 : 0, embeds: 0, resources: 0 }, false);
  }
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "SCAN_PAGE" });
    return finishScan(tabId, response, false);
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(error && error.message ? error.message : error))) {
      tabState.error = String(error && error.message ? error.message : error);
      tabState.status = "Не смог просканировать страницу.";
      notifyPopup(tabId);
      return { ok: false, error: tabState.error, state: publicTabState(tabId) };
    }
    try {
      const response = await scanPageWithScripting(tabId);
      return finishScan(tabId, response, true);
    } catch (fallbackError) {
      tabState.error = String(fallbackError && fallbackError.message ? fallbackError.message : fallbackError);
      tabState.status = "Не смог просканировать страницу. Нужен Reload расширения или вкладки.";
      notifyPopup(tabId);
      return { ok: false, error: tabState.error, state: publicTabState(tabId) };
    }
  }
}

function finishScan(tabId, response, usedFallback) {
  const tabState = getTabState(tabId);
  const total = (response && ((response.videos || 0) + (response.embeds || 0) + (response.resources || 0))) || 0;
  if (!tabState.verifiedStatus) {
    tabState.status = total
      ? `Скан готов: video ${response.videos || 0}, iframe ${response.embeds || 0}, res ${response.resources || 0}.`
      : "Скан готов: новых источников нет.";
  }
  notifyPopup(tabId);
  return { ok: true, state: publicTabState(tabId), response };
}

async function scanPageWithScripting(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: scanFrameForCourseCapture
  });
  const summary = { videos: 0, embeds: 0, resources: 0 };
  for (const result of results || []) {
    const frame = result.result || {};
    summary.videos += frame.videos || 0;
    summary.embeds += frame.embeds || 0;
    summary.resources += frame.resources || 0;
    for (const candidate of frame.candidates || []) {
      rememberCandidate(tabId, {
        url: candidate.url,
        source: candidate.source || "scan",
        score: scoreUrl(candidate.url),
        at: Date.now()
      });
    }
  }
  return summary;
}

function scanFrameForCourseCapture() {
  const mediaExtensions = /\.(mp4|m4v|mov|webm|mkv|m3u8|mpd|ts|m4s)(\?|#|$)/i;
  const embedPatterns = [
    /vk\.com\/video_ext\.php/i,
    /youtube\.com\/embed\//i,
    /player\.vimeo\.com\/video\//i,
    /rutube\.ru\/play\/embed\//i,
    /kinescope\.io\/embed\//i,
    /player\./i,
    /\/embed\//i
  ];
  const candidates = [];
  const add = (url, source) => {
    if (url && /^https?:\/\//i.test(url)) candidates.push({ url, source });
  };

  const queryAllDeep = (selectors, root = document) => {
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];
    const result = [];
    const seen = new Set();
    const walked = new Set();
    const add = element => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      result.push(element);
    };
    const walk = node => {
      if (!node || walked.has(node)) return;
      walked.add(node);
      if (!node.querySelectorAll) return;
      for (const selector of selectorList) {
        try {
          node.querySelectorAll(selector).forEach(add);
        } catch (_) {
          // Keep fallback scan resilient.
        }
      }
      node.querySelectorAll("*").forEach(element => {
        if (element.shadowRoot) walk(element.shadowRoot);
      });
    };
    walk(root);
    return result;
  };

  const media = queryAllDeep(["video", "audio"]);
  for (const video of media) {
    add(video.currentSrc, "scan:video");
    add(video.src, "scan:video");
    for (const source of queryAllDeep(["source[src]"], video)) add(source.src, "scan:video");
  }

  let embeds = 0;
  for (const iframe of queryAllDeep(["iframe[src]"])) {
    if (!embedPatterns.some(pattern => pattern.test(iframe.src))) continue;
    embeds += 1;
    add(iframe.src, "scan:iframe");
  }

  let resources = 0;
  for (const entry of performance.getEntriesByType("resource")) {
    if (mediaExtensions.test(entry.name) || /videoplayback|playlist|manifest|master|m3u8|mpd/i.test(entry.name)) {
      resources += 1;
      add(entry.name, "scan:resource");
    }
  }

  return {
    videos: media.length,
    embeds,
    resources,
    candidates
  };
}

function scanPlayerRectForCourseCapture() {
  const embedPatterns = [
    /vk\.com\/video_ext\.php/i,
    /youtube\.com\/embed\//i,
    /player\.vimeo\.com\/video\//i,
    /rutube\.ru\/play\/embed\//i,
    /kinescope\.io\/embed\//i,
    /player\./i,
    /\/embed\//i
  ];
  const selectors = [
    "video.player-media",
    "video",
    "[data-testid='video-container']",
    ".video-container",
    ".video-wrapper",
    "vk-video-player",
    "iframe[src]",
    "[id*='player' i]",
    "[class*='player' i]",
    "[id*='video' i]",
    "[class*='video' i]",
    "[id*='broadcast' i]",
    "[class*='broadcast' i]",
    "[class*='embed' i]"
  ];
  const queryAllDeep = (selectors, root = document) => {
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];
    const result = [];
    const seen = new Set();
    const walked = new Set();
    const add = element => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      result.push(element);
    };
    const walk = node => {
      if (!node || walked.has(node)) return;
      walked.add(node);
      if (!node.querySelectorAll) return;
      for (const selector of selectorList) {
        try {
          node.querySelectorAll(selector).forEach(add);
        } catch (_) {
          // Keep fallback scan resilient.
        }
      }
      node.querySelectorAll("*").forEach(element => {
        if (element.shadowRoot) walk(element.shadowRoot);
      });
    };
    walk(root);
    return result;
  };
  const matchesElement = (element, selector) => {
    try {
      return element.matches(selector);
    } catch (_) {
      return false;
    }
  };
  const elements = queryAllDeep(selectors);
  const candidates = [];
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    if (width < 160 || height < 90) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    const rawTag = element.tagName.toLowerCase();
    const tag = rawTag === "video"
      ? "video"
      : matchesElement(element, "[data-testid='video-container'], .video-container")
        ? "video-container"
        : matchesElement(element, ".video-wrapper")
          ? "video-wrapper"
          : rawTag === "vk-video-player"
            ? "vk-video-player"
            : rawTag;
    const src = rawTag === "iframe" ? element.src || "" : "";
    const idClass = `${element.id || ""} ${element.className || ""}`;
    let score = width * height;
    if (tag === "video") score += 2200000;
    if (tag === "video-container") score += 2000000;
    if (tag === "video-wrapper") score += 1800000;
    if (tag === "vk-video-player") score += 1200000;
    if (tag === "iframe") score += 500000;
    if (src && embedPatterns.some(pattern => pattern.test(src))) score += 900000;
    if (/player|video|broadcast|embed/i.test(idClass)) score += 250000;
    if (width >= window.innerWidth * 0.45 && height >= window.innerHeight * 0.30) score += 300000;
    let host = "";
    try {
      host = src ? new URL(src).host : "";
    } catch (_) {
      host = "";
    }
    const id = element.id ? `#${element.id}` : "";
    const className = typeof element.className === "string"
      ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(name => `.${name}`).join("")
      : "";
    candidates.push({
      score,
      kind: tag,
      rect: { x: left, y: top, width, height },
      selector: `${rawTag}${id}${className}`,
      label: tag === "iframe"
        ? `iframe ${host}`
        : tag === "video-container"
          ? "VK video-container"
          : tag === "video-wrapper"
            ? "VK video-wrapper"
            : tag === "vk-video-player"
              ? "VK player"
              : tag,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      }
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  const innerMedia = candidates.filter(candidate => ["video", "video-container", "video-wrapper"].includes(candidate.kind));
  if (innerMedia.length) return innerMedia[0];
  return candidates[0] || null;
}

async function downloadCandidateByUrl(tabId, url, reason) {
  const tabState = getTabState(tabId);
  const candidate = tabState.candidates.find(item => item.url === url);
  if (!candidate) {
    tabState.status = "Этот URL уже не найден в текущем списке источников.";
    notifyPopup(tabId);
    return { ok: false, error: "Candidate not found" };
  }
  if (reason === "manual" && !(candidate.check && candidate.check.confirmed)) {
    tabState.status = "Сначала нажми Проверить и подтверди, что это нужное видео.";
    notifyPopup(tabId);
    return { ok: false, error: "Source is not confirmed", state: publicTabState(tabId) };
  }

  return downloadCandidate(tabId, candidate, reason);
}

async function verifyCandidateByUrl(tabId, url) {
  const tabState = getTabState(tabId);
  const candidate = tabState.candidates.find(item => item.url === url);
  if (!candidate) {
    tabState.status = "Этот URL уже не найден в текущем списке источников.";
    notifyPopup(tabId);
    return { ok: false, error: "Candidate not found", state: publicTabState(tabId) };
  }

  const tab = await chrome.tabs.get(tabId);
  tabState.verifyingSource = true;
  tabState.error = "";
  tabState.status = `Проверяю источник через yt-dlp: ${candidate.host || "найденный URL"}...`;
  notifyPopup(tabId);

  try {
    const settings = await getSettings();
    const response = await sendNative({
      command: "verify",
      tabId,
      url: candidate.url,
      pageUrl: tab.url,
      cookies: await collectCookies([candidate.url, tab.url]),
      settings
    }, 60000);
    candidate.check = normalizeVerifyInfo(response.info);
    tabState.verifyingSource = false;
    tabState.verifiedStatus = candidate.check.confirmed
      ? `Источник подтвержден: ${candidate.check.title}${candidate.check.duration ? `, ${candidate.check.duration}` : ""}. Теперь можно нажать Скачать.`
      : candidate.check.ok
        ? `Источник читается, но НЕ подтвержден: ${candidate.check.warning || "нет нормального названия или длительности"}. Не скачивай без проверки.`
      : `Проверка не прошла: ${candidate.check.error || "не удалось получить метаданные"}`;
    tabState.status = tabState.verifiedStatus;
    notifyPopup(tabId);
    return { ok: candidate.check.confirmed, info: candidate.check, state: publicTabState(tabId) };
  } catch (error) {
    candidate.check = { ok: false, error: String(error && error.message ? error.message : error) };
    tabState.verifyingSource = false;
    tabState.verifiedStatus = `Проверка не прошла: ${candidate.check.error}`;
    tabState.status = tabState.verifiedStatus;
    notifyPopup(tabId);
    return { ok: false, error: candidate.check.error, state: publicTabState(tabId) };
  }
}

async function downloadCandidate(tabId, candidate, reason) {
  const tabState = getTabState(tabId);
  const tab = await chrome.tabs.get(tabId);
  tabState.busy = true;
  tabState.downloading = true;
  tabState.downloadOutcome = "";
  tabState.downloadProgress = null;
  tabState.verifiedStatus = "";
  tabState.status = `Скачиваю через yt-dlp: ${candidate.label} с ${candidate.host || "найденного URL"}...`;
  tabState.error = "";
  notifyPopup(tabId);

  try {
    const settings = await getSettings();
    const response = await sendNative({
      command: "download",
      reason,
      tabId,
      url: candidate.url,
      pageUrl: tab.url,
      title: candidate.check && candidate.check.title ? candidate.check.title : (tabState.lastTitle || tab.title || "course-video"),
      filenameHint: buildFilenameHint(candidate, tabState.candidates),
      cookies: await collectCookies([candidate.url, tab.url]),
      settings
    });
    tabState.status = response.message || "Скачивание началось.";
    notifyPopup(tabId);
    return { ok: true, response, state: publicTabState(tabId) };
  } catch (error) {
    tabState.busy = false;
    tabState.downloading = false;
    tabState.downloadOutcome = "error";
    tabState.error = String(error && error.message ? error.message : error);
    tabState.status = "yt-dlp не смог скачать. Можно включить запись вкладки.";
    notifyPopup(tabId);
    return { ok: false, error: tabState.error, state: publicTabState(tabId) };
  }
}

async function collectCookies(urls) {
  const seen = new Set();
  const result = [];
  for (const url of urls.filter(Boolean)) {
    if (!/^https?:\/\//i.test(url)) continue;
    try {
      const cookies = await chrome.cookies.getAll({ url });
      for (const cookie of cookies) {
        const key = `${cookie.domain}\t${cookie.path}\t${cookie.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
          domain: cookie.domain,
          hostOnly: cookie.hostOnly,
          path: cookie.path,
          secure: cookie.secure,
          expirationDate: cookie.expirationDate || 0,
          name: cookie.name,
          value: cookie.value
        });
      }
    } catch (error) {
      console.warn("Video Course Capture could not read cookies for URL", url, error);
    }
  }
  return result;
}

async function startRecording(tabId) {
  const tabState = getTabState(tabId);
  tabState.status = "Ищу область плеера для записи...";
  notifyPopup(tabId);
  let crop = await getRecordingCrop(tabId);
  if (crop && crop.cancelled) {
    tabState.status = "Выбор области записи отменен.";
    tabState.busy = false;
    tabState.recording = false;
    notifyPopup(tabId);
    return;
  }
  if (crop && crop.rect) {
    await lockRecordingView(tabId);
    tabState.status = "Плеер выбран. Нажми Play на видео, запись начнется через 5 секунд.";
    notifyPopup(tabId);
    await showRecordingCountdown(tabId, 5);
    await waitBeforeRecording(5000);
    await waitForPagePaint();
  }
  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const tab = await chrome.tabs.get(tabId);
  tabState.recording = true;
  tabState.busy = true;
  tabState.recordingStartedAt = Date.now();
  tabState.recordingBytes = 0;
  tabState.status = crop
    ? `Идет запись области плеера: ${crop.label || crop.selector || "player"}.`
    : "Идет запись текущей вкладки вместе с аудио...";
  tabState.error = "";
  notifyPopup(tabId);
  await chrome.runtime.sendMessage({
    type: "START_OFFSCREEN_RECORDING",
    tabId,
    streamId,
    title: tabState.lastTitle || tab.title || "course-recording",
    crop
  });
}

function waitForPagePaint() {
  return new Promise(resolve => setTimeout(resolve, 250));
}

function waitBeforeRecording(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getRecordingCrop(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "SELECT_PLAYER_RECT" }, { frameId: 0 });
    if (response && response.ok && response.crop && response.crop.cancelled) return { cancelled: true };
    if (response && response.ok && response.crop && response.crop.rect) return response.crop;
  } catch (_) {
    // Fall back to direct frame execution when the content script is not attached yet.
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: scanPlayerRectForCourseCapture
    });
    const crop = results && results[0] && results[0].result;
    return crop && crop.rect ? crop : null;
  } catch (_) {
    return null;
  }
}

async function stopRecording(tabId) {
  if (typeof tabId !== "number") {
    const tab = await getActiveTab();
    tabId = tab.id;
  }
  const tabState = getTabState(tabId);
  tabState.status = "Останавливаю запись и сохраняю файл...";
  notifyPopup(tabId);
  const response = await chrome.runtime.sendMessage({ type: "STOP_OFFSCREEN_RECORDING", tabId });
  if (response && response.error) {
    tabState.error = response.error;
    tabState.status = `Не смог остановить запись: ${response.error}`;
    notifyPopup(tabId);
  }
  await unlockRecordingView(tabId);
  return { tabId, response };
}

async function lockRecordingView(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "LOCK_RECORDING_VIEW" }, { frameId: 0 });
    return response && response.crop && response.crop.rect ? response.crop : null;
  } catch (_) {
    // Locking is best effort; recording can still continue without it.
    return null;
  }
}

async function unlockRecordingView(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "UNLOCK_RECORDING_VIEW" }, { frameId: 0 });
  } catch (_) {
    // The tab may have navigated or the content script may be gone.
  }
}

async function showRecordingCountdown(tabId, seconds) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SHOW_RECORDING_COUNTDOWN", seconds }, { frameId: 0 });
  } catch (_) {
    // Best effort visual helper.
  }
}

async function stopCurrentRecording() {
  const recordingTabId = findRecordingTabId();
  if (typeof recordingTabId === "number") {
    await stopRecording(recordingTabId);
    return;
  }

  const tab = await getActiveTab();
  await stopRecording(tab.id);
}

function findRecordingTabId() {
  for (const [tabId, tabState] of state.tabs.entries()) {
    if (tabState.recording) return tabId;
  }
  return null;
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record the selected course tab with audio as a fallback."
  });
}

function connectNative() {
  if (state.nativePort) return state.nativePort;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    state.nativePort = port;
    state.nativeReady = true;
    state.lastNativeError = null;
    port.onDisconnect.addListener(() => {
      state.nativePort = null;
      state.nativeReady = false;
      if (chrome.runtime.lastError) {
        state.lastNativeError = chrome.runtime.lastError.message;
      }
    });
    port.onMessage.addListener(message => {
      handleNativeMessage(message).catch(error => {
        console.warn("Video Course Capture native message handling failed", error);
      });
    });
    return port;
  } catch (error) {
    state.nativeReady = false;
    state.lastNativeError = String(error && error.message ? error.message : error);
    throw error;
  }
}

async function handleNativeMessage(message) {
  if (!message || typeof message.tabId !== "number") return;

  const tabState = getTabState(message.tabId);

  if (message.event === "recording_chunk") {
    tabState.recordingBytes = Number(message.bytes) || tabState.recordingBytes || 0;
    const now = Date.now();
    if (now - (tabState.lastProgressUiAt || 0) < 1500) return;
    tabState.lastProgressUiAt = now;
    notifyPopup(message.tabId);
    return;
  }

  const translatedStatus = translateNativeStatus(message);
  if (translatedStatus) {
    tabState.status = translatedStatus;
  }

  if (message.event === "verify_retry") {
    tabState.verifyingSource = true;
    notifyPopup(message.tabId);
    return;
  }

  if (message.event === "progress") {
    if (message.progress) {
      tabState.downloadProgress = message.progress;
    }
    const now = Date.now();
    if (now - (tabState.lastProgressUiAt || 0) < 1500) return;
    tabState.lastProgressUiAt = now;
    notifyPopup(message.tabId);
    return;
  }

  if (message.event === "cancelled" || message.event === "cancel_download") {
    tabState.busy = false;
    tabState.downloading = false;
    tabState.cancellingDownload = false;
    tabState.downloadOutcome = "";
    tabState.downloadProgress = null;
    tabState.armed = false;
    tabState.status = message.message || "Скачивание отменено.";
    notifyPopup(message.tabId);
    return;
  }

  if (message.event === "done") {
    tabState.busy = false;
    tabState.downloading = false;
    tabState.downloadProgress = null;
    if (message.ok) {
      tabState.downloadOutcome = "success";
      tabState.armed = false;
    } else {
      tabState.downloadOutcome = "error";
      if (message.error) tabState.error = message.error;
    }
  }

  notifyPopup(message.tabId);
}

async function cancelDownload(tabId) {
  if (typeof tabId !== "number") {
    const tab = await getActiveTab();
    tabId = tab.id;
  }
  const tabState = getTabState(tabId);
  tabState.status = "Останавливаю скачивание yt-dlp...";
  tabState.cancellingDownload = true;
  notifyPopup(tabId);
  const response = await sendNative({
    command: "cancel_download",
    tabId
  });
  tabState.busy = false;
  tabState.downloading = false;
  tabState.cancellingDownload = false;
  tabState.downloadOutcome = "";
  tabState.armed = false;
  tabState.status = response.message || "Скачивание остановлено.";
  notifyPopup(tabId);
  return { tabId, response };
}

function enrichCandidate(candidate) {
  const info = classifyUrl(candidate.url);
  return {
    ...candidate,
    score: candidate.score || scoreUrl(candidate.url),
    kind: info.kind,
    label: info.label,
    host: info.host,
    path: info.path
  };
}

function buildFilenameHint(candidate, candidates) {
  return [
    `video-${candidateVideoNumber(candidate, candidates || [])}`,
    candidateVariantLabel(candidate),
    candidateShortId(candidate)
  ].filter(Boolean).join("-");
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
  if (candidate.kind === "vkvideo") return "current-video";
  if (candidate.kind === "youtube") return "current-video";
  if (/master|get-master-playlist|\/master(\/|$|\?)/i.test(text)) return "master";
  if (/sign-player/i.test(text)) return "sign-api";
  const quality = text.match(/(?:\/|_|-)(240|360|480|540|720|1080|1440|2160)(?:p)?(?:\/|\.|_|-|\?|$)/i);
  if (quality) return `${quality[1]}p`;
  if (candidate.kind === "hls") return "hls";
  if (candidate.kind === "dash") return "dash";
  if (candidate.kind === "embed") return "player";
  if (candidate.kind === "file") return "file";
  return "source";
}

function candidateShortId(candidate) {
  try {
    const parsed = new URL(candidate.url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const playlistIndex = parts.findIndex(part => /^(master|media|get-master-playlist|get-media-playlist)$/i.test(part));
    const id = playlistIndex >= 0 && parts[playlistIndex + 1]
      ? parts[playlistIndex + 1]
      : (parsed.searchParams.get("id") || parsed.searchParams.get("video") || "");
    return String(id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  } catch {
    return "";
  }
}

function classifyUrl(url) {
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  let kind = "unknown";
  let label = "возможный media URL";
  if (DIRECT_FILE_EXTENSIONS.test(url)) {
    kind = "file";
    label = "видеофайл";
  } else if (canonicalVkVideoUrl(url)) {
    kind = "vkvideo";
    label = "VK Video";
  } else if (canonicalYouTubeWatchUrl(url)) {
    kind = "youtube";
    label = "YouTube";
  } else if (HLS_EXTENSION.test(url)) {
    kind = "hls";
    label = "HLS поток (.m3u8)";
  } else if (DASH_EXTENSION.test(url)) {
    kind = "dash";
    label = "DASH поток (.mpd)";
  } else if (/m3u8|hls|master|playlist/i.test(url)) {
    kind = "hls";
    label = "HLS поток";
  } else if (/mpd|dash|manifest/i.test(url)) {
    kind = "dash";
    label = "DASH поток";
  } else if (SEGMENT_EXTENSION.test(url)) {
    kind = "segment";
    label = "сегмент потока";
  } else if (/vk\.com\/video_ext\.php/i.test(url)) {
    kind = "embed";
    label = "VK embed-плеер";
  } else if (/kinescope\.io\/embed\//i.test(url)) {
    kind = "embed";
    label = "Kinescope embed-плеер";
  } else if (isEmbedPlayerUrl(url)) {
    kind = "embed";
    label = "embed-плеер";
  } else if (/videoplayback/i.test(url)) {
    kind = "playback";
    label = "video playback";
  }

  return {
    kind,
    label,
    host: parsed ? parsed.host : "",
    path: parsed ? parsed.pathname.split("/").filter(Boolean).slice(-2).join("/") : ""
  };
}

function canonicalYouTubeWatchUrl(url) {
  try {
    const parsed = new URL(url);
    const id = youtubeVideoIdFromUrl(parsed);
    if (!id) return "";
    return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  } catch {
    return "";
  }
}

function canonicalPageVideoUrl(url) {
  return canonicalYouTubeWatchUrl(url) || canonicalVkVideoUrl(url);
}

function isSingleVideoPageUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    return host === "youtube.com"
      || host === "m.youtube.com"
      || host === "youtu.be"
      || host === "vkvideo.ru"
      || host === "m.vkvideo.ru";
  } catch {
    return false;
  }
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

function canonicalVkVideoUrl(url) {
  try {
    const parsed = new URL(url);
    const id = vkVideoIdFromUrl(parsed);
    if (!id) return "";
    return `https://vkvideo.ru/video${id}`;
  } catch {
    return "";
  }
}

function vkVideoIdFromUrl(parsed) {
  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "vkvideo.ru" && host !== "m.vkvideo.ru") return "";
  const match = parsed.pathname.match(/^\/video(-?\d+_\d+)/i);
  return match ? match[1] : "";
}

function normalizeVerifyInfo(info) {
  if (!info || typeof info !== "object") {
    return { ok: false, error: "Пустой ответ yt-dlp" };
  }
  if (info.error) {
    return { ok: false, error: String(info.error) };
  }
  const title = String(info.title || info.fulltitle || "").trim();
  const duration = formatDuration(info.duration);
  const extractor = String(info.extractor || info.extractor_key || "").trim();
  const webpageUrl = String(info.webpage_url || info.original_url || "").trim();
  const size = formatApproxSize(info.filesize || info.filesize_approx || info.requested_downloads && estimateRequestedSize(info.requested_downloads));
  const warnings = [];
  if (!title || looksLikeUrlOrPath(title)) warnings.push("yt-dlp не вернул нормальное название видео");
  if (!duration) warnings.push("yt-dlp не вернул длительность");
  if (/generic|hls|native/i.test(extractor) && !duration) warnings.push("это похоже на технический HLS URL, а не на страницу видео");
  return {
    ok: true,
    confirmed: warnings.length === 0,
    title,
    duration,
    extractor,
    webpageUrl,
    size,
    warning: warnings.join("; ")
  };
}

function looksLikeUrlOrPath(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) || /^[\w.-]+\.[a-z]{2,}\//i.test(text) || /[?&](jwt|sign|token|expires|username|view)=/i.test(text);
}

function estimateRequestedSize(downloads) {
  if (!Array.isArray(downloads)) return 0;
  return downloads.reduce((sum, item) => sum + (Number(item.filesize || item.filesize_approx) || 0), 0);
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function formatApproxSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function translateNativeStatus(message) {
  if (!message) return "";
  if (message.event === "started") return "yt-dlp запущен. Скачивание началось.";
  if (message.event === "verify_retry") return "Вторая попытка проверки...";
  if (message.event === "done" && message.ok) return "yt-dlp закончил. Файл лежит в папке downloads.";
  if (message.event === "done" && !message.ok) return `yt-dlp завершился с ошибкой: ${message.error || "unknown"}`;
  if (message.event === "progress" && message.message) {
    if (/\[download\]/i.test(message.message)) return "Скачивает фрагменты через yt-dlp...";
    if (/fragment/i.test(message.message)) return "Скачивает фрагменты через yt-dlp...";
    if (/ERROR:/i.test(message.message)) return message.message;
    return "";
  }
  return message.message || "";
}

function sendNative(payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const port = connectNative();
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Native host timeout"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      port.onMessage.removeListener(onMessage);
    }

    function onMessage(message) {
      if (!message || message.requestId !== requestId || message.event === "progress" || message.event === "verify_retry") return;
      cleanup();
      if (message.ok) resolve(message);
      else reject(new Error(message.error || "Native host failed"));
    }

    port.onMessage.addListener(onMessage);
    port.postMessage({ ...payload, requestId });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number") throw new Error("No active tab");
  return tab;
}

function notifyPopup(tabId) {
  updateActionBadge(tabId);
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", tabId, state: publicTabState(tabId) }).catch(() => {});
}

function updateActionBadge(tabId) {
  const tabState = getTabState(tabId);
  let text = "";
  let color = "#657184";

  if (tabState.downloadOutcome === "success") {
    text = "V";
    color = "#16823a";
  } else if (tabState.downloadOutcome === "error" || tabState.error) {
    text = "X";
    color = "#b52828";
  }

  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (text) {
    chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  }
}

async function getSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return normalizeSettings(settings);
}

function normalizeSettings(settings) {
  const result = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  result.ytDlpPath = String(result.ytDlpPath || DEFAULT_SETTINGS.ytDlpPath).trim();
  result.ffmpegDir = String(result.ffmpegDir || DEFAULT_SETTINGS.ffmpegDir).trim();
  result.downloadDir = String(result.downloadDir || DEFAULT_SETTINGS.downloadDir).trim();
  result.maxDownloadGb = clampNumber(result.maxDownloadGb, 1, 200, DEFAULT_SETTINGS.maxDownloadGb);
  result.mergeFormat = ["mp4", "mkv", "webm"].includes(result.mergeFormat) ? result.mergeFormat : DEFAULT_SETTINGS.mergeFormat;
  result.fragmentRetries = clampNumber(result.fragmentRetries, 0, 50, DEFAULT_SETTINGS.fragmentRetries);
  result.socketTimeout = clampNumber(result.socketTimeout, 5, 300, DEFAULT_SETTINGS.socketTimeout);
  return result;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
