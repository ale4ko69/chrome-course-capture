// Video Course Capture
// Purpose: Content script injected into course pages to discover video elements, iframes, page resources, and selectable player rectangles for recording.
// Most to know: this file runs in the page context, so it must avoid heavy work and only reports candidates or recording-area UI back to the background worker.
// Developed and maintained by Alexey Kagansky
// Copyright (c) 2026 Alexey Kagansky
// Repository: https://github.com/ale4ko69/chrome-course-capture

const MEDIA_EXTENSIONS = /\.(mp4|m4v|mov|webm|mkv|m3u8|mpd|ts|m4s)(\?|#|$)/i;
const EMBED_PLAYER_PATTERNS = [
  /vk\.com\/video_ext\.php/i,
  /youtube\.com\/embed\//i,
  /player\.vimeo\.com\/video\//i,
  /rutube\.ru\/play\/embed\//i,
  /kinescope\.io\/embed\//i,
  /player\./i,
  /\/embed\//i
];

/**
 * Rejects web/app manifests that are page metadata rather than media streams.
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

let scrollLock = null;
let recordingBanner = null;
let lastSelectedCropFallback = null;
let scrollBlockerInstalled = false;
let contentLanguage = "ru";
let contentMessages = {};
let contentMessagesPromise = null;

injectPageHook();
initContentI18n();

window.addEventListener("message", event => {
  const data = event.data;
  if (!data || data.source !== "course-capture-frame-crop-request") return;
  event.source.postMessage({
    source: "course-capture-frame-crop-response",
    requestId: data.requestId,
    candidates: getLocalPlayerCropCandidates().map(candidate => ({
      rect: candidate.rect,
      label: candidate.label,
      selector: candidate.selector,
      tag: candidate.tag,
      score: candidate.score
    }))
  }, "*");
});

window.addEventListener("message", event => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "course-capture-page-hook") return;
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  if (!candidates.length && !data.url) return;
  chrome.runtime.sendMessage({
    type: "HLS_FOUND",
    url: data.url || "",
    candidates,
    title: getPageContextTitle()
  }).catch(() => {});
});

document.addEventListener("play", event => {
  const video = event.target;
  if (!(video instanceof HTMLMediaElement)) return;
  reportVideo(video);
}, true);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  if (message.type === "SCAN_PAGE") {
    const result = scanPage();
    sendResponse({ ok: true, ...result });
    return;
  }
  if (message.type === "GET_PLAYER_RECT") {
    getPlayerCropCandidates().then(candidates => {
      sendResponse({ ok: true, crop: cropResponse(candidates[0]), count: candidates.length });
    }).catch(error => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
  if (message.type === "SELECT_PLAYER_RECT") {
    selectPlayerRect().then(crop => {
      sendResponse({ ok: true, crop });
    }).catch(error => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
  if (message.type === "LOCK_RECORDING_VIEW") {
    ensureContentMessages().then(() => {
      const crop = lockRecordingView();
      sendResponse({ ok: true, crop });
    }).catch(error => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
  if (message.type === "SHOW_RECORDING_COUNTDOWN") {
    ensureContentMessages().then(() => {
      showRecordingCountdown(message.seconds || 5);
      sendResponse({ ok: true });
    }).catch(error => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
  if (message.type === "UNLOCK_RECORDING_VIEW") {
    unlockRecordingView();
    sendResponse({ ok: true });
    return;
  }
});

new MutationObserver(() => {
  reportEmbeds();
  for (const video of queryAllDeep(["video", "audio"])) {
    if (!video.dataset.courseCaptureSeen) {
      video.dataset.courseCaptureSeen = "1";
      video.addEventListener("loadedmetadata", () => reportVideo(video), { once: true });
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", reportEmbeds, { once: true });
} else {
  reportEmbeds();
}


/**
 * Initializes localized content-script text before overlays or banners appear.
 * @returns {*} Result used by the caller.
 */
function initContentI18n() {
  contentMessagesPromise = ensureContentMessages();
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.language) return;
      contentLanguage = normalizeContentLanguage(changes.language.newValue);
      contentMessagesPromise = loadContentMessages(contentLanguage).then(messages => {
        contentMessages = messages;
        return messages;
      });
    });
  }
}


/**
 * Loads content-script locale messages once and reuses them.
 * @returns {*} Result used by the caller.
 */
