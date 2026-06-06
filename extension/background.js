// Video Course Capture
// Purpose: Chrome extension service worker that owns tab state, source detection, verification, downloading, recording orchestration, settings, and native-host messaging.
// Most to know: this file is the main coordinator; it keeps candidate verification separate from downloading so the user confirms the real media before saving it.
// Developed and maintained by Alexey Kagansky
// Copyright (c) 2026 Alexey Kagansky
// Repository: https://github.com/ale4ko69/chrome-course-capture

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
  downloadDir: "downloads",
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

/**
 * Builds a locale-ready status payload for the popup.
 * @param {string} key Locale key in extension/locales/*.json.
 * @param {Object} params Values used by the locale template.
 * @returns {{key: string, params: Object}} Serializable popup status.
 */
function statusMessage(key, params = {}) {
  return { key, params };
}

/**
 * Returns a fallback text only when an external tool still sends plain text.
 * @param {*} value External status value.
 * @param {string} fallbackKey Locale key used when value is empty.
 * @param {Object} fallbackParams Values used by the fallback template.
 * @returns {*} Plain text from the external tool or a locale-ready status object.
 */
function statusFromExternal(value, fallbackKey, fallbackParams = {}) {
  return value || statusMessage(fallbackKey, fallbackParams);
}

// Seed default settings on install so the popup can render immediately.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(DEFAULT_SETTINGS).then(values => {
    chrome.storage.local.set(values);
  });
});

// Watch network traffic for media-looking requests while the tab is playing.
chrome.webRequest.onBeforeRequest.addListener(
  details => {
    if (details.tabId < 0 || !details.url || !isMediaCandidate(details.url)) {
      return;
    }
    rememberNetworkCandidate(details.tabId, details.url, details.type);
  },
  { urls: ["<all_urls>"] }
);

// Main message router for popup, content scripts, and offscreen recorder.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(error => {
    sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
  });
  return true;
});

// Drop per-tab state when Chrome closes the tab.
chrome.tabs.onRemoved.addListener(tabId => {
  state.tabs.delete(tabId);
});

// Keyboard shortcut fallback for stopping recording without opening the popup.
chrome.commands.onCommand.addListener(command => {
  if (command === "stop-recording") {
    stopCurrentRecording().catch(error => {
      console.warn("Video Course Capture could not stop recording from shortcut", error);
    });
  }
});


/**
 * Routes an incoming command to the correct handler and returns a response object for the caller.
 * @param {*} message Input used by this step.
 * @param {*} sender Input used by this step.
 * @returns {*} Result used by the caller.
 */
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
    tabState.status = statusMessage("status.readyPlay");
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
    tabState.status = statusMessage("status.idle");
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
    const result = await startRecording(tab.id);
    return { ok: result.ok, error: result.error || "", state: publicTabState(tab.id) };
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
      tabState.status = statusMessage("status.recordingSaved", { filename: message.filename });
      notifyPopup(message.tabId);
      return { ok: true };
    } catch (error) {
      tabState.recording = false;
      tabState.busy = false;
      tabState.recordingStartedAt = 0;
      tabState.recordingBytes = 0;
      tabState.error = String(error && error.message ? error.message : error);
      tabState.status = statusMessage("status.recordingSaveFailed", { error: tabState.error });
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
    }, 120000);
    const tabState = getTabState(message.tabId);
    tabState.recording = false;
    tabState.busy = false;
    tabState.recordingStartedAt = 0;
    tabState.recordingBytes = 0;
    tabState.status = statusFromExternal(response.message, "status.recordingSavedFolder");
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


