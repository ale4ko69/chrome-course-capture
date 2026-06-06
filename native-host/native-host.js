// Video Course Capture
// Purpose: Windows native messaging host that runs yt-dlp/ffmpeg, writes recordings, verifies sources, handles cookies, and kills child processes on stop.
// Most to know: all browser-to-system work crosses this file, so every request is parsed, normalized, logged, and answered through the Chrome native messaging protocol.
// Developed and maintained by Alexey Kagansky
// Copyright (c) 2026 Alexey Kagansky
// Repository: https://github.com/ale4ko69/chrome-course-capture

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_YTDLP = "C:\\yt-dlp\\yt-dlp.exe";
const DEFAULT_FFMPEG_DIR = "C:\\yt-dlp\\ffmpeg\\ffmpeg-7.1-essentials_build\\bin";
const DEFAULT_DOWNLOADS = path.join(ROOT, "downloads");
const LOG_FILE = path.join(ROOT, "native-host.log");
const TMP_DIR = path.join(ROOT, "tmp");
const DEFAULT_MAX_DOWNLOAD_GB = 10;
const YOUTUBE_FORMAT_SELECTOR = "bestvideo*[height>=720][height<=1080]+bestaudio/best[height>=720][height<=1080]/bestvideo*+bestaudio/best";
const recordings = new Map();
const downloadsByTab = new Map();
const cancelledDownloads = new Set();

fs.mkdirSync(DEFAULT_DOWNLOADS, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

let input = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  input = Buffer.concat([input, chunk]);
  consumeInput();
});

process.stdin.on("end", () => process.exit(0));


/**
 * Reads length-prefixed Chrome native messaging packets from stdin and dispatches complete JSON messages.
 * @returns {*} Result used by the caller.
 */
function consumeInput() {
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (input.length < 4 + length) return;
    const raw = input.slice(4, 4 + length).toString("utf8");
    input = input.slice(4 + length);
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      writeMessage({ ok: false, error: `Invalid JSON: ${error.message}` });
      continue;
    }
    handleMessage(message).catch(error => {
      writeMessage({
        requestId: message && message.requestId,
        ok: false,
        error: error.message
      });
    });
  }
}


/**
 * Routes an incoming command to the correct handler and returns a response object for the caller.
 * @param {*} message Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function handleMessage(message) {
  if (!message || !message.command) {
    writeMessage({ requestId: message && message.requestId, ok: false, error: "Unknown command" });
    return;
  }

  if (message.command === "recording_start") {
    startRecording(message);
    return;
  }

  if (message.command === "recording_chunk") {
    writeRecordingChunk(message);
    return;
  }

  if (message.command === "recording_stop") {
    await stopRecording(message);
    return;
  }

  if (message.command === "cancel_download") {
    cancelDownload(message);
    return;
  }

  if (message.command === "verify") {
    await verifySource(message);
    return;
  }

  if (message.command !== "download") {
    writeMessage({ requestId: message.requestId, tabId: message.tabId, ok: false, error: `Unknown command: ${message.command}` });
    return;
  }

  if (!message.url || !/^https?:\/\//i.test(message.url)) {
    writeMessage({ requestId: message.requestId, ok: false, error: "No downloadable http(s) URL" });
    return;
  }
  const settings = normalizeSettings(message.settings);
  if (!fs.existsSync(settings.ytDlpPath)) {
    writeMessage({ requestId: message.requestId, ok: false, error: `yt-dlp not found: ${settings.ytDlpPath}` });
    return;
  }
  fs.mkdirSync(settings.downloadDir, { recursive: true });

  writeMessage({
    requestId: message.requestId,
    tabId: message.tabId,
    ok: true,
    event: "started",
    message: `yt-dlp started. Output folder: ${settings.downloadDir}`
  });

  if (Array.isArray(message.cookies) && message.cookies.length) {
    const first = await runYtDlp(message, { mode: "extension-cookies", final: !isYouTubeUrl(message.url), settings });
    if (!first.ok && isYouTubeUrl(message.url) && isRequestedFormatUnavailable(first.output)) {
      appendLog("RETRY YouTube without extension cookies because requested format was unavailable");
      writeMessage({
        requestId: message.requestId,
        tabId: message.tabId,
        ok: true,
        event: "progress",
        message: "YouTube did not provide the selected format with cookies; retrying without cookies."
      });
      await runYtDlp(message, { mode: "no-cookies", final: true, settings });
      return;
    }
    if (!first.ok) writeDone(message, false, first.code, first.output);
    return;
  }

  const first = await runYtDlp(message, { mode: "browser-cookies", final: false, settings });
  if (!first.ok && /Could not copy Chrome cookie database/i.test(first.output)) {
    appendLog("RETRY without --cookies-from-browser because Chrome cookie database is locked");
    writeMessage({
      requestId: message.requestId,
      tabId: message.tabId,
      ok: true,
      event: "progress",
      message: "Chrome cookies are locked; retrying without cookies."
    });
    await runYtDlp(message, { mode: "no-cookies", final: true, settings });
    return;
  }
  if (!first.ok) {
    writeDone(message, false, first.code, first.output);
  }
}


/**
 * Checks a candidate URL with yt-dlp and returns title, duration, size, and trust metadata without downloading.
 * @param {*} message Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function verifySource(message) {
  if (!message.url || !/^https?:\/\//i.test(message.url)) {
    writeMessage({ requestId: message.requestId, tabId: message.tabId, ok: false, error: "No downloadable http(s) URL" });
    return;
  }
  const settings = normalizeSettings(message.settings);
  if (!fs.existsSync(settings.ytDlpPath)) {
    writeMessage({ requestId: message.requestId, tabId: message.tabId, ok: false, error: `yt-dlp not found: ${settings.ytDlpPath}` });
    return;
  }
  const result = await runYtDlpVerify(message, settings);
  writeMessage({
    requestId: message.requestId,
    tabId: message.tabId,
    ok: result.ok,
    event: "verified",
    info: result.info,
    error: result.ok ? "" : result.error
  });
}


/**
 * Initializes a file-backed recording session before MediaRecorder chunks start arriving.
 * @param {*} message Input used by this step.
 * @returns {*} Result used by the caller.
 */