async function ensureContentMessages() {
  if (contentMessagesPromise) return contentMessagesPromise;
  contentMessagesPromise = chrome.storage.local.get(["language"])
    .then(config => {
      contentLanguage = normalizeContentLanguage(config.language || detectDefaultContentLanguage());
      return loadContentMessages(contentLanguage);
    })
    .then(messages => {
      contentMessages = messages;
      return messages;
    })
    .catch(error => {
      console.warn("Video Course Capture could not load content locale", error);
      contentMessages = {};
      return contentMessages;
    });
  return contentMessagesPromise;
}


/**
 * Loads a content-script locale JSON file.
 * @param {*} language Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function loadContentMessages(language) {
  const normalized = normalizeContentLanguage(language);
  const url = chrome.runtime.getURL(`locales/${normalized}.json`);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (normalized !== "ru") return loadContentMessages("ru");
    throw error;
  }
}


/**
 * Maps content-script language values to supported language codes.
 * @param {*} language Input used by this step.
 * @returns {*} Result used by the caller.
 */
function normalizeContentLanguage(language) {
  return language === "en" ? "en" : "ru";
}


/**
 * Chooses the content-script language from Chrome and page locale hints.
 * @returns {*} Result used by the caller.
 */
function detectDefaultContentLanguage() {
  const locales = [
    chrome.i18n && typeof chrome.i18n.getUILanguage === "function" ? chrome.i18n.getUILanguage() : "",
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language || ""
  ];
  return locales.some(isRussianContentLocale) ? "ru" : "en";
}


/**
 * Checks whether a locale value should use Russian content-script messages.
 * @param {*} locale Input used by this step.
 * @returns {*} Result used by the caller.
 */
function isRussianContentLocale(locale) {
  const language = String(locale || "").trim().toLowerCase().split(/[-_]/)[0];
  return ["ru", "be", "uk", "kk", "ky", "uz", "tg", "az", "hy", "ka", "mo"].includes(language);
}


/**
 * Returns a localized content-script message with parameter replacement.
 * @param {*} key Input used by this step.
 * @param {*} params Input used by this step.
 * @returns {*} Result used by the caller.
 */