/**
 * Checks whether a URL looks like a supported media source.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
function isMediaCandidate(url) {
  return !isNonMediaManifestUrl(url)
    && (MEDIA_EXTENSIONS.test(url) || /m3u8|mpd|hls|dash|videoplayback|playlist|master/i.test(url) || isEmbedPlayerUrl(url));
}


/**
 * Rejects web/app manifests that contain the word "manifest" but are not media.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
function isNonMediaManifestUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    return /(^|\/)(manifest|site)\.(json|webmanifest)$/.test(pathname)
      || pathname.endsWith("/manifest.json")
      || pathname.endsWith(".webmanifest");
  } catch {
    return false;
  }
}


/**
 * Scores media URLs so stronger candidates sort ahead of noisy fragments.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
function scoreUrl(url) {
  if (canonicalVkVideoUrl(url)) return 168;
  if (canonicalYouTubeWatchUrl(url)) return 170;
  if (/\/api\/playlist\/master\/|get-master-playlist/i.test(url)) return 180;
  if (/\/api\/playlist\/media\/|get-media-playlist/i.test(url)) return 145;
  if (HLS_EXTENSION.test(url)) return 160;
  if (DASH_EXTENSION.test(url)) return 150;
  if (/m3u8|hls|master|playlist/i.test(url)) return 140;
  if (/mpd|dash/i.test(url)) return 130;
  if (DIRECT_FILE_EXTENSIONS.test(url)) return 120;
  if (/videoplayback/i.test(url)) return 115;
  if (/vk\.com\/video_ext\.php/i.test(url)) return 85;
  if (/kinescope\.io\/embed\//i.test(url)) return 84;
  if (isEmbedPlayerUrl(url)) return 80;
  if (/\.(ts|m4s)(\?|#|$)/i.test(url)) return 25;
  return 35;
}


/**
 * Checks whether a URL looks like an embedded player page.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
function isEmbedPlayerUrl(url) {
  return EMBED_PLAYER_PATTERNS.some(pattern => pattern.test(url));
}


/**
 * Creates or returns the state object for a browser tab.
 * @param {*} tabId Input used by this step.
 * @returns {*} Result used by the caller.
 */
function getTabState(tabId) {
  if (!state.tabs.has(tabId)) {
    state.tabs.set(tabId, {
      armed: false,
      busy: false,
      recording: false,
      status: statusMessage("status.idle"),
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


/**
 * Adds or updates a candidate while preserving verification state.
 * @param {*} tabId Input used by this step.
 * @param {*} candidate Input used by this step.
 * @returns {*} Result used by the caller.
 */
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
    tabState.status = statusMessage("status.candidatesFound", { count: publicCandidates(tabState.candidates).length });
  }
  notifyPopup(tabId);
  return true;
}


/**
 * Records a candidate observed through Chrome webRequest.
 * @param {*} tabId Input used by this step.
 * @param {*} url Input used by this step.
 * @param {*} type Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Adds the canonical current-page video URL when the site is a single-video page.
 * @param {*} tabId Input used by this step.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Builds the sanitized state object sent to the popup.
 * @param {*} tabId Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Schedules automatic capture after the page has produced a promising candidate.
 * @param {*} tabId Input used by this step.
 * @param {*} delay Input used by this step.
 * @returns {*} Result used by the caller.
 */
function scheduleAutoCapture(tabId, delay = null) {
  const tabState = getTabState(tabId);
  if (tabState.autoTimer) clearTimeout(tabState.autoTimer);
  const best = tabState.candidates[0];
  const waitMs = typeof delay === "number" ? delay : delayForCandidate(best);
  if (!tabState.verifiedStatus) {
    tabState.status = best && best.kind === "embed"
      ? statusMessage("status.waitingEmbedPlaylist")
      : statusMessage("status.waitingVideoSource");
    notifyPopup(tabId);
  }
  tabState.autoTimer = setTimeout(async () => {
    const current = getTabState(tabId);
    if (!current.armed || current.busy || current.verifiedStatus) return;
    current.status = statusMessage("status.candidateReadyVerify");
    notifyPopup(tabId);
  }, waitMs);
}


/**
 * Keeps the candidate list compact without dropping the confirmed source.
 * @param {*} candidates Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Filters and formats candidates for user-facing display.
 * @param {*} candidates Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Checks whether a candidate group contains a useful high-confidence item.
 * @param {*} group Input used by this step.
 * @returns {*} Result used by the caller.
 */
function groupHasStrongPublicCandidate(group) {
  return group.some(candidate => {
    if (candidate.check && candidate.check.confirmed) return true;
    if (isMasterCandidate(candidate)) return true;
    if (candidateQualityHeight(candidate) >= 720) return true;
    return ["youtube", "vkvideo", "embed", "hls", "dash", "file"].includes(candidate.kind);
  });
}


/**
 * Detects fragment-only or low-confidence groups that should be hidden when better options exist.
 * @param {*} group Input used by this step.
 * @returns {*} Result used by the caller.
 */
function isWeakTechnicalGroup(group) {
  return !group.some(candidate => {
    if (candidate.check && candidate.check.confirmed) return true;
    if (isMasterCandidate(candidate)) return true;
    if (candidateQualityHeight(candidate) >= 720) return true;
    return ["youtube", "vkvideo", "embed", "hls", "dash", "file"].includes(candidate.kind);
  });
}


/**
 * Chooses which variants from a grouped video should appear in the combo box.
 * @param {*} group Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Sorts display candidates by source strength, video number, and quality.
 * @param {*} candidates Input used by this step.
 * @returns {*} Result used by the caller.
 */
function sortPublicCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const aRank = publicCandidateRank(a);
    const bRank = publicCandidateRank(b);
    return (aRank - bRank) || (candidateQualityHeight(b) - candidateQualityHeight(a)) || (b.score - a.score) || (b.at - a.at);
  });
}