function startRecording(message) {
  const recordingId = String(message.recordingId || "");
  if (!recordingId) {
    writeMessage({ requestId: message.requestId, tabId: message.tabId, ok: false, error: "No recordingId" });
    return;
  }
  if (recordings.has(recordingId)) {
    writeMessage({ requestId: message.requestId, tabId: message.tabId, ok: false, error: "Recording already exists" });
    return;
  }
  const settings = normalizeSettings(message.settings);
  fs.mkdirSync(settings.downloadDir, { recursive: true });
  const filename = sanitizeFileName(message.filename || `course-recording-${timestamp()}.webm`);
  const filePath = path.join(settings.downloadDir, filename);
  const stream = fs.createWriteStream(filePath, { flags: "w" });
  recordings.set(recordingId, {
    stream,
    filePath,
    bytes: 0,
    nextIndex: 0,
    settings,
    headerFound: false,
    pendingHeader: Buffer.alloc(0),
    headerError: ""
  });
  appendLog(`RECORDING_START ${recordingId} ${filePath}`);
  writeMessage({
    requestId: message.requestId,
    tabId: message.tabId,
    ok: true,
    event: "recording_started",
    message: `Stream recording started: ${filePath}`
  });
}


/**
 * Appends one base64 encoded recording chunk to the active recording file.
 * @param {*} message Input used by this step.
 * @returns {*} Result used by the caller.
 */
function writeRecordingChunk(message) {
  const recording = recordings.get(String(message.recordingId || ""));
  if (!recording) {
    writeMessage({ requestId: message.requestId, tabId: message.tabId, ok: false, error: "Recording not found" });
    return;
  }
  try {
    const index = Number.isFinite(message.index) ? Number(message.index) : recording.nextIndex;
    if (index !== recording.nextIndex) {
      writeMessage({
        requestId: message.requestId,
        tabId: message.tabId,
        ok: false,
        error: `Recording chunks are out of order: expected ${recording.nextIndex}, got ${index}`
      });
      return;
    }
    let buffer = Buffer.from(String(message.data || ""), "base64");
    if (!buffer.length) {
      writeMessage({ requestId: message.requestId, tabId: message.tabId, ok: false, error: "Empty recording chunk" });
      return;
    }
    if (!recording.headerFound) {
      recording.pendingHeader = Buffer.concat([recording.pendingHeader, buffer]);
      const headerOffset = findEbmlHeader(recording.pendingHeader);
      if (headerOffset < 0) {
        if (recording.pendingHeader.length > 2 * 1024 * 1024) {
          recording.headerError = `WebM header was not found in the first ${recording.pendingHeader.length} bytes of the recording.`;
        }
        recording.nextIndex += 1;
        writeMessage({
          requestId: message.requestId,
          tabId: message.tabId,
          ok: true,
          event: "recording_chunk",
          bytes: recording.bytes
        });
        return;
      }
      if (headerOffset > 0) {
        appendLog(`RECORDING_TRIM_PREFIX ${message.recordingId} ${headerOffset}`);
      }
      buffer = recording.pendingHeader.subarray(headerOffset);
      recording.pendingHeader = Buffer.alloc(0);
      recording.headerFound = true;
    }
    recording.stream.write(buffer, error => {
      if (error) {
        writeMessage({ requestId: message.requestId, tabId: message.tabId, ok: false, error: error.message });
        return;
      }
      recording.bytes += buffer.length;
      recording.nextIndex += 1;
      writeMessage({
        requestId: message.requestId,
        tabId: message.tabId,
        ok: true,
        event: "recording_chunk",
        bytes: recording.bytes
      });
    });
  } catch (error) {
    writeMessage({ requestId: message.requestId, tabId: message.tabId, ok: false, error: error.message });
  }
}


