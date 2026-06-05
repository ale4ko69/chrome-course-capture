(() => {
  const MARKER = "course-capture-page-hook";
  const MEDIA_URL = /https?:\/\/[^\s"'<>\\]+?(?:\.m3u8|\.mpd|\.mp4|\.m4v|\.mov|\.webm|\/api\/playlist\/(?:master|media)\/|get-(?:master|media)-playlist)[^\s"'<>\\]*/gi;
  const EXT_M3U = /#EXTM3U/i;
  const seen = new Set();

  function report(url, text) {
    const candidates = new Set();
    const body = typeof text === "string" ? text : "";
    const normalizedBody = body
      .replace(/\\\//g, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/&amp;/gi, "&");
    for (const source of [body, normalizedBody]) {
      for (const match of source.matchAll(MEDIA_URL)) {
        candidates.add(match[0]);
      }
    }
    if (EXT_M3U.test(body) && /^https?:\/\//i.test(url)) {
      candidates.add(url);
    }
    const payload = Array.from(candidates).filter(candidate => {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    });
    if (!payload.length) return;
    window.postMessage({ source: MARKER, url, candidates: payload }, "*");
  }

  if (window.fetch) {
    const originalFetch = window.fetch;
    window.fetch = async function patchedFetch(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url = response.url || String(args[0] && args[0].url || args[0] || "");
        const type = response.headers && response.headers.get("content-type") || "";
        if (/mpegurl|m3u8|json|javascript|text|octet-stream/i.test(type) || /m3u8|playlist|manifest|hls|master/i.test(url)) {
          response.clone().text().then(text => report(url, text)).catch(() => {});
        }
      } catch {
        // Keep page behavior untouched.
      }
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__courseCaptureUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener("load", () => {
      try {
        const url = this.responseURL || this.__courseCaptureUrl || "";
        const type = this.getResponseHeader("content-type") || "";
        if (this.responseType && this.responseType !== "text" && this.responseType !== "") return;
        if (/mpegurl|m3u8|json|javascript|text|octet-stream/i.test(type) || /m3u8|playlist|manifest|hls|master/i.test(url)) {
          report(url, this.responseText || "");
        }
      } catch {
        // Keep page behavior untouched.
      }
    });
    return originalSend.apply(this, args);
  };
})();