/**
 * Returns a sort rank for one display candidate.
 * @param {*} candidate Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Finds the least-bad candidate when no HD or strong stream exists.
 * @param {*} candidates Input used by this step.
 * @returns {*} Result used by the caller.
 */
function bestFallbackCandidate(candidates) {
  return [...candidates].sort((a, b) => {
    return (candidateQualityHeight(b) - candidateQualityHeight(a)) || (b.score - a.score) || (b.at - a.at);
  })[0] || null;
}


/**
 * Removes duplicate candidates by canonical URL.
 * @param {*} candidates Input used by this step.
 * @returns {*} Result used by the caller.
 */
function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    if (!candidate || seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}


/**
 * Checks whether a candidate is an HLS/DASH master playlist.
 * @param {*} candidate Input used by this step.
 * @returns {*} Result used by the caller.
 */
function isMasterCandidate(candidate) {
  const text = `${candidate.url || ""} ${candidate.path || ""}`;
  return /master|get-master-playlist|\/master(\/|$|\?)/i.test(text);
}


/**
 * Extracts height such as 720 or 1080 from candidate metadata or URL.
 * @param {*} candidate Input used by this step.
 * @returns {*} Result used by the caller.
 */
function candidateQualityHeight(candidate) {
  const text = `${candidate.url || ""} ${candidate.path || ""}`;
  const quality = text.match(/(?:\/|_|-)(240|360|480|540|720|1080|1440|2160)(?:p)?(?:\/|\.|_|-|\?|$)/i);
  return quality ? Number(quality[1]) : 0;
}


/**
 * Returns debounce delay before auto-capture for a candidate.
 * @param {*} candidate Input used by this step.
 * @returns {*} Result used by the caller.
 */
function delayForCandidate(candidate) {
  if (!candidate) return 2500;
  if (["hls", "dash", "file", "playback"].includes(candidate.kind)) return 300;
  if (candidate.kind === "embed") return 5000;
  return 3000;
}


