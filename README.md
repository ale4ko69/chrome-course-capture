# Video Course Capture

Video Course Capture is a Chrome Manifest V3 extension plus a Windows native messaging host for capturing course videos for personal offline use.

It detects candidate video sources on the current page, lets the user verify the selected source with `yt-dlp`, downloads confirmed sources, and can also record a selected page player with audio when a direct download is not reliable. If a page has multiple players or iframes, Video Course Capture lets the user choose the exact player area before recording.

## What It Does

- Detects video candidates from `<video>` / `<audio>` tags, `<source>` tags, iframes, page resources, `fetch`, `XMLHttpRequest`, and Chrome `webRequest`.
- Recognizes common candidate types such as direct video files, HLS playlists, DASH manifests, embedded players, playback URLs, and stream segments.
- Shows candidate options in the popup as variants for verification, not as blindly trusted download links.
- Supports Russian and English popup UI via JSON locale files.
- Filters noisy quality variants so the combo box prefers `master` playlists and video formats at `720p` or higher.
- Uses `yt-dlp --dump-json --skip-download` to verify title, duration, extractor, and approximate size before enabling download.
- Blocks manual downloads until the selected candidate is confirmed.
- Sends Chrome cookies through the extension cookies API into a temporary Netscape cookie file for `yt-dlp`.
- Uses `ffmpeg` through `yt-dlp` for merging/remuxing downloaded media.
- Can record a selected player area or iframe with audio as a fallback using Chrome `tabCapture` and an offscreen document.
- Lets the user choose the exact player to record when a page contains multiple players or iframes.
- Stops active downloads by killing the full process tree on Windows, including child `ffmpeg` processes.

## Verified Sources

These sources have been verified in local testing. This list is intentionally small and can be expanded as more sites are tested.

| Source | Status | Notes |
| --- | --- | --- |
| YouTube watch pages | Verified | Uses only the central `watch?v=...` video, strips playlist context, verifies with `yt-dlp`, and downloads with `--no-playlist`. |
| VKVideo single-video pages | Verified for central-source detection | Uses only the current `vkvideo.ru/video...` URL and ignores recommended videos as separate candidates. |
| Generic HLS/DASH course players | Verified with confirmation | Shows master/720p+ variants when available and requires `Verify` before `Download`. |
| Player recording fallback | Verified | Lets the user select the player area, locks scrolling, waits 5 seconds, and records that player area with audio. |

When adding a new verified source, record the site/page type, what URL is selected, whether cookies are needed, and whether download and stop behavior were tested.

## License

This project is released under the MIT License. See [LICENSE](LICENSE).

## Project Layout

```text
extension/
  manifest.json       Chrome MV3 extension manifest
  background.js       tab state, candidate ranking, verification, download control
  content.js          DOM, iframe, shadow DOM, and player-area detection
  page-hook.js        fetch/XHR hook injected into the page context
  popup.html          extension popup UI
  popup.js            popup rendering and user actions
  popup.css           popup styles
  locales/            Russian and English popup translations
  offscreen.html      offscreen recording document
  offscreen.js        tab recording and chunk streaming
  icons/              extension icons

native-host/
  native-host.js      native messaging host, yt-dlp/ffmpeg process control
  native-host.cmd     Windows command wrapper for Node.js
  com.video_course_capture.native_host.json
                      Chrome native messaging manifest, rewritten by installer

install-native-host.ps1
uninstall-native-host.ps1
```

Runtime folders and files such as `downloads/`, `tmp/`, and `native-host.log` are intentionally not versioned.

## Requirements

- Windows.
- Google Chrome 116 or newer.
- Node.js installed at:

```text
C:\Program Files\nodejs\node.exe
```

- `yt-dlp.exe`, expected by default at:

```text
C:\yt-dlp\yt-dlp.exe
```

- `ffmpeg.exe`, expected by default under:

```text
C:\yt-dlp\ffmpeg\ffmpeg-7.1-essentials_build\bin
```

The paths can be edited in the extension popup settings.

## Install External Dependencies

`install-native-host.ps1` does not install Node.js, yt-dlp, or ffmpeg. It only registers the already downloaded native host with Chrome.

Install these tools separately first:

1. Install Node.js for Windows:

   - Download page: <https://nodejs.org/en/download>
   - Use the Windows installer.
   - The bundled native host launcher expects Node.js at:

   ```text
   C:\Program Files\nodejs\node.exe
   ```

   If Node.js is installed elsewhere, edit:

   ```text
   native-host\native-host.cmd
   ```

2. Download yt-dlp:

   - Latest release page: <https://github.com/yt-dlp/yt-dlp/releases/latest>
   - Download the Windows executable named `yt-dlp.exe`.
   - Put it here by default:

   ```text
   C:\yt-dlp\yt-dlp.exe
   ```

   You can update it later with:

   ```powershell
   C:\yt-dlp\yt-dlp.exe -U
   ```