/**
 * Finds the WebM EBML header inside a chunk so corrupted leading bytes can be skipped.
 * @param {*} buffer Input used by this step.
 * @returns {*} Result used by the caller.
 */
function findEbmlHeader(buffer) {
  const signature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  return buffer.indexOf(signature);
}


/**
 * Stops and removes an active recording session after an error or cancellation.
 * @param {*} recordingId Input used by this step.
 * @param {*} recording Input used by this step.
 * @returns {*} Result used by the caller.
 */
function abortRecording(recordingId, recording) {
  recordings.delete(recordingId);
  recording.stream.destroy();
  fs.unlink(recording.filePath, () => {});
  appendLog(`RECORDING_ABORT ${recordingId} ${recording.filePath}`);
}


/**
 * Completes the current recording, remuxes it when possible, and reports the saved file.
 * @param {*} message Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function stopRecording(message) {
  const recordingId = String(message.recordingId || "");
  const recording = recordings.get(recordingId);
  if (!recording) {
    writeMessage({ requestId: message.requestId, tabId: message.tabId, ok: false, error: "Recording not found" });
    return;
  }
  recordings.delete(recordingId);
  if (!recording.headerFound) {
    recording.stream.destroy();
    fs.unlink(recording.filePath, () => {});
    const firstBytes = recording.pendingHeader.subarray(0, 16).toString("hex");
    appendLog(`RECORDING_NO_HEADER ${recordingId} ${firstBytes} ${recording.filePath}`);
    writeMessage({
      requestId: message.requestId,
      tabId: message.tabId,
      ok: false,
      error: recording.headerError || `Recording does not contain a WebM header (${firstBytes}). The file was not saved to avoid leaving a broken webm.`
    });
    return;
  }
  await new Promise(resolve => recording.stream.end(resolve));
  try {
    const finalPath = await remuxRecording(recording);
    appendLog(`RECORDING_DONE ${recordingId} ${recording.bytes} ${recording.filePath}`);
    writeMessage({
      requestId: message.requestId,
      tabId: message.tabId,
      ok: true,
      event: "recording_done",
      message: `Recording saved: ${finalPath}`
    });
  } catch (error) {
    appendLog(`RECORDING_REMUX_ERROR ${recordingId} ${error.message}`);
    writeMessage({
      requestId: message.requestId,
      tabId: message.tabId,
      ok: true,
      event: "recording_done",
      message: `Recording saved without seek fix: ${recording.filePath}. ffmpeg: ${error.message}`
    });
  }
}


/**
 * Runs ffmpeg to rebuild the recorded WebM file into a cleaner final media file.
 * @param {*} recording Input used by this step.
 * @returns {*} Result used by the caller.
 */
function remuxRecording(recording) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = path.join(recording.settings.ffmpegDir, "ffmpeg.exe");
    if (!fs.existsSync(ffmpegPath)) {
      reject(new Error(`ffmpeg not found: ${ffmpegPath}`));
      return;
    }

    const tempPath = `${recording.filePath}.remuxing.webm`;
    const rawPath = `${recording.filePath}.raw.webm`;
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", recording.filePath,
      "-map", "0",
      "-c", "copy",
      tempPath
    ];
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", async code => {
      if (code !== 0) {
        fs.unlink(tempPath, () => {});
        reject(new Error(output.trim() || `ffmpeg exited with code ${code}`));
        return;
      }
      try {
        await fs.promises.rename(recording.filePath, rawPath);
        await fs.promises.rename(tempPath, recording.filePath);
        fs.unlink(rawPath, () => {});
        appendLog(`RECORDING_REMUX_OK ${recording.filePath}`);
        resolve(recording.filePath);
      } catch (error) {
        try {
          if (!fs.existsSync(recording.filePath) && fs.existsSync(rawPath)) {
            await fs.promises.rename(rawPath, recording.filePath);
          }
        } catch (_) {
          // Keep the original error; the restore attempt is best effort.
        }
        fs.unlink(tempPath, () => {});
        reject(error);
      }
    });
  });
}