/**
 * Downloads the best currently confirmed candidate when auto-flow allows it.
 * @param {*} tabId Input used by this step.
 * @param {*} reason Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function downloadBestCandidate(tabId, reason) {
  const tabState = getTabState(tabId);
  const candidate = tabState.candidates[0];
  if (!candidate) {
    tabState.status = statusMessage("status.noCandidate");
    notifyPopup(tabId);
    return { ok: false, error: "No candidate" };
  }
  if (reason === "manual" && !(candidate.check && candidate.check.confirmed)) {
    tabState.status = statusMessage("status.verifyFirst");
    notifyPopup(tabId);
    return { ok: false, error: "Source is not confirmed", state: publicTabState(tabId) };
  }

  return downloadCandidate(tabId, candidate, reason);
}


/**
 * Collects media URLs, embeds, page title, and resources visible in the page DOM.
 * @param {*} tabId Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function scanPage(tabId) {
  const tabState = getTabState(tabId);
  tabState.status = statusMessage("status.scanning");
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
      tabState.status = statusMessage("status.scanFailed");
      notifyPopup(tabId);
      return { ok: false, error: tabState.error, state: publicTabState(tabId) };
    }
    try {
      const response = await scanPageWithScripting(tabId);
      return finishScan(tabId, response, true);
    } catch (fallbackError) {
      tabState.error = String(fallbackError && fallbackError.message ? fallbackError.message : fallbackError);
      tabState.status = statusMessage("status.scanNeedsReload");
      notifyPopup(tabId);
      return { ok: false, error: tabState.error, state: publicTabState(tabId) };
    }
  }
}


/**
 * Documents the finish scan helper.
 * @param {*} tabId Input used by this step.
 * @param {*} response Input used by this step.
 * @param {*} usedFallback Input used by this step.
 * @returns {*} Result used by the caller.
 */
function finishScan(tabId, response, usedFallback) {
  const tabState = getTabState(tabId);
  const total = (response && ((response.videos || 0) + (response.embeds || 0) + (response.resources || 0))) || 0;
  if (!tabState.verifiedStatus) {
    tabState.status = total
      ? statusMessage("status.scanDone", { videos: response.videos || 0, embeds: response.embeds || 0, resources: response.resources || 0 })
      : statusMessage("status.scanNoNew");
  }
  notifyPopup(tabId);
  return { ok: true, state: publicTabState(tabId), response };
}


