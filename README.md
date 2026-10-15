# yesmike

Terminal video downloader. Paste a link, pick a quality, pick a folder. It works with 1800+ sites (YouTube, X, Instagram, TikTok, Facebook, adult sites, …) because the actual downloading is done by [yt-dlp](https://github.com/yt-dlp/yt-dlp); yesmike is a friendly terminal front end on top of it.

## How it works

yesmike is a single Node.js file (`yesmike.mjs`). Here is the technology behind each part:

- **yt-dlp (engine).** On first run yesmike downloads the standalone `yt-dlp.exe` into `~/.yesmike/bin`. It asks yt-dlp for the video info as JSON (`-J`), builds the quality list from the available formats, then runs the real download and reads yt-dlp's progress output (`--progress-template`) to draw the percentage, speed and ETA.
- **Terminal UI.** The interface is built with [Ink](https://github.com/vadimdemedes/ink) (React for the terminal) and [htm](https://github.com/developit/htm), so there is no build step. Text input uses `ink-text-input`.
- **Mouse support.** The app switches the terminal to the alternate screen and turns on SGR mouse reporting (`\x1b[?1000h\x1b[?1006h`). Ink has no hit testing, so yesmike keeps a copy of the last frame it printed and finds the clicked text in it.
- **Merging and mp3.** Video and audio usually come as two separate streams. [ffmpeg](https://ffmpeg.org) (bundled through `ffmpeg-static`) merges them into one mp4 and converts audio-only downloads to mp3.
- **Proxy / Tor.** The selected proxy is passed to yt-dlp with `--proxy` (`socks5h://` for Tor so DNS also goes through it). A background check tries to open the proxy port every 5 seconds to show `● proxy active` or `○ proxy not reachable`.
- **403 handling.** If a site answers HTTP 403, yesmike retries automatically: first with browser impersonation (`--impersonate chrome`), then after a yt-dlp self-update (`-U`), and finally it suggests `--browser chrome` to reuse your login cookies.
- **Folder picker.** `Tab` on the destination screen opens the native Windows folder dialog (PowerShell). The last used folder is remembered in `~/.yesmike/config.json`.
- **One-click launch.** `yesmike.bat` opens a Windows Terminal window (`wt`) with a fixed size and runs `run.cmd`, which installs the npm dependencies on first run and starts the app. Without Windows Terminal it falls back to a plain cmd window.

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org) 20+

## Install

```bash
git clone https://github.com/view004/yesmike.git
cd yesmike
npm install
```

## Run

Double-click `yesmike.bat`, or run it from a terminal:

```bash
node yesmike.mjs [url]
```

Options:

- `--proxy <url>`: start with a proxy, e.g. `socks5h://127.0.0.1:9150`
- `--browser <name>` / `-b`: use cookies from a browser (`chrome`, `firefox`, …) for login-only or blocked content
- `-h`: help

## Usage, step by step

### 1. Paste a link

![home](docs/home.png)

Paste or type a video link and press `Enter`. If a link is already in your clipboard, press `Tab` to paste it. A link pasted in one go starts right away. Click the logo at any time to go back to this screen.

### 2. Choose a proxy (optional)

![proxy](docs/proxy.png)

Press `Ctrl+P`. The proxy is **off by default** on every launch. Presets: Tor Browser (`127.0.0.1:9150`), Tor service (`127.0.0.1:9050`), Cloudflare WARP proxy mode (`127.0.0.1:40000`), or `custom…` for your own, e.g. `socks5://127.0.0.1:1080` or `http://user:pass@host:8080`. A filled dot `●` means something is listening on that port, `○` means it is not running. When a proxy is on, the home screen shows `● proxy active` (green) or `○ proxy not reachable` (red).

To use Tor: start Tor Browser, click Connect, then pick `Tor Browser` here.

### 3. Pick a quality

![quality](docs/quality.png)

yesmike shows the title, source site, duration and uploader, then a list of available qualities with estimated sizes, plus an mp3 audio option. Move with `↑↓` / `j k`, type a number, or click a row, then press `Enter`.

### 4. Choose where to save

![destination](docs/destination.png)

Type a folder or press `Tab` to open the folder dialog, then press `Enter` (or click `save`). The last folder is remembered.

### 5. Wait for the download

A progress bar shows the percentage, speed and time left. When the site does not report a total size, the percentage is estimated from the format size. After downloading, video and audio are merged (`processing…`) and the saved file path is shown.

## Keys

- `Enter`: continue
- `Tab`: paste from clipboard / browse for a folder
- `Ctrl+P`: proxy settings
- `Esc`: go back
- `Ctrl+C`: quit

## Troubleshooting

- **`proxy refused the connection`**: the selected proxy is not running. Start Tor Browser (and click Connect), or turn the proxy off with `Ctrl+P`.
- **HTTP 403**: yesmike retries with browser impersonation and a yt-dlp update automatically. If it still fails, run with `--browser chrome` or try a proxy.
- **Logo cut off at the top**: make the terminal window taller.

## Disclaimer

Download only content you have the right to download. You are responsible for how you use this tool.

## License

MIT