/**
 * Builds yt-dlp download arguments for the selected candidate and current settings.
 * @param {*} message Input used by this step.
 * @param {*} cookieFile Input used by this step.
 * @param {*} outputBaseName Input used by this step.
 * @param {*} settings Input used by this step.
 * @returns {*} Result used by the caller.
 */
function buildArgs(message, cookieFile, outputBaseName, settings) {
  const outputTemplate = path.join(settings.downloadDir, `${outputBaseName}.%(ext)s`);
  const args = [
    "--ignore-config"
  ];

  if (cookieFile) {
    args.push("--cookies", cookieFile);
  } else if (!Array.isArray(message.cookies) || !message.cookies.length) {
    args.push("--cookies-from-browser", "chrome");
  }

  args.push(
    "--ffmpeg-location", settings.ffmpegDir,
    "--merge-output-format", settings.mergeFormat,
    "--restrict-filenames",
    "--no-playlist",
    "--max-filesize", settings.maxDownloadLabel,
    "--fragment-retries", String(settings.fragmentRetries),
    "--socket-timeout", String(settings.socketTimeout),
    "--newline",
    "-o", outputTemplate
  );

  if (message.pageUrl) {
    args.push("--referer", message.pageUrl);
  }

  if (isYouTubeUrl(message.url)) {
    args.push("--format", YOUTUBE_FORMAT_SELECTOR);
  }

  args.push(message.url);
  return args;
}


/**
 * Builds yt-dlp metadata-only verification arguments for the selected candidate.
 * @param {*} message Input used by this step.
 * @param {*} cookieFile Input used by this step.
 * @param {*} settings Input used by this step.
 * @returns {*} Result used by the caller.
 */
function buildVerifyArgs(message, cookieFile, settings) {
  const args = [
    "--ignore-config",
    "--ffmpeg-location", settings.ffmpegDir,
    "--dump-json",
    "--skip-download",
    "--no-playlist",
    "--socket-timeout", String(settings.socketTimeout),
    "--no-warnings"
  ];

  if (cookieFile) {
    args.push("--cookies", cookieFile);
  } else if (!Array.isArray(message.cookies) || !message.cookies.length) {
    args.push("--cookies-from-browser", "chrome");
  }

  if (message.pageUrl) {
    args.push("--referer", message.pageUrl);
  }

  if (isYouTubeUrl(message.url)) {
    args.push("--format", YOUTUBE_FORMAT_SELECTOR);
  }

  args.push(message.url);
  return args;
}


/**
 * Detects whether a URL belongs to YouTube so playlist-safe options can be applied.
 * @param {*} url Input used by this step.
 * @returns {*} Result used by the caller.
 */
function isYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    return host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}


/**
 * Builds a stable output filename base from verified metadata or candidate labels.
 * @param {*} message Input used by this step.
 * @returns {*} Result used by the caller.
 */
function buildOutputBaseName(message) {
  const title = sanitizeFileName(cleanTitleForFileName(message.title || message.pageUrl || "course-video"))
    .replace(/\.(mp4|webm|mkv|mov|m4v)$/i, "")
    .slice(0, 90) || "course-video";
  const hint = sanitizeFileName(message.filenameHint || "")
    .replace(/\.(mp4|webm|mkv|mov|m4v)$/i, "")
    .slice(0, 40);
  const suffix = String(message.requestId || Date.now())
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(-6);
  return [title, hint, suffix || timestamp()].filter(Boolean).join("-");
}


/**
 * Normalizes a media title into a filesystem-safe filename fragment.
 * @param {*} value Input used by this step.
 * @returns {*} Result used by the caller.
 */