/**
 * Runs the content scan in every frame through chrome.scripting.
 * @param {*} tabId Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Frame-local scanner injected by chrome.scripting to collect video and embed URLs.
 * @returns {*} Result used by the caller.
 */
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
  const isNonMediaManifest = url => {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.toLowerCase();
      return /(^|\/)(manifest|site)\.(json|webmanifest)$/.test(pathname)
        || pathname.endsWith("/manifest.json")
        || pathname.endsWith(".webmanifest");
    } catch (_) {
      return false;
    }
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
    if (!isNonMediaManifest(entry.name) && (mediaExtensions.test(entry.name) || /videoplayback|playlist|master|m3u8|mpd/i.test(entry.name))) {
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


/**
 * Frame-local scanner injected by chrome.scripting to find player rectangles.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Looks up a candidate by URL and starts the download flow.
 * @param {*} tabId Input used by this step.
 * @param {*} url Input used by this step.
 * @param {*} reason Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function downloadCandidateByUrl(tabId, url, reason) {
  const tabState = getTabState(tabId);
  const candidate = tabState.candidates.find(item => item.url === url);
  if (!candidate) {
    tabState.status = statusMessage("status.candidateNotFound");
    notifyPopup(tabId);
    return { ok: false, error: "Candidate not found" };
  }
  if (reason === "manual" && !(candidate.check && candidate.check.confirmed)) {
    tabState.status = statusMessage("status.verifyFirst");
    notifyPopup(tabId);
    return { ok: false, error: "Source is not confirmed", state: publicTabState(tabId) };
  }

  return downloadCandidate(tabId, candidate, reason);
}


/**
 * Looks up a candidate by URL and starts metadata verification.
 * @param {*} tabId Input used by this step.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function verifyCandidateByUrl(tabId, url) {
  const tabState = getTabState(tabId);
  const candidate = tabState.candidates.find(item => item.url === url);
  if (!candidate) {
    tabState.status = statusMessage("status.candidateNotFound");
    notifyPopup(tabId);
    return { ok: false, error: "Candidate not found", state: publicTabState(tabId) };
  }

  const tab = await chrome.tabs.get(tabId);
  tabState.verifyingSource = true;
  tabState.error = "";
  tabState.status = statusMessage("status.verifyingWithHost", { host: candidate.host || "found URL" });
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
      ? statusMessage("status.sourceConfirmed", { title: candidate.check.title, duration: candidate.check.duration ? `, ${candidate.check.duration}` : "" })
      : candidate.check.ok
        ? statusMessage("status.sourceReadableNotConfirmed", { warning: candidate.check.warning || "no normal title or duration" })
      : statusMessage("status.verificationFailed", { error: candidate.check.error || "metadata unavailable" });
    tabState.status = tabState.verifiedStatus;
    notifyPopup(tabId);
    return { ok: candidate.check.confirmed, info: candidate.check, state: publicTabState(tabId) };
  } catch (error) {
    candidate.check = { ok: false, error: String(error && error.message ? error.message : error) };
    tabState.verifyingSource = false;
    tabState.verifiedStatus = statusMessage("status.verificationFailed", { error: candidate.check.error });
    tabState.status = tabState.verifiedStatus;
    notifyPopup(tabId);
    return { ok: false, error: candidate.check.error, state: publicTabState(tabId) };
  }
}


/**
 * Sends a verified candidate to the native host for downloading.
 * @param {*} tabId Input used by this step.
 * @param {*} candidate Input used by this step.
 * @param {*} reason Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function downloadCandidate(tabId, candidate, reason) {
  const tabState = getTabState(tabId);
  const tab = await chrome.tabs.get(tabId);
  tabState.busy = true;
  tabState.downloading = true;
  tabState.downloadOutcome = "";
  tabState.downloadProgress = null;
  tabState.verifiedStatus = "";
  tabState.status = statusMessage("status.downloadingCandidate", { label: candidate.label, host: candidate.host || "found URL" });
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
    tabState.status = statusFromExternal(response.message, "status.downloadStarted");
    notifyPopup(tabId);
    return { ok: true, response, state: publicTabState(tabId) };
  } catch (error) {
    tabState.busy = false;
    tabState.downloading = false;
    tabState.downloadOutcome = "error";
    tabState.error = String(error && error.message ? error.message : error);
    tabState.status = statusMessage("status.downloadFailedCanRecord");
    notifyPopup(tabId);
    return { ok: false, error: tabState.error, state: publicTabState(tabId) };
  }
}


/**
 * Collects Chrome cookies for the candidate URLs so yt-dlp can access logged-in pages.
 * @param {*} urls Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Initializes a file-backed recording session before MediaRecorder chunks start arriving.
 * @param {*} tabId Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function startRecording(tabId) {
  const tabState = getTabState(tabId);
  tabState.status = statusMessage("status.findingRecordingArea");
  tabState.error = "";
  notifyPopup(tabId);
  const crop = await getRecordingCrop(tabId);
  if (crop && crop.cancelled) {
    tabState.status = statusMessage("status.recordingAreaCancelled");
    tabState.busy = false;
    tabState.recording = false;
    notifyPopup(tabId);
    return { ok: false, error: "Recording area selection cancelled" };
  }
  if (!crop || !crop.rect) {
    tabState.status = statusMessage("status.recordingPlayerNotFound");
    tabState.busy = false;
    tabState.recording = false;
    notifyPopup(tabId);
    return { ok: false, error: "Recording player area not found" };
  }
  await lockRecordingView(tabId);
  tabState.status = statusMessage("status.playerSelectedCountdown");
  notifyPopup(tabId);
  await showRecordingCountdown(tabId, 5);
  await waitBeforeRecording(5000);
  await waitForPagePaint();
  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const tab = await chrome.tabs.get(tabId);
  tabState.recording = true;
  tabState.busy = true;
  tabState.recordingStartedAt = Date.now();
  tabState.recordingBytes = 0;
  tabState.status = statusMessage("status.recordingPlayerArea", { label: crop.label || crop.selector || "player" });
  tabState.error = "";
  notifyPopup(tabId);
  await chrome.runtime.sendMessage({
    type: "START_OFFSCREEN_RECORDING",
    tabId,
    streamId,
    title: tabState.lastTitle || tab.title || "course-recording",
    crop
  });
  return { ok: true };
}


/**
 * Waits for the page to paint before starting visual recording.
 * @returns {*} Result used by the caller.
 */
function waitForPagePaint() {
  return new Promise(resolve => setTimeout(resolve, 250));
}


/**
 * Waits a fixed delay while the recording target remains locked.
 * @param {*} ms Input used by this step.
 * @returns {*} Result used by the caller.
 */
function waitBeforeRecording(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * Requests the selected recording rectangle from the content script.
 * @param {*} tabId Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function getRecordingCrop(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "SELECT_PLAYER_RECT" }, { frameId: 0 });
    if (response && response.ok && response.crop && response.crop.cancelled) return { cancelled: true };
    if (response && response.ok && response.crop && response.crop.rect) return response.crop;
    return null;
  } catch (_) {
    return null;
  }
}