function contentT(key, params = {}) {
  let value = String(key || "").split(".").reduce((current, part) => {
    return current && Object.prototype.hasOwnProperty.call(current, part) ? current[part] : undefined;
  }, contentMessages);
  if (typeof value !== "string") value = contentFallbackMessage(key);
  for (const [name, replacement] of Object.entries(params)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}


/**
 * Provides fallback content-script messages when locale loading fails.
 * @param {*} key Input used by this step.
 * @returns {*} Result used by the caller.
 */
function contentFallbackMessage(key) {
  const fallback = {
    "overlay.selectPlayer": "Video Course Capture: choose the player area for recording. Esc - cancel.",
    "overlay.cancelSelection": "Cancel selection",
    "overlay.recordingLocked": "Video Course Capture: recording is active. Scrolling is locked.",
    "overlay.stopRecording": "Stop recording",
    "overlay.stop": "Stop",
    "overlay.countdown": "Video Course Capture: press Play. Recording starts in {seconds} sec."
  };
  return fallback[key] || key;
}


/**
 * Collects media URLs, embeds, page title, and resources visible in the page DOM.
 * @returns {*} Result used by the caller.
 */
function scanPage() {
  const videos = queryAllDeep(["video", "audio"]);
  for (const video of videos) {
    reportVideo(video);
  }
  const embedCount = reportEmbeds(true);
  const resourceCount = reportPageResources();
  return {
    videos: videos.length,
    embeds: embedCount,
    resources: resourceCount
  };
}


/**
 * Returns the best human-readable page title for filename hints.
 * @returns {*} Result used by the caller.
 */
function getPageContextTitle() {
  const matitaTitle = getMatitaSchoolTitle();
  return matitaTitle || cleanPageTitle(document.title);
}


/**
 * Extracts a course title from Matita School pages when available.
 * @returns {*} Result used by the caller.
 */
function getMatitaSchoolTitle() {
  if (!/(^|\.)matita-school\.ru$/i.test(location.hostname)) return "";
  const selectors = [
    '[data-param="items/parts/header1/inner/text"]',
    ".part-header .f-header",
    ".f-header"
  ];
  for (const element of queryAllDeep(selectors)) {
    const text = cleanPageTitle(element.textContent);
    if (text && !looksLikeUrlTitle(text)) return text;
  }
  return "";
}


/**
 * Normalizes document title text into a useful media hint.
 * @param {*} value Input used by this step.
 * @returns {*} Result used by the caller.
 */
function cleanPageTitle(value) {
  return String(value || "")
    .replace(/\s*[-–—|]\s*(Google Chrome|Chrome|Mozilla Firefox|Firefox)$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}


/**
 * Rejects title strings that are really URLs or paths.
 * @param {*} value Input used by this step.
 * @returns {*} Result used by the caller.
 */
function looksLikeUrlTitle(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text)
    || /^[\w.-]+\.[a-z]{2,}([/_-]|$)/i.test(text)
    || /[?&](jwt|sign|token|expires|username|view|id)=/i.test(text);
}


/**
 * Finds the best player rectangle for recording selection.
 * @returns {*} Result used by the caller.
 */
async function findBestPlayerRect() {
  const candidates = await getPlayerCropCandidates();
  return cropResponse(candidates[0]);
}


/**
 * Combines local and iframe crop candidates for area selection.
 * @returns {*} Result used by the caller.
 */
async function getPlayerCropCandidates() {
  const localCandidates = getLocalPlayerCropCandidates();
  if (window.top !== window) return localCandidates;

  const frameCandidates = await getFramePlayerCropCandidates();
  const merged = [...frameCandidates, ...localCandidates];
  return chooseBestCropCandidates(merged);
}


/**
 * Finds recordable player candidates in the current frame.
 * @returns {*} Result used by the caller.
 */
function getLocalPlayerCropCandidates() {
  const candidates = [];
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
  const elements = queryAllDeep(selectors);
  for (const element of elements) {
    const item = describeCropElement(element, false);
    if (item) candidates.push(item);
  }
  candidates.sort((a, b) => b.score - a.score);
  return chooseBestCropCandidates(candidates);
}


/**
 * Ranks crop candidates by size, visibility, and confidence.
 * @param {*} candidates Input used by this step.
 * @returns {*} Result used by the caller.
 */
function chooseBestCropCandidates(candidates) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const innerMedia = sorted.filter(candidate => ["video", "video-container", "video-wrapper"].includes(candidate.tag));
  if (innerMedia.length) return innerMedia;
  const playerShell = sorted.filter(candidate => candidate.tag === "vk-video-player");
  if (playerShell.length) return playerShell;
  const frames = sorted.filter(candidate => candidate.tag === "iframe");
  return frames.length ? frames : sorted;
}


/**
 * Asks child frames to report their best crop candidates.
 * @returns {*} Result used by the caller.
 */