3. Download ffmpeg for Windows:

   - FFmpeg download page: <https://ffmpeg.org/download.html>
   - Windows builds commonly used with yt-dlp: <https://www.gyan.dev/ffmpeg/builds/>
   - Put the extracted `bin` folder here by default:

   ```text
   C:\yt-dlp\ffmpeg\ffmpeg-7.1-essentials_build\bin
   ```

The default paths are only defaults. You can change `yt-dlp.exe`, `ffmpeg bin`, and the output folder from the extension popup settings.

## Installation

1. Install the external dependencies above.
2. Clone or download this repository.
3. Open Chrome and go to:

```text
chrome://extensions
```

4. Enable `Developer mode`.
5. Click `Load unpacked`.
6. Select the repository `extension` folder.
7. Copy the extension ID shown by Chrome.
8. Register the native host from PowerShell:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\install-native-host.ps1 -ExtensionId YOUR_EXTENSION_ID
```

The installer rewrites `native-host/com.video_course_capture.native_host.json` with:

- the absolute path to `native-host.cmd`;
- the correct `chrome-extension://.../` origin for your loaded extension;
- the registry entry under:

```text
HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.video_course_capture.native_host
```

After changing extension or native-host files, reload the extension at `chrome://extensions`.

## Usage

1. Open the course page in Chrome and log in.
2. Open the Video Course Capture popup.
3. Click `Start video capture`.
4. Start playback on the page.
5. Review the detected variants in the combo box.
6. Select a candidate and click `Verify`.
7. Confirm that the title, duration, extractor, and size look correct.
8. Click `Download` only after the source is confirmed.

The download button stays disabled until verification succeeds.

If the candidate is readable but does not have trustworthy metadata, Video Course Capture treats it as not confirmed. This is intentional: a technical HLS playlist can be playable while still being the wrong stream.

## Candidate Labels

The popup uses labels such as:

```text
1. HLS PL - video 1 - master
2. HLS PL - video 1 - HD 720p
3. HLS PL - video 2 - FullHD 1080p
4. player - video 3 - player
5. YouTube - video 4 - current video
6. HLS PL - video 3 - 480p (no 720+)
```

The list is curated:

- `master` playlists are shown because `yt-dlp` can choose the best available format.
- `720p` and higher variants are preferred.
- Lower-quality variants are shown only when no `720p+` option exists for that video group.
- Raw stream segments are hidden from the combo box when a better playlist/player option exists.
- On a YouTube watch page, Video Course Capture uses only the central video from the current tab URL. Recommended videos and playlist items are not added to the combo box.
- On a VKVideo page such as `vkvideo.ru/video-18761029_456241640`, Video Course Capture also uses only the current video URL and ignores recommended videos.
- Downloads and verification run `yt-dlp` with `--no-playlist`, so a YouTube playlist URL cannot accidentally download the whole playlist.

## Recording Fallback

If direct download is not available or not trustworthy, use `Tab recording`.

Video Course Capture can:

- detect and highlight a player area or iframe before recording;
- let you confirm the correct frame so the recording follows the video area instead of the whole page;
- lock scrolling after confirmation, show a 5-second countdown, and start recording from the same viewport position;
- keep the visible view locked while recording;
- capture a selected player area with audio;
- save a `.webm` file;
- remux the recording with `ffmpeg` when available.

The default stop-recording shortcut is:

```text
Ctrl+Shift+Y
```

Chrome shortcuts can be changed at:

```text
chrome://extensions/shortcuts
```

## Output

By default, downloaded and recorded files are saved to:

```text
downloads/
```

You can change the output directory in the popup settings.

## Diagnostics

The native host writes logs to:

```text
native-host.log
```

Useful checks:

```powershell
Get-Content .\native-host.log -Tail 80
Get-Process | Where-Object { $_.ProcessName -match 'yt-dlp|ffmpeg' }
```

Syntax checks:

```powershell
node --check extension\background.js
node --check extension\popup.js
node --check extension\content.js
node --check extension\page-hook.js
node --check native-host\native-host.js
```

## Uninstall Native Host

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\uninstall-native-host.ps1
```

This removes the Chrome native messaging registry entry.

## Limitations

- This project does not bypass DRM.
- Protected or encrypted players may block both download and recording.
- `blob:` URLs are not directly downloadable; the extension tries to locate the underlying network request.
- Verification quality depends on what `yt-dlp` can extract from the candidate URL.
- Some course pages contain ads, preview streams, or multiple players; always verify title and duration before downloading.

## Legal / Usage Note

Use this tool only for content you are allowed to access and archive. Video Course Capture is intended for personal workflow automation, not redistribution or DRM circumvention.
