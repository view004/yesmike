# yesmike

Terminal video downloader. Paste a link, pick a quality, pick a folder. Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp), so it works with 1800+ sites (YouTube, X, Instagram, TikTok, adult sites, …).

## Features

- Mouse and keyboard UI in the terminal
- Quality picker (video / mp3), folder picker (native dialog)
- Progress percentage, speed, ETA
- Proxy support: SOCKS5 / HTTP, presets for Tor Browser (9150), Tor service (9050), Cloudflare WARP (40000), live "proxy active" status
- Auto-retry on HTTP 403 (browser impersonation, yt-dlp self-update)
- yt-dlp is downloaded automatically on first run; ffmpeg is bundled

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

- Double-click `yesmike.bat` (opens a Windows Terminal window; falls back to plain cmd), or
- `node yesmike.mjs [url]`

### Options

| Flag | Meaning |
| --- | --- |
| `--proxy <url>` | e.g. `socks5h://127.0.0.1:9150` |
| `--browser <name>`, `-b` | use cookies from a browser (`chrome`, `firefox`, …) for login-only / blocked content |
| `-h` | help |

## Usage

1. Paste a link (or press `Tab` to use the one in your clipboard) and press `Enter`.
2. Choose a quality (`↑↓` / `j k` / number / click) and press `Enter`.
3. Choose the destination folder (`Tab` opens the folder dialog) and press `Enter`.
4. Wait for the progress bar to finish.

| Key | Action |
| --- | --- |
| `Ctrl+P` | proxy settings |
| `Tab` | paste from clipboard / browse folder |
| `Esc` | back |
| Click logo | back to home |

Settings are stored in `~/.yesmike/config.json`, the yt-dlp binary in `~/.yesmike/bin`.

## Screens

Hand-drawn approximations of the UI (colors omitted).

**1. Paste a link**

```
        ▓ █▀▀ █▀▀ █▄█ ▀█▀ █ █▀▀
         ▀▀█ █▀  ▀▀█ █ █  █ █ █▀▀
        ...

   ╭─ Paste a link ─────────────────────────────╮
   │ ❯ https://youtube.com/watch?v=…   ▄▄▄▄▄▄▄▄▄▄▄▄
   ╰───────────────────────────────── ▀▀▀▀▀▀▀▀▀▀▀▀

        ⇥ paste  ·  ^P proxy  ·  esc quit
```

**2. Pick a quality**

```
              Some video title
        YouTube · 12:03 · Some Uploader

        ╭────────────────────────────╮
        │ ❯ ▶ 1080p  ~210 MB         │
        │   ▶ 720p   ~120 MB         │
        │   ▶ 480p   ~70 MB          │
        │   ♪ mp3 audio  ~11 MB      │
        ╰────────────────────────────╯
```

**3. Proxy settings** (`Ctrl+P`)

```
              Proxy for all downloads
              ● listening   ○ not running

        ╭────────────────────────────────────────────╮
        │   · off (direct)                           │
        │ ❯ ● Tor Browser  127.0.0.1:9150          ✓ │
        │   ○ Tor service  127.0.0.1:9050            │
        │   ○ WARP proxy mode  127.0.0.1:40000       │
        │   · custom…                                │
        ╰────────────────────────────────────────────╯
```

Pick `custom…` to type your own, e.g. `socks5://127.0.0.1:1080` or `http://user:pass@host:8080`.
When a proxy is set, the home screen shows `● proxy active · Tor Browser` (green) or `○ proxy not reachable` (red).

**4. Downloading**

```
        Some video title · 1080p → ~/Downloads

        ████████████████░░░░░░░░░░░░░░░░░░░░░░░░   42%

             3.2 MB/s  ·  00:41 left
```

## Using Tor

Start Tor Browser (port 9150) or the Tor service (9050), press `Ctrl+P`, pick the matching preset. A green `● proxy active` line confirms the port is listening.

## Disclaimer

Download only content you have the right to download. You are responsible for how you use this tool.

## License

MIT