async function getFramePlayerCropCandidates() {
  const candidates = [];
  for (const iframe of document.querySelectorAll("iframe")) {
    const outer = describeCropElement(iframe, false);
    if (!outer || !iframe.contentWindow) continue;
    const requestId = `crop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const responses = await new Promise(resolve => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", listener);
        resolve([]);
      }, 150);
      const listener = event => {
        const data = event.data;
        if (event.source !== iframe.contentWindow) return;
        if (!data || data.source !== "course-capture-frame-crop-response" || data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        resolve(Array.isArray(data.candidates) ? data.candidates : []);
      };
      window.addEventListener("message", listener);
      iframe.contentWindow.postMessage({ source: "course-capture-frame-crop-request", requestId }, "*");
    });
    for (const inner of responses) {
      if (!inner.rect) continue;
      candidates.push({
        score: (inner.score || 0) + 1200000,
        tag: inner.tag || "frame-video",
        rect: {
          x: outer.rect.x + inner.rect.x,
          y: outer.rect.y + inner.rect.y,
          pageX: outer.rect.pageX + inner.rect.x,
          pageY: outer.rect.pageY + inner.rect.y,
          width: inner.rect.width,
          height: inner.rect.height
        },
        selector: `${outer.selector} > ${inner.selector || "frame-media"}`,
        label: `${outer.label} / ${inner.label || "inside iframe"}`
      });
    }
  }
  return candidates;
}


/**
 * Builds a serializable response object for a crop candidate.
 * @param {*} item Input used by this step.
 * @returns {*} Result used by the caller.
 */
function cropResponse(item) {
  if (!item) return null;
  return {
    rect: item.rect,
    label: item.label,
    selector: item.selector,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    }
  };
}


/**
 * Shows the overlay that lets the user confirm which player area to record.
 * @returns {*} Result used by the caller.
 */
async function selectPlayerRect() {
  await ensureContentMessages();
  lastSelectedCropFallback = null;
  const candidates = await getPlayerCropCandidates();
  if (!candidates.length) return Promise.resolve(null);

  return new Promise(resolve => {
    const overlay = document.createElement("div");
    const hint = document.createElement("div");
    overlay.style.cssText = [
      "position:absolute",
      "left:0",
      "top:0",
      `width:${Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)}px`,
      `height:${Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)}px`,
      "z-index:2147483647",
      "pointer-events:auto",
      "background:rgba(0,0,0,0.18)"
    ].join(";");
    hint.textContent = contentT("overlay.selectPlayer");
    hint.style.cssText = [
      "position:fixed",
      "left:16px",
      "top:16px",
      "z-index:2147483647",
      "padding:10px 12px",
      "border-radius:6px",
      "background:#111827",
      "color:white",
      "font:14px/1.3 Arial,sans-serif",
      "box-shadow:0 8px 24px rgba(0,0,0,.25)"
    ].join(";");
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "×";
    cancelButton.title = contentT("overlay.cancelSelection");
    cancelButton.style.cssText = [
      "position:fixed",
      "right:16px",
      "top:16px",
      "z-index:2147483647",
      "width:34px",
      "height:34px",
      "border:0",
      "border-radius:50%",
      "background:#991b1b",
      "color:white",
      "font:bold 22px/34px Arial,sans-serif",
      "cursor:pointer",
      "pointer-events:auto",
      "box-shadow:0 8px 24px rgba(0,0,0,.25)"
    ].join(";");
    overlay.appendChild(hint);
    overlay.appendChild(cancelButton);

    const cleanup = crop => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.style.display = "none";
      overlay.remove();
      setTimeout(() => resolve(crop), 500);
    };
    const onKeyDown = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cleanup({ cancelled: true });
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    cancelButton.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      cleanup({ cancelled: true });
    }, true);

    let firstCandidateBox = null;
    candidates.forEach((candidate, index) => {
      const box = document.createElement("div");
      box.textContent = `${index + 1}. ${candidate.label || candidate.selector}`;
      box.style.cssText = [
        "position:absolute",
        `left:${candidate.rect.pageX}px`,
        `top:${candidate.rect.pageY}px`,
        `width:${candidate.rect.width}px`,
        `height:${candidate.rect.height}px`,
        "z-index:2147483647",
        "pointer-events:none",
        "border:3px solid #22c55e",
        "background:rgba(34,197,94,0.08)",
        "color:white",
        "font:bold 14px Arial,sans-serif",
        "text-align:left",
        "padding:8px",
        "cursor:pointer",
        "box-shadow:inset 0 0 0 1px rgba(255,255,255,.85),0 8px 24px rgba(0,0,0,.28)"
      ].join(";");
      overlay.appendChild(box);
      if (!firstCandidateBox) firstCandidateBox = box;
    });

    overlay.addEventListener("click", event => {
      const candidate = findCandidateAtPoint(candidates, event.clientX, event.clientY);
      if (!candidate) return;
      event.preventDefault();
      event.stopPropagation();
      lastSelectedCropFallback = withCurrentViewportRect(candidate);
      cleanup(cropResponse(lastSelectedCropFallback));
    }, true);

    document.documentElement.appendChild(overlay);
    if (firstCandidateBox) firstCandidateBox.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  });
}


/**
 * Finds which crop candidate contains a click point.
 * @param {*} candidates Input used by this step.
 * @param {*} x Input used by this step.
 * @param {*} y Input used by this step.
 * @returns {*} Result used by the caller.
 */
function findCandidateAtPoint(candidates, x, y) {
  return candidates
    .map(withCurrentViewportRect)
    .filter(candidate => {
      const rect = candidate.rect;
      return (
        x >= rect.x &&
        y >= rect.y &&
        x <= rect.x + rect.width &&
        y <= rect.y + rect.height
      );
    })
    .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0] || null;
}


/**
 * Refreshes a candidate rectangle against the current viewport.
 * @param {*} candidate Input used by this step.
 * @returns {*} Result used by the caller.
 */
function withCurrentViewportRect(candidate) {
  const pageX = Number(candidate.rect.pageX);
  const pageY = Number(candidate.rect.pageY);
  const hasPageCoords = Number.isFinite(pageX) && Number.isFinite(pageY);
  return {
    ...candidate,
    rect: {
      ...candidate.rect,
      x: hasPageCoords ? pageX - window.scrollX : candidate.rect.x,
      y: hasPageCoords ? pageY - window.scrollY : candidate.rect.y
    }
  };
}


/**
 * Converts a DOM element into a recordable crop candidate.
 * @param {*} element Input used by this step.
 * @param {*} clipToViewport Input used by this step.
 * @returns {*} Result used by the caller.
 */
function describeCropElement(element, clipToViewport = true) {
  const rect = element.getBoundingClientRect();
  const visible = clipToViewport ? clipRectToViewport(rect) : rectToPageRect(rect);
  if (!visible || visible.width < 160 || visible.height < 90) return null;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;

  const rawTag = element.tagName.toLowerCase();
  const tag = cropElementKind(element, rawTag);
  const src = rawTag === "iframe" ? element.src || "" : "";
  const idClass = `${element.id || ""} ${element.className || ""}`;
  const area = visible.width * visible.height;
  let score = area;
  if (tag === "video") score += 2200000;
  if (tag === "video-container") score += 2000000;
  if (tag === "video-wrapper") score += 1800000;
  if (tag === "vk-video-player") score += 1200000;
  if (tag === "iframe") score += 500000;
  if (src && EMBED_PLAYER_PATTERNS.some(pattern => pattern.test(src))) score += 900000;
  if (/player|video|broadcast|embed/i.test(idClass)) score += 250000;
  if (visible.width >= window.innerWidth * 0.45 && visible.height >= window.innerHeight * 0.30) score += 300000;

  return {
    score,
    element,
    tag,
    rect: visible,
    selector: shortElementName(element),
    label: cropElementLabel(tag, src)
  };
}


/**
 * Classifies a crop element as video, iframe, player, or generic element.
 * @param {*} element Input used by this step.
 * @param {*} rawTag Input used by this step.
 * @returns {*} Result used by the caller.
 */
function cropElementKind(element, rawTag) {
  if (rawTag === "video") return "video";
  if (matchesElement(element, "[data-testid='video-container'], .video-container")) return "video-container";
  if (matchesElement(element, ".video-wrapper")) return "video-wrapper";
  if (rawTag === "vk-video-player") return "vk-video-player";
  return rawTag;
}


/**
 * Builds a short label for a crop element.
 * @param {*} tag Input used by this step.
 * @param {*} src Input used by this step.
 * @returns {*} Result used by the caller.
 */
function cropElementLabel(tag, src) {
  if (tag === "iframe") return `iframe ${safeHost(src)}`;
  if (tag === "video") return "video";
  if (tag === "video-container") return "VK video-container";
  if (tag === "video-wrapper") return "VK video-wrapper";
  if (tag === "vk-video-player") return "VK player";
  return tag;
}


/**
 * Queries regular DOM and open shadow roots for matching elements.
 * @param {*} selectors Input used by this step.
 * @param {*} root Input used by this step.
 * @returns {*} Result used by the caller.
 */
function queryAllDeep(selectors, root = document) {
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
    if (node.querySelectorAll) {
      for (const selector of selectorList) {
        try {
          node.querySelectorAll(selector).forEach(add);
        } catch (_) {
          // Ignore unsupported selectors without breaking page scanning.
        }
      }
      node.querySelectorAll("*").forEach(element => {
        if (element.shadowRoot) walk(element.shadowRoot);
      });
    }
  };

  walk(root);
  return result;
}


/**
 * Safely checks whether an element matches a selector.
 * @param {*} element Input used by this step.
 * @param {*} selector Input used by this step.
 * @returns {*} Result used by the caller.
 */
function matchesElement(element, selector) {
  try {
    return element.matches(selector);
  } catch (_) {
    return false;
  }
}


/**
 * Clips a rectangle so it stays inside the visible viewport.
 * @param {*} rect Input used by this step.
 * @returns {*} Result used by the caller.
 */
function clipRectToViewport(rect) {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  if (!width || !height) return null;
  return {
    x: left,
    y: top,
    pageX: left + window.scrollX,
    pageY: top + window.scrollY,
    width,
    height
  };
}


/**
 * Converts a viewport rectangle to page coordinates.
 * @param {*} rect Input used by this step.
 * @returns {*} Result used by the caller.
 */
function rectToPageRect(rect) {
  const width = Math.max(0, rect.width);
  const height = Math.max(0, rect.height);
  if (!width || !height) return null;
  return {
    x: rect.left,
    y: rect.top,
    pageX: rect.left + window.scrollX,
    pageY: rect.top + window.scrollY,
    width,
    height
  };
}


/**
 * Builds a compact element name for overlay labels.
 * @param {*} element Input used by this step.
 * @returns {*} Result used by the caller.
 */
function shortElementName(element) {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const className = typeof element.className === "string"
    ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(name => `.${name}`).join("")
    : "";
  return `${tag}${id}${className}`;
}


/**
 * Extracts a hostname from a URL without throwing on invalid input.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return "";
  }
}


/**
 * Asks the content script to lock scrolling and keep the selected player fixed.
 * @returns {*} Result used by the caller.
 */
function lockRecordingView() {
  if (scrollLock) return getLockedSelectedCrop();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  scrollLock = {
    scrollX,
    scrollY,
    overscrollBehavior: document.documentElement.style.overscrollBehavior
  };
  document.documentElement.style.overscrollBehavior = "none";
  if (!scrollBlockerInstalled) {
    window.addEventListener("wheel", blockScrollEvent, { capture: true, passive: false });
    window.addEventListener("touchmove", blockScrollEvent, { capture: true, passive: false });
    window.addEventListener("keydown", blockScrollKey, true);
    scrollBlockerInstalled = true;
  }
  showRecordingBanner();
  return getLockedSelectedCrop();
}


/**
 * Asks the content script to remove recording lock UI.
 * @returns {*} Result used by the caller.
 */
function unlockRecordingView() {
  if (!scrollLock) {
    hideRecordingBanner();
    return;
  }
  const saved = scrollLock;
  scrollLock = null;
  document.documentElement.style.overscrollBehavior = saved.overscrollBehavior;
  if (scrollBlockerInstalled) {
    window.removeEventListener("wheel", blockScrollEvent, { capture: true });
    window.removeEventListener("touchmove", blockScrollEvent, { capture: true });
    window.removeEventListener("keydown", blockScrollKey, true);
    scrollBlockerInstalled = false;
  }
  window.scrollTo(saved.scrollX, saved.scrollY);
  hideRecordingBanner();
  lastSelectedCropFallback = null;
}


/**
 * Returns the selected crop rectangle while recording remains locked.
 * @returns {*} Result used by the caller.
 */
function getLockedSelectedCrop() {
  return cropResponse(lastSelectedCropFallback);
}


/**
 * Prevents scroll gestures during the pre-recording lock window.
 * @param {*} event Input used by this step.
 * @returns {*} Result used by the caller.
 */
function blockScrollEvent(event) {
  if (!scrollLock) return;
  event.preventDefault();
  event.stopPropagation();
}


/**
 * Prevents keyboard scrolling during the pre-recording lock window.
 * @param {*} event Input used by this step.
 * @returns {*} Result used by the caller.
 */
function blockScrollKey(event) {
  if (!scrollLock) return;
  if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
  }
}


/**
 * Displays the recording banner with stop control.
 * @returns {*} Result used by the caller.
 */
function showRecordingBanner() {
  hideRecordingBanner();
  recordingBanner = document.createElement("div");
  recordingBanner.style.cssText = [
    "position:fixed",
    "left:50%",
    "top:10px",
    "transform:translateX(-50%)",
    "z-index:2147483647",
    "padding:9px 12px",
    "border-radius:6px",
    "background:#111827",
    "color:white",
    "display:flex",
    "align-items:center",
    "gap:10px",
    "font:13px/1.3 Arial,sans-serif",
    "box-shadow:0 8px 24px rgba(0,0,0,.25)",
    "pointer-events:auto"
  ].join(";");
  const text = document.createElement("span");
  text.textContent = contentT("overlay.recordingLocked");
  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.textContent = contentT("overlay.stop");
  stopButton.title = contentT("overlay.stopRecording");
  stopButton.style.cssText = [
    "border:0",
    "border-radius:5px",
    "background:#991b1b",
    "color:white",
    "font:bold 12px/1 Arial,sans-serif",
    "padding:7px 10px",
    "cursor:pointer"
  ].join(";");
  stopButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    stopButton.disabled = true;
    stopButton.textContent = "...";
    chrome.runtime.sendMessage({ type: "STOP_RECORD" }).catch(() => {});
  }, true);
  recordingBanner.appendChild(text);
  recordingBanner.appendChild(stopButton);
  document.documentElement.appendChild(recordingBanner);
}


/**
 * Displays the countdown before recording starts.
 * @param {*} seconds Input used by this step.
 * @returns {*} Result used by the caller.
 */
function showRecordingCountdown(seconds) {
  const banner = document.createElement("div");
  let left = Math.max(1, Number(seconds) || 5);
  banner.textContent = contentT("overlay.countdown", { seconds: left });
  banner.style.cssText = [
    "position:fixed",
    "left:50%",
    "top:54px",
    "transform:translateX(-50%)",
    "z-index:2147483647",
    "padding:9px 12px",
    "border-radius:6px",
    "background:#14532d",
    "color:white",
    "font:13px/1.3 Arial,sans-serif",
    "box-shadow:0 8px 24px rgba(0,0,0,.25)",
    "pointer-events:none"
  ].join(";");
  document.documentElement.appendChild(banner);
  const timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(timer);
      banner.remove();
      return;
    }
    banner.textContent = contentT("overlay.countdown", { seconds: left });
  }, 1000);
}


/**
 * Removes the recording banner from the page.
 * @returns {*} Result used by the caller.
 */
function hideRecordingBanner() {
  if (recordingBanner) recordingBanner.remove();
  recordingBanner = null;
}


/**
 * Reports one video element and its source candidates to the extension.
 * @param {*} video Input used by this step.
 * @returns {*} Result used by the caller.
 */
function reportVideo(video) {
  const candidates = new Set();
  if (video.currentSrc) candidates.add(video.currentSrc);
  if (video.src) candidates.add(video.src);
  for (const source of queryAllDeep(["source[src]"], video)) {
    candidates.add(source.src);
  }
  for (const entry of performance.getEntriesByType("resource")) {
    if (!isNonMediaManifestUrl(entry.name) && (MEDIA_EXTENSIONS.test(entry.name) || /videoplayback|playlist|master/i.test(entry.name))) {
      candidates.add(entry.name);
    }
  }
  chrome.runtime.sendMessage({
    type: "VIDEO_PLAY",
    url: video.currentSrc || video.src || "",
    candidates: Array.from(candidates).filter(url => /^https?:\/\//i.test(url)),
    title: getPageContextTitle()
  }).catch(() => {});
}


/**
 * Reports iframe/embed/object player candidates to the extension.
 * @param {*} force Input used by this step.
 * @returns {*} Result used by the caller.
 */
function reportEmbeds(force = false) {
  const candidates = [];
  for (const iframe of queryAllDeep(["iframe[src]"])) {
    const src = iframe.src;
    if (!force && iframe.dataset.courseCaptureEmbedSeen === src) continue;
    if (!/^https?:\/\//i.test(src)) continue;
    if (!EMBED_PLAYER_PATTERNS.some(pattern => pattern.test(src))) continue;
    iframe.dataset.courseCaptureEmbedSeen = src;
    candidates.push(src);
  }
  if (!candidates.length) return 0;
  chrome.runtime.sendMessage({
    type: "EMBED_FOUND",
    candidates,
    title: getPageContextTitle()
  }).catch(() => {});
  return candidates.length;
}


/**
 * Reports media-looking resource URLs found in performance entries.
 * @returns {*} Result used by the caller.
 */
function reportPageResources() {
  const candidates = [];
  for (const entry of performance.getEntriesByType("resource")) {
    if (!isNonMediaManifestUrl(entry.name) && (MEDIA_EXTENSIONS.test(entry.name) || /videoplayback|playlist|master|m3u8|mpd/i.test(entry.name))) {
      candidates.push(entry.name);
    }
  }
  if (!candidates.length) return 0;
  chrome.runtime.sendMessage({
    type: "HLS_FOUND",
    candidates: Array.from(new Set(candidates)).filter(url => /^https?:\/\//i.test(url)),
    title: getPageContextTitle()
  }).catch(() => {});
  return candidates.length;
}


/**
 * Injects the page-context hook when direct DOM scanning is not enough.
 * @returns {*} Result used by the caller.
 */
function injectPageHook() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-hook.js");
  script.async = false;
  script.onload = () => script.remove();
  (document.documentElement || document.head).appendChild(script);
}