/**
 * Completes the current recording, remuxes it when possible, and reports the saved file.
 * @param {*} tabId Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function stopRecording(tabId) {
  if (typeof tabId !== "number") {
    const tab = await getActiveTab();
    tabId = tab.id;
  }
  const tabState = getTabState(tabId);
  tabState.status = statusMessage("status.stoppingRecording");
  notifyPopup(tabId);
  const response = await chrome.runtime.sendMessage({ type: "STOP_OFFSCREEN_RECORDING", tabId });
  if (response && response.error) {
    tabState.error = response.error;
    tabState.status = statusMessage("status.stopRecordingFailed", { error: response.error });
    notifyPopup(tabId);
  }
  await unlockRecordingView(tabId);
  return { tabId, response };
}


/**
 * Asks the content script to lock scrolling and keep the selected player fixed.
 * @param {*} tabId Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function lockRecordingView(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "LOCK_RECORDING_VIEW" }, { frameId: 0 });
    return response && response.crop && response.crop.rect ? response.crop : null;
  } catch (_) {
    // Locking is best effort; recording can still continue without it.
    return null;
  }
}


/**
 * Asks the content script to remove recording lock UI.
 * @param {*} tabId Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function unlockRecordingView(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "UNLOCK_RECORDING_VIEW" }, { frameId: 0 });
  } catch (_) {
    // The tab may have navigated or the content script may be gone.
  }
}


/**
 * Displays the countdown before recording starts.
 * @param {*} tabId Input used by this step.
 * @param {*} seconds Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function showRecordingCountdown(tabId, seconds) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SHOW_RECORDING_COUNTDOWN", seconds }, { frameId: 0 });
  } catch (_) {
    // Best effort visual helper.
  }
}


/**
 * Finds and stops the currently active recording tab.
 * @returns {*} Result used by the caller.
 */
async function stopCurrentRecording() {
  const recordingTabId = findRecordingTabId();
  if (typeof recordingTabId === "number") {
    await stopRecording(recordingTabId);
    return;
  }

  const tab = await getActiveTab();
  await stopRecording(tab.id);
}


/**
 * Returns the tab id that currently owns an active recording.
 * @returns {*} Result used by the caller.
 */
function findRecordingTabId() {
  for (const [tabId, tabState] of state.tabs.entries()) {
    if (tabState.recording) return tabId;
  }
  return null;
}


/**
 * Creates the offscreen recorder document when it does not already exist.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Opens the native messaging port and wires disconnect/progress handlers.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Applies progress and completion events received from the native host.
 * @param {*} message Input used by this step.
 * @returns {*} Result used by the caller.
 */
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
    tabState.status = statusFromExternal(message.message, "status.downloadCancelled");
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