function cleanTitleForFileName(value) {
  let text = String(value || "").trim();
  if (!text) return "course-video";
  text = text.replace(/\s*[-–—|]\s*(Google Chrome|Chrome|Mozilla Firefox|Firefox)$/i, "").trim();
  try {
    const parsed = parseTitleUrl(text);
    if (parsed) {
      const cleanParts = parsed.pathname
        .split("/")
        .filter(Boolean)
        .filter(part => !/^(pl|webinar|show|lesson|course|view|index)$/i.test(part))
        .slice(-2);
      text = cleanParts.join("-") || parsed.hostname.replace(/^www\./i, "").replace(/\.[a-z]{2,}$/i, "") || "course-video";
    }
  } catch {
    text = text
      .replace(/^https?:\/\/[^/?#]+/i, "")
      .replace(/[?#].*$/, "")
      .trim() || text;
  }
  text = text
    .replace(/[?#].*$/, "")
    .replace(/\b(jwt|sign|token|expires|username|view|id)=[^_\s&-]+/gi, "")
    .replace(/[_-]{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .trim();
  return text || "course-video";
}


/**
 * Extracts a title-like URL value from yt-dlp or ffmpeg output text.
 * @param {*} text Input used by this step.
 * @returns {*} Result used by the caller.
 */
function parseTitleUrl(text) {
  const value = String(text || "").trim();
  if (/^https?:\/\//i.test(value)) return new URL(value);
  if (/^[\w.-]+\.[a-z]{2,}([/_-]|$)/i.test(value)) {
    const normalized = value.replace(/_/g, "/");
    return new URL(`https://${normalized}`);
  }
  return null;
}


/**
 * Starts yt-dlp for a real download and wires progress, size guard, cancellation, and completion handling.
 * @param {*} message Input used by this step.
 * @param {*} options Input used by this step.
 * @returns {*} Result used by the caller.
 */
function runYtDlp(message, options) {
  return new Promise(resolve => {
    const settings = options.settings || normalizeSettings(message.settings);
    const cookieFile = options.mode === "extension-cookies" ? writeCookiesFile(message) : "";
    const outputBaseName = buildOutputBaseName(message);
    const args = buildArgs(
      options.mode === "no-cookies" ? { ...message, cookies: [] } : message,
      cookieFile,
      outputBaseName,
      settings
    );
    if (options.mode === "no-cookies") {
      const cookieIndex = args.indexOf("--cookies-from-browser");
      if (cookieIndex >= 0) args.splice(cookieIndex, 2);
    }
    const label = options.mode;
    let output = "";
    let killedBySizeGuard = false;
    appendLog(`START ${new Date().toISOString()} ${message.reason || "manual"} ${label} ${message.url}`);
    appendLog(`CMD ${settings.ytDlpPath} ${args.map(quoteArg).join(" ")}`);

    const child = spawn(settings.ytDlpPath, args, {
      cwd: settings.downloadDir,
      windowsHide: true
    });
    downloadsByTab.set(String(message.tabId), child);
    const sizeGuard = startDownloadSizeGuard(child, message, outputBaseName, settings, () => {
      killedBySizeGuard = true;
    });

    child.stdout.on("data", data => {
      output += data.toString("utf8");
      reportProgress(message.requestId, message.tabId, data);
    });
    child.stderr.on("data", data => {
      output += data.toString("utf8");
      reportProgress(message.requestId, message.tabId, data);
    });

    child.on("error", error => {
      appendLog(`ERROR ${error.message}`);
      clearInterval(sizeGuard);
      if (downloadsByTab.get(String(message.tabId)) === child) {
        downloadsByTab.delete(String(message.tabId));
      }
      if (options.final) {
        writeMessage({ requestId: message.requestId, tabId: message.tabId, ok: false, event: "done", error: error.message });
      }
      cleanupCookieFile(cookieFile);
      resolve({ ok: false, code: -1, output: `${output}\n${error.message}` });
    });

    child.on("close", code => {
      clearInterval(sizeGuard);
      const key = String(message.tabId);
      const wasCancelled = cancelledDownloads.has(key);
      if (wasCancelled) cancelledDownloads.delete(key);
      const ok = wasCancelled || (code === 0 && !killedBySizeGuard);
      if (downloadsByTab.get(key) === child) {
        downloadsByTab.delete(key);
      }
      appendLog(`DONE ${label} code=${code}`);
      if (killedBySizeGuard) {
        const error = `Download stopped: size exceeded the safety limit of ${settings.maxDownloadGb}GB. The playlist looks endless or misleading.`;
        output += `\nERROR: ${error}`;
        cleanupPartialDownloads(outputBaseName, settings);
        if (options.final) {
          writeMessage({
            requestId: message.requestId,
            tabId: message.tabId,
            ok: false,
            event: "done",
            message: error,
            error
          });
        }
      } else if (wasCancelled) {
        writeMessage({
          requestId: message.requestId,
          tabId: message.tabId,
          ok: true,
          event: "cancelled",
          message: "Download cancelled by the user."
        });
      } else if (ok || options.final) {
        writeDone(message, ok, code, output);
      }
      cleanupCookieFile(cookieFile);
      resolve({ ok, code, output, cancelled: wasCancelled });
    });
  });
}


/**
 * Runs verification with a fallback strategy when a site rejects the preferred format selector.
 * @param {*} message Input used by this step.
 * @param {*} settings Input used by this step.
 * @returns {*} Result used by the caller.
 */
async function runYtDlpVerify(message, settings) {
  const first = await runYtDlpVerifyOnce(message, settings, "extension-cookies");
  if (!first.ok && isYouTubeUrl(message.url) && isRequestedFormatUnavailable(first.error || "")) {
    appendLog("VERIFY_RETRY YouTube without extension cookies because requested format was unavailable");
    writeMessage({
      requestId: message.requestId,
      tabId: message.tabId,
      ok: true,
      event: "verify_retry",
      message: "Second verification attempt..."
    });
    return runYtDlpVerifyOnce({ ...message, cookies: [], pageUrl: "" }, settings, "no-cookies");
  }
  return first;
}


/**
 * Runs a single yt-dlp verification attempt for one verification mode.
 * @param {*} message Input used by this step.
 * @param {*} settings Input used by this step.
 * @param {*} mode Input used by this step.
 * @returns {*} Result used by the caller.
 */
function runYtDlpVerifyOnce(message, settings, mode) {
  return new Promise(resolve => {
    const cookieFile = Array.isArray(message.cookies) && message.cookies.length ? writeCookiesFile(message) : "";
    const args = buildVerifyArgs(message, cookieFile, settings);
    if (mode === "no-cookies") {
      const cookieIndex = args.indexOf("--cookies-from-browser");
      if (cookieIndex >= 0) args.splice(cookieIndex, 2);
    }
    let output = "";
    let settled = false;
    appendLog(`VERIFY ${new Date().toISOString()} ${mode || "default"} ${message.url}`);
    appendLog(`VERIFY_CMD ${settings.ytDlpPath} ${args.map(quoteArg).join(" ")}`);

    const child = spawn(settings.ytDlpPath, args, {
      cwd: settings.downloadDir,
      windowsHide: true
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child, "verify-timeout");
      cleanupCookieFile(cookieFile);
      resolve({ ok: false, error: "yt-dlp verification took too long", info: { error: "timeout" } });
    }, 55000);

    child.stdout.on("data", data => {
      output += data.toString("utf8");
    });
    child.stderr.on("data", data => {
      output += data.toString("utf8");
    });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupCookieFile(cookieFile);
      appendLog(`VERIFY_ERROR ${error.message}`);
      resolve({ ok: false, error: error.message, info: { error: error.message } });
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupCookieFile(cookieFile);
      appendLog(`VERIFY_DONE code=${code}`);
      if (code !== 0) {
        const error = extractLastError(output) || `yt-dlp exited with code ${code}`;
        resolve({ ok: false, error, info: { error } });
        return;
      }
      const info = parseYtDlpJson(output);
      if (!info) {
        resolve({ ok: false, error: "yt-dlp did not return metadata JSON", info: { error: "no metadata json" } });
        return;
      }
      resolve({ ok: true, info });
    });
  });
}


/**
 * Detects yt-dlp format-selection failures that should trigger a fallback verification attempt.
 * @param {*} output Input used by this step.
 * @returns {*} Result used by the caller.
 */
function isRequestedFormatUnavailable(output) {
  return /Requested format is not available/i.test(String(output || ""));
}


/**
 * Watches downloaded bytes and cancels the process if it exceeds the configured limit.
 * @param {*} child Input used by this step.
 * @param {*} message Input used by this step.
 * @param {*} outputBaseName Input used by this step.
 * @param {*} settings Input used by this step.
 * @param {*} onLimit Input used by this step.
 * @returns {*} Result used by the caller.
 */
function startDownloadSizeGuard(child, message, outputBaseName, settings, onLimit) {
  return setInterval(() => {
    const bytes = getOutputBytes(outputBaseName, settings);
    if (bytes <= settings.maxDownloadBytes) return;
    appendLog(`SIZE_GUARD tab=${message.tabId} bytes=${bytes} limit=${settings.maxDownloadBytes} base=${outputBaseName}`);
    onLimit();
    try {
      killProcessTree(child, "size-guard");
    } catch (error) {
      appendLog(`SIZE_GUARD_KILL_ERROR ${error.message}`);
    }
  }, 3000);
}


/**
 * Calculates the current size of partial and final files for a download base name.
 * @param {*} outputBaseName Input used by this step.
 * @param {*} settings Input used by this step.
 * @returns {*} Result used by the caller.
 */
function getOutputBytes(outputBaseName, settings) {
  let total = 0;
  try {
    for (const file of fs.readdirSync(settings.downloadDir)) {
      if (!file.startsWith(outputBaseName)) continue;
      const fullPath = path.join(settings.downloadDir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) total += stat.size;
    }
  } catch (error) {
    appendLog(`SIZE_GUARD_STAT_ERROR ${error.message}`);
  }
  return total;
}


/**
 * Deletes unfinished partial files created by a cancelled or over-limit download.
 * @param {*} outputBaseName Input used by this step.
 * @param {*} settings Input used by this step.
 * @returns {*} Result used by the caller.
 */
function cleanupPartialDownloads(outputBaseName, settings) {
  try {
    for (const file of fs.readdirSync(settings.downloadDir)) {
      if (!file.startsWith(outputBaseName)) continue;
      if (!/\.(part|ytdl|temp|tmp)$/i.test(file) && !file.includes(".part-")) continue;
      try {
        fs.unlinkSync(path.join(settings.downloadDir, file));
        appendLog(`CLEANUP_PARTIAL ${file}`);
      } catch (error) {
        appendLog(`CLEANUP_PARTIAL_ERROR ${file} ${error.message}`);
      }
    }
  } catch (error) {
    appendLog(`CLEANUP_PARTIAL_SCAN_ERROR ${error.message}`);
  }
}


/**
 * Cancels an active yt-dlp process for the requested browser tab.
 * @param {*} message Input used by this step.
 * @returns {*} Result used by the caller.
 */
function cancelDownload(message) {
  const key = String(message.tabId);
  const child = downloadsByTab.get(key);
  if (!child) {
    writeMessage({
      requestId: message.requestId,
      tabId: message.tabId,
      ok: true,
      event: "cancel_download",
      message: "Active yt-dlp process was not found."
    });
    return;
  }

  downloadsByTab.delete(key);
  cancelledDownloads.add(key);
  appendLog(`CANCEL_DOWNLOAD tab=${key} pid=${child.pid}`);
  try {
    killProcessTree(child, "user-cancel");
    writeMessage({
      requestId: message.requestId,
      tabId: message.tabId,
      ok: true,
      event: "cancel_download",
      message: "yt-dlp download stopped."
    });
  } catch (error) {
    writeMessage({
      requestId: message.requestId,
      tabId: message.tabId,
      ok: false,
      event: "cancel_download",
      error: error.message
    });
  }
}


/**
 * Terminates a process and its children so ffmpeg does not continue after stop.
 * @param {*} child Input used by this step.
 * @param {*} reason Input used by this step.
 * @returns {*} Result used by the caller.
 */
function killProcessTree(child, reason) {
  if (!child || !child.pid) return;
  appendLog(`KILL_TREE reason=${reason} pid=${child.pid}`);
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("error", error => appendLog(`TASKKILL_ERROR pid=${child.pid} ${error.message}`));
    } catch (error) {
      appendLog(`TASKKILL_SPAWN_ERROR pid=${child.pid} ${error.message}`);
    }
    return;
  }
  try {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2000);
  } catch (error) {
    appendLog(`KILL_TREE_ERROR pid=${child.pid} ${error.message}`);
  }
}


/**
 * Sends the final native-host result back to the extension and writes the outcome to the log.
 * @param {*} message Input used by this step.
 * @param {*} ok Input used by this step.
 * @param {*} code Input used by this step.
 * @param {*} output Input used by this step.
 * @returns {*} Result used by the caller.
 */
function writeDone(message, ok, code, output) {
  const settings = normalizeSettings(message.settings);
  const lastError = extractLastError(output);
  writeMessage({
    requestId: message.requestId,
    tabId: message.tabId,
    ok,
    event: "done",
    message: ok ? `yt-dlp finished. Files are in ${settings.downloadDir}` : `yt-dlp exited with code ${code}`,
    error: ok ? "" : (lastError || `yt-dlp exited with code ${code}`)
  });
}


/**
 * Pulls the most useful error line from tool output for the popup message.
 * @param {*} output Input used by this step.
 * @returns {*} Result used by the caller.
 */
function extractLastError(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .reverse()
    .find(line => /^ERROR:/i.test(line));
}


/**
 * Parses yt-dlp JSON output while tolerating surrounding log lines.
 * @param {*} output Input used by this step.
 * @returns {*} Result used by the caller.
 */
function parseYtDlpJson(output) {
  const lines = String(output || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Try next line.
    }
  }
  return null;
}


/**
 * Merges and validates settings received from the extension before using them on disk or in commands.
 * @param {*} raw Input used by this step.
 * @returns {*} Result used by the caller.
 */
function normalizeSettings(raw) {
  const settings = raw && typeof raw === "object" ? raw : {};
  const maxDownloadGb = clampNumber(settings.maxDownloadGb, 1, 200, DEFAULT_MAX_DOWNLOAD_GB);
  return {
    ytDlpPath: normalizePath(settings.ytDlpPath, DEFAULT_YTDLP),
    ffmpegDir: normalizePath(settings.ffmpegDir, DEFAULT_FFMPEG_DIR),
    downloadDir: normalizePath(settings.downloadDir, DEFAULT_DOWNLOADS),
    mergeFormat: ["mp4", "mkv", "webm"].includes(settings.mergeFormat) ? settings.mergeFormat : "mp4",
    maxDownloadGb,
    maxDownloadBytes: maxDownloadGb * 1024 * 1024 * 1024,
    maxDownloadLabel: `${maxDownloadGb}G`,
    fragmentRetries: clampNumber(settings.fragmentRetries, 0, 50, 10),
    socketTimeout: clampNumber(settings.socketTimeout, 5, 300, 20)
  };
}


/**
 * Converts empty or relative settings paths into safe native-host filesystem paths.
 * @param {*} value Input used by this step.
 * @param {*} fallback Input used by this step.
 * @returns {*} Result used by the caller.
 */
function normalizePath(value, fallback) {
  const text = String(value || "").trim();
  return text ? path.resolve(text) : fallback;
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


/**
 * Writes temporary Netscape cookies so yt-dlp can use the current browser session.
 * @param {*} message Input used by this step.
 * @returns {*} Result used by the caller.
 */
function writeCookiesFile(message) {
  const file = path.join(TMP_DIR, `cookies-${message.requestId || Date.now()}.txt`);
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Generated by Video Course Capture extension"
  ];
  for (const cookie of message.cookies || []) {
    const domain = cookie.domain || "";
    const includeSubdomains = cookie.hostOnly ? "FALSE" : "TRUE";
    const pathValue = cookie.path || "/";
    const secure = cookie.secure ? "TRUE" : "FALSE";
    const expires = Math.floor(cookie.expirationDate || 0);
    const name = cookie.name || "";
    const value = cookie.value || "";
    lines.push([domain, includeSubdomains, pathValue, secure, expires, name, value].join("\t"));
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  appendLog(`COOKIE_FILE ${file} cookies=${(message.cookies || []).length}`);
  return file;
}


/**
 * Removes a temporary cookies file after yt-dlp no longer needs it.
 * @param {*} file Input used by this step.
 * @returns {*} Result used by the caller.
 */
function cleanupCookieFile(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // Best-effort cleanup.
  }
}


/**
 * Sends a progress event through the native messaging channel.
 * @param {*} requestId Input used by this step.
 * @param {*} tabId Input used by this step.
 * @param {*} data Input used by this step.
 * @returns {*} Result used by the caller.
 */
function reportProgress(requestId, tabId, data) {
  const text = data.toString("utf8").trim();
  if (!text) return;
  appendLog(text);
  const lines = text.split(/\r?\n/).slice(-3).join(" ");
  writeMessage({
    requestId,
    tabId,
    ok: true,
    event: "progress",
    message: lines.slice(0, 500),
    progress: parseYtDlpProgress(lines)
  });
}


/**
 * Extracts percent, size, speed, and ETA fields from yt-dlp progress text.
 * @param {*} text Input used by this step.
 * @returns {*} Result used by the caller.
 */
function parseYtDlpProgress(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return null;

  const percentMatch = value.match(/\[download\]\s+([0-9]+(?:\.[0-9]+)?)%\s+of\s+(?:~\s*)?([^\s]+)(?:\s+at\s+([^\s]+\/s))?(?:\s+ETA\s+([0-9:]+))?/i);
  if (percentMatch) {
    return {
      percent: Number(percentMatch[1]),
      total: percentMatch[2] || "",
      speed: percentMatch[3] || "",
      eta: percentMatch[4] || ""
    };
  }

  const fragmentMatch = value.match(/\[download\]\s+fragment\s+([0-9]+)\s+of\s+([0-9?]+)/i);
  if (fragmentMatch) {
    return {
      fragment: Number(fragmentMatch[1]),
      fragmentsTotal: fragmentMatch[2] === "?" ? "" : Number(fragmentMatch[2])
    };
  }

  const downloadedMatch = value.match(/\[download\]\s+([^\s]+)\s+has already been downloaded/i);
  if (downloadedMatch) {
    return { downloaded: downloadedMatch[1] || "" };
  }

  return null;
}


/**
 * Writes one length-prefixed JSON packet to stdout for Chrome native messaging.
 * @param {*} message Input used by this step.
 * @returns {*} Result used by the caller.
 */
function writeMessage(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}


/**
 * Appends one diagnostic line to native-host.log.
 * @param {*} line Input used by this step.
 * @returns {*} Result used by the caller.
 */
function appendLog(line) {
  fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
}


/**
 * Quotes a command argument for human-readable logging.
 * @param {*} value Input used by this step.
 * @returns {*} Result used by the caller.
 */
function quoteArg(value) {
  return /[\s"]/g.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : value;
}


/**
 * Removes characters that are unsafe in Windows filenames.
 * @param {*} value Input used by this step.
 * @returns {*} Result used by the caller.
 */
function sanitizeFileName(value) {
  return String(value || "course-recording.webm")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "course-recording.webm";
}


/**
 * Formats a timestamp for filenames and logs.
 * @returns {*} Result used by the caller.
 */
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