/**
 * Cancels an active yt-dlp process for the requested browser tab.
 * @param {*} tabId Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function cancelDownload(tabId) {
  if (typeof tabId !== "number") {
    const tab = await getActiveTab();
    tabId = tab.id;
  }
  const tabState = getTabState(tabId);
  tabState.status = statusMessage("status.stoppingDownload");
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
  tabState.status = statusFromExternal(response.message, "status.downloadStopped");
  notifyPopup(tabId);
  return { tabId, response };
}


/**
 * Adds derived labels and grouping metadata to a candidate.
 * @param {*} candidate Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Builds a friendly filename hint from candidate and page metadata.
 * @param {*} candidate Input used by this step.
 * @param {*} candidates Input used by this step.
 * @returns {*} Result used by the caller.
 */
function buildFilenameHint(candidate, candidates) {
  return [
    `video-${candidateVideoNumber(candidate, candidates || [])}`,
    candidateVariantLabel(candidate),
    candidateShortId(candidate)
  ].filter(Boolean).join("-");
}


/**
 * Calculates the visible video number for grouped candidates.
 * @param {*} candidate Input used by this step.
 * @param {*} candidates Input used by this step.
 * @returns {*} Result used by the caller.
 */
function candidateVideoNumber(candidate, candidates) {
  const keys = [];
  for (const item of candidates) {
    const key = candidateGroupKey(item);
    if (!keys.includes(key)) keys.push(key);
  }
  return Math.max(1, keys.indexOf(candidateGroupKey(candidate)) + 1);
}


/**
 * Builds a grouping key so variants of the same video stay together.
 * @param {*} candidate Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Builds a quality or role label such as master, HD 720p, or DASH.
 * @param {*} candidate Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Documents the candidate short id helper.
 * @param {*} candidate Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Documents the classify url helper.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
function classifyUrl(url) {
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  let kind = "unknown";
  let label = "possible media URL";
  if (DIRECT_FILE_EXTENSIONS.test(url)) {
    kind = "file";
    label = "video file";
  } else if (canonicalVkVideoUrl(url)) {
    kind = "vkvideo";
    label = "VK Video";
  } else if (canonicalYouTubeWatchUrl(url)) {
    kind = "youtube";
    label = "YouTube";
  } else if (HLS_EXTENSION.test(url)) {
    kind = "hls";
    label = "HLS stream (.m3u8)";
  } else if (DASH_EXTENSION.test(url)) {
    kind = "dash";
    label = "DASH stream (.mpd)";
  } else if (/m3u8|hls|master|playlist/i.test(url)) {
    kind = "hls";
    label = "HLS stream";
  } else if (/mpd|dash/i.test(url)) {
    kind = "dash";
    label = "DASH stream";
  } else if (SEGMENT_EXTENSION.test(url)) {
    kind = "segment";
    label = "stream segment";
  } else if (/vk\.com\/video_ext\.php/i.test(url)) {
    kind = "embed";
    label = "VK embed player";
  } else if (/kinescope\.io\/embed\//i.test(url)) {
    kind = "embed";
    label = "Kinescope embed player";
  } else if (isEmbedPlayerUrl(url)) {
    kind = "embed";
    label = "embed player";
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


/**
 * Strips YouTube playlist context so only the central watch video is downloaded.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Returns a canonical page URL for sites where the current page itself is the video.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
function canonicalPageVideoUrl(url) {
  return canonicalYouTubeWatchUrl(url) || canonicalVkVideoUrl(url);
}


/**
 * Detects sites where only the current page URL should be treated as the source.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Extracts a YouTube video id from a parsed URL.
 * @param {*} parsed Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Validates and normalizes a YouTube video id.
 * @param {*} value Input used by this step.
 * @returns {*} Result used by the caller.
 */
function cleanYouTubeId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{6,20}$/.test(id) ? id : "";
}


/**
 * Normalizes VKVideo page URLs to the current video only.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Extracts a VKVideo id from a parsed URL.
 * @param {*} parsed Input used by this step.
 * @returns {*} Result used by the caller.
 */
function vkVideoIdFromUrl(parsed) {
  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "vkvideo.ru" && host !== "m.vkvideo.ru") return "";
  const match = parsed.pathname.match(/^\/video(-?\d+_\d+)/i);
  return match ? match[1] : "";
}


/**
 * Turns native-host verification metadata into popup-ready confirmation state.
 * @param {*} info Input used by this step.
 * @returns {*} Result used by the caller.
 */
function normalizeVerifyInfo(info) {
  if (!info || typeof info !== "object") {
    return { ok: false, error: "Empty yt-dlp response" };
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
  if (!title || looksLikeUrlOrPath(title)) warnings.push("yt-dlp did not return a normal video title");
  if (!duration) warnings.push("yt-dlp did not return duration");
  if (/generic|hls|native/i.test(extractor) && !duration) warnings.push("this looks like a technical HLS URL, not a video page");
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


/**
 * Rejects metadata titles that are really technical URLs or paths.
 * @param {*} value Input used by this step.
 * @returns {*} Result used by the caller.
 */
function looksLikeUrlOrPath(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) || /^[\w.-]+\.[a-z]{2,}\//i.test(text) || /[?&](jwt|sign|token|expires|username|view)=/i.test(text);
}


/**
 * Documents the estimate requested size helper.
 * @param {*} downloads Input used by this step.
 * @returns {*} Result used by the caller.
 */
function estimateRequestedSize(downloads) {
  if (!Array.isArray(downloads)) return 0;
  return downloads.reduce((sum, item) => sum + (Number(item.filesize || item.filesize_approx) || 0), 0);
}


/**
 * Formats duration seconds as h:mm:ss or m:ss.
 * @param {*} seconds Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Formats approximate bytes as a readable size.
 * @param {*} bytes Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Maps native-host progress events to locale-ready popup status payloads.
 * @param {*} message Input used by this step.
 * @returns {*} Result used by the caller.
 */
function translateNativeStatus(message) {
  if (!message) return "";
  if (message.event === "started") return statusMessage("status.ytdlpStarted");
  if (message.event === "verify_retry") return statusMessage("status.verifyRetry");
  if (message.event === "done" && message.ok) return statusMessage("status.ytdlpDone");
  if (message.event === "done" && !message.ok) return statusMessage("status.ytdlpFailed", { error: message.error || "unknown" });
  if (message.event === "progress" && message.message) {
    if (/\[download\]/i.test(message.message)) return statusMessage("status.ytdlpFragments");
    if (/fragment/i.test(message.message)) return statusMessage("status.ytdlpFragments");
    if (/ERROR:/i.test(message.message)) return message.message;
    return "";
  }
  return message.message || "";
}


/**
 * Sends a request to the native host and waits for the matching response.
 * @param {*} payload Input used by this step.
 * @param {*} timeoutMs Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Returns the active tab in the current Chrome window.
 * @returns {*} Result used by the caller.
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number") throw new Error("No active tab");
  return tab;
}


/**
 * Notifies popup views that a tab state changed.
 * @param {*} tabId Input used by this step.
 * @returns {*} Result used by the caller.
 */
function notifyPopup(tabId) {
  updateActionBadge(tabId);
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", tabId, state: publicTabState(tabId) }).catch(() => {});
}


/**
 * Updates the extension toolbar badge for the tab.
 * @param {*} tabId Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Documents the get settings helper.
 * @returns {*} Result used by the caller.
 */
async function getSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return normalizeSettings(settings);
}


/**
 * Merges and validates settings received from the extension before using them on disk or in commands.
 * @param {*} settings Input used by this step.
 * @returns {*} Result used by the caller.
 */
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


/**
 * Constrains numeric settings to the supported range and falls back when input is invalid.
 * @param {*} value Input used by this step.
 * @param {*} min Input used by this step.
 * @param {*} max Input used by this step.
 * @param {*} fallback Input used by this step.
 * @returns {*} Result used by the caller.
 */
function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
