#!/usr/bin/env node
import React, {useEffect, useRef, useState} from 'react'
import {spawn} from 'node:child_process'
import {createWriteStream, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {Box, Text, render, useApp, useInput, useStdin, useStdout} from 'ink'
import TextInput from 'ink-text-input'
import htm from 'htm'

const html = htm.bind(React.createElement)

const HOME_DIR = path.join(os.homedir(), '.yesmike')
const BIN_DIR = path.join(HOME_DIR, 'bin')
const CONFIG_FILE = path.join(HOME_DIR, 'config.json')
const DEFAULT_DIR = path.join(os.homedir(), 'Downloads')
const TAGLINE = 'paste. pick. save. done.'

// ---------- config ----------
function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function saveConfig(patch) {
  try {
    const next = {...loadConfig(), ...patch}
    mkdirSync(HOME_DIR, {recursive: true})
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2))
  } catch {
    // config is a convenience, never fatal
  }
}

// ---------- helpers ----------
const isUrl = s => {
  try {
    const u = new URL(s.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

const fmtBytes = n => {
  if (!n) return '?'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}
const fmtEta = s => (s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`)
const fmtDur = s => (s >= 3600 ? `${Math.floor(s / 3600)}:` : '') + `${Math.floor((s % 3600) / 60)}`.padStart(s >= 3600 ? 2 : 1, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0')
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const shorten = p => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p)

function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    let out = ''
    let child
    try {
      child = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...opts})
    } catch {
      return resolve({ok: false, out: ''})
    }
    child.stdout.on('data', d => (out += d))
    child.on('error', () => resolve({ok: false, out: ''}))
    child.on('close', code => resolve({ok: code === 0, out}))
  })
}

async function readClipboard() {
  if (process.platform === 'win32') return (await run('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'])).out.trim()
  if (process.platform === 'darwin') return (await run('pbpaste', [])).out.trim()
  return (await run('xclip', ['-selection', 'clipboard', '-o'])).out.trim()
}

// native folder picker (Windows only) — returns undefined when cancelled/unavailable
async function pickFolder(start) {
  if (process.platform !== 'win32') return undefined
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
    `$d.SelectedPath = '${start.replaceAll("'", "''")}'; $d.ShowNewFolderButton = $true; ` +
    "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }"
  const {out} = await run('powershell', ['-NoProfile', '-STA', '-Command', script], {stdio: ['ignore', 'pipe', 'ignore']})
  return out.trim() || undefined
}

// ---------- yt-dlp ----------
async function ensureYtDlp(onStatus, signal) {
  if ((await run('yt-dlp', ['--version'])).ok) return 'yt-dlp'
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  const local = path.join(BIN_DIR, exe)
  if ((await run(local, ['--version'])).ok) return local
  onStatus('first run: fetching yt-dlp…')
  await fs.mkdir(BIN_DIR, {recursive: true})
  const asset = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux'
  const r = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, {signal})
  if (!r.ok || !r.body) throw new Error(`could not download yt-dlp (${r.status})`)
  const tmp = local + '.download'
  await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp), {signal})
  await fs.chmod(tmp, 0o755)
  await fs.rename(tmp, local)
  return local
}

async function findFfmpeg() {
  if ((await run('ffmpeg', ['-version'])).ok) return undefined
  try {
    const mod = await import('ffmpeg-static')
    const p = mod.default ?? mod
    if (p && (await run(p, ['-version'])).ok) return p
  } catch {}
  return undefined
}

const extra = {browser: undefined, proxy: loadConfig().proxy}
const proxyArgs = () => (extra.proxy ? ['--proxy', extra.proxy] : [])
const authArgs = () => [...(extra.browser ? ['--cookies-from-browser', extra.browser] : []), ...proxyArgs()]

// socks5h = resolve DNS through the proxy (needed for Tor and for DNS-blocked sites)
const PROXY_PRESETS = [
  {label: 'off (direct)', value: ''},
  {label: 'Tor Browser', value: 'socks5h://127.0.0.1:9150', hint: 'open Tor Browser first'},
  {label: 'Tor service', value: 'socks5h://127.0.0.1:9050'},
  {label: 'WARP proxy mode', value: 'socks5://127.0.0.1:40000'},
  {label: 'custom…', value: null},
]
const proxyRow = (x, up = {}) => `${x.value ? (up[x.value] ? '●' : '○') : '·'} ${x.label}${x.value ? `  ${x.value.replace(/^\w+:\/\//, '')}` : ''}`

function portUp(proxyUrl) {
  const u = new URL(proxyUrl)
  return new Promise(resolve => {
    const s = net.connect({host: u.hostname, port: Number(u.port), timeout: 800})
    s.on('connect', () => (s.destroy(), resolve(true)))
    s.on('timeout', () => (s.destroy(), resolve(false)))
    s.on('error', () => resolve(false))
  })
}

// bare host:port → http://host:port; '' / off → no proxy; undefined → invalid
function normalizeProxy(v) {
  v = v.trim()
  if (!v || /^(off|none)$/i.test(v)) return ''
  if (!/^[a-z0-9]+:\/\//i.test(v)) v = `http://${v}`
  return /^(https?|socks4a?|socks5h?):\/\/\S+:\d+\/?$/i.test(v) || /^(https?|socks4a?|socks5h?):\/\/\S+@\S+:\d+\/?$/i.test(v) ? v : undefined
}

function cleanErr(stderr) {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean)
  const err = [...lines].reverse().find(l => l.startsWith('ERROR:')) ?? lines.at(-1) ?? ''
  return err.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '')
}

function probe(ytdlp, url, signal) {
  return new Promise((resolve, reject) => {
    const c = spawn(ytdlp, ['-J', '--no-playlist', '--no-warnings', ...authArgs(), url], {signal, windowsHide: true})
    let out = ''
    let err = ''
    c.stdout.on('data', d => (out += d))
    c.stderr.on('data', d => (err += d))
    c.on('error', reject)
    c.on('close', code => {
      if (code !== 0) return reject(new Error(cleanErr(err) || `yt-dlp exited with ${code}`))
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error('could not parse video info'))
      }
    })
  })
}

function buildChoices(info) {
  const formats = info.formats ?? []
  const hasV = f => f.vcodec && f.vcodec !== 'none'
  const hasA = f => f.acodec && f.acodec !== 'none'
  const size = f => f?.filesize ?? f?.filesize_approx
  const bestAudio = formats.filter(f => hasA(f) && !hasV(f)).sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const heights = [...new Set(formats.filter(f => hasV(f) && f.height).map(f => f.height))].sort((a, b) => b - a).slice(0, 8)

  const choices = heights.map(h => {
    const v = formats.filter(f => hasV(f) && f.height === h).sort((a, b) => (size(b) ?? 0) - (size(a) ?? 0))[0]
    const total = (size(v) ?? 0) + (hasA(v) ? 0 : size(bestAudio) ?? 0)
    return {label: `${h}p${total ? `  ~${fmtBytes(total)}` : ''}`, kind: 'video', args: ['-f', `bv*[height<=${h}]+ba/b[height<=${h}]/b`, '--merge-output-format', 'mp4']}
  })
  if (!choices.length) choices.push({label: 'best quality', kind: 'video', args: ['-f', 'bv*+ba/b']})
  choices.push({label: `mp3 audio${size(bestAudio) ? `  ~${fmtBytes(size(bestAudio))}` : ''}`, kind: 'audio', args: ['-x', '--audio-format', 'mp3']})
  return choices
}

function download({ytdlp, url, choice, outDir, ffmpeg, extraArgs = []}, {onProgress, onProcessing}, signal) {
  return new Promise((resolve, reject) => {
    const args = [
      '--newline', '--no-playlist', '--no-warnings', '--windows-filenames', '--no-simulate',
      '-P', outDir, '-o', '%(title).150B [%(id)s].%(ext)s',
      '--progress-template', 'download:YM %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s %(progress.fragment_index)s %(progress.fragment_count)s',
      '--print', 'after_move:filepath',
      ...authArgs(), ...extraArgs, ...choice.args,
    ]
    if (ffmpeg) args.push('--ffmpeg-location', ffmpeg)
    args.push(url)
    const c = spawn(ytdlp, args, {signal, windowsHide: true})
    let buf = ''
    let err = ''
    let filepath
    const num = s => (Number.isFinite(Number(s)) && s !== 'NA' ? Number(s) : undefined)
    c.stdout.on('data', d => {
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop()
      for (const line of lines) {
        if (line.startsWith('YM ')) {
          const [, dl, total, est, speed, eta, fi, fc] = line.split(' ')
          // HLS/DASH report fragments instead of bytes — use them for the percentage
          const frag = num(fc) && num(fi) !== undefined ? num(fi) / num(fc) : undefined
          onProgress({downloaded: num(dl) ?? 0, total: num(total) ?? num(est), frag, speed: num(speed), eta: num(eta)})
        } else if (/^\[(Merger|ExtractAudio|VideoConvertor|FixupM3u8|Fixup)/.test(line)) onProcessing()
        else if (line.trim() && !line.startsWith('[')) filepath = line.trim()
      }
    })
    c.stderr.on('data', d => (err += d))
    c.on('error', reject)
    c.on('close', code => (code === 0 && filepath ? resolve(filepath) : reject(new Error(cleanErr(err) || `yt-dlp exited with ${code}`))))
  })
}

// ---------- mouse ----------
// Ink has no hit-testing, so we keep a copy of the last frame it wrote and
// find clickable text in it by content (no layout math to keep in sync).
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g
let frameLines = []

function captureFrames(stream) {
  return new Proxy(stream, {
    get(target, prop) {
      if (prop === 'write') {
        return (chunk, ...rest) => {
          const lines = String(chunk).split('\n').map(l => l.replace(ANSI, ''))
          if (lines.some(l => l.trim() !== '')) frameLines = lines
          return target.write(chunk, ...rest)
        }
      }
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

function targetAt(x, y, targets) {
  for (const {match, action, padX = 1, padY = 0} of targets) {
    for (let row = y - 1 - padY; row <= y - 1 + padY; row++) {
      const line = frameLines[row]
      if (!line) continue
      let i = line.indexOf(match)
      while (i !== -1) {
        if (x - 1 >= i - padX && x - 1 <= i + match.length - 1 + padX) return action
        i = line.indexOf(match, i + 1)
      }
    }
  }
}

const MOUSE_ON = '\x1b[?1000h\x1b[?1006h'
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l'
const SGR_PRESS = /\x1b\[<(\d+);(\d+);(\d+)M/g
// ink's keypress parser leaks mouse reports into TextInput as typed text
const stripMouse = v => v.replace(/\x1b?\[?<\d+;\d+;\d+[Mm]/g, '')

function useMouseClick(onClick, active) {
  const ref = useRef(onClick)
  ref.current = onClick
  const {stdin} = useStdin()
  useEffect(() => {
    if (!active || !stdin) return
    process.stdout.write(MOUSE_ON)
    const onData = d => {
      for (const m of String(d).matchAll(SGR_PRESS)) if (m[1] === '0') ref.current(Number(m[2]), Number(m[3]))
    }
    stdin.on('data', onData)
    return () => {
      stdin.off('data', onData)
      process.stdout.write(MOUSE_OFF)
    }
  }, [active, stdin])
}

// ---------- UI ----------
const GLYPHS = {
  Y: ['10001', '10001', '01010', '00100', '00100'],
  E: ['11111', '10000', '11110', '10000', '11111'],
  S: ['01111', '10000', '01110', '00001', '11110'],
  M: ['10001', '11011', '10101', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '11111'],
  K: ['10001', '10010', '11100', '10010', '10001'],
}
function logoLines(word) {
  const rows = [0, 2, 4].map(r =>
    [...word]
      .map(ch => {
        const g = GLYPHS[ch]
        return [...g[0]]
          .map((_, x) => {
            const top = g[r][x] === '1'
            const bot = g[r + 1]?.[x] === '1'
            return top && bot ? '█' : top ? '▀' : bot ? '▄' : ' '
          })
          .join('')
      })
      .join(' ')
  )
  // yoinks-style dither: some solid squares become ▓
  return rows.map((row, r) => [...row].map((c, x) => (c === '█' && (x * 7 + r * 3) % 5 === 0 ? '▓' : c)).join(''))
}
const LOGO = logoLines('YESMIKE')
const BG = undefined

const Gap = ({n = 1}) => html`<${Box} flexDirection="column" flexShrink=${0}>${Array.from({length: n}, (_, i) => html`<${Text} key=${i}> <//>`)}<//>`

function Shortcuts({items}) {
  return html`<${Text} dimColor>${items.map(([k, v]) => `${k} ${v}`).join('  ·  ')}<//>`
}

function Bar({percent, width = 40}) {
  const p = Math.max(0, Math.min(1, percent))
  const filled = Math.round(p * width)
  return html`<${Text}>${'█'.repeat(filled)}<${Text} dimColor>${'░'.repeat(width - filled)}<//>  ${String(Math.round(p * 100)).padStart(3)}%<//>`
}

function Spin() {
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI(n => (n + 1) % frames.length), 80)
    return () => clearInterval(t)
  }, [])
  return html`<${Text}>${frames[i]}<//>`
}

function Framed({title, children, width, button, dim}) {
  const bw = button ? button.length + 4 : 0
  const w = width - bw
  const warn = title.startsWith('✗')
  const head = `╭─ ${title} `
  const top = head + '─'.repeat(Math.max(1, w - head.length - 1)) + (button ? '─' : '╮')
  const bottom = '╰' + '─'.repeat(Math.max(1, w - 2)) + (button ? '─' : '╯')
  return html`
    <${Box} width=${width} flexShrink=${0}>
      <${Box} flexDirection="column" width=${w}>
        <${Text} dimColor=${!warn} color=${warn ? 'red' : undefined}>${top}<//>
        <${Box} width=${w}>
          <${Text} dimColor>│ <//>
          <${Box} flexGrow=${1}>${children}<//>
          ${button ? null : html`<${Text} dimColor>│<//>`}
        <//>
        <${Text} dimColor>${bottom}<//>
      <//>
      ${button && html`
        <${Box} flexDirection="column" width=${bw}>
          <${Text} dimColor=${dim}>${'▄'.repeat(bw)}<//>
          <${Text} bold=${!dim} inverse=${!dim} dimColor=${dim}>${'  ' + button + '  '}<//>
          <${Text} dimColor=${dim}>${'▀'.repeat(bw)}<//>
        <//>`}
    <//>
  `
}

function App({initialUrl, clipboardUrl, onOutcome}) {
  const {exit} = useApp()
  const {stdout} = useStdout()
  const cfg = useRef(loadConfig())
  const [urlInput, setUrlInput] = useState('')
  const [url, setUrl] = useState(initialUrl ?? '')
  const [outDir, setOutDir] = useState(cfg.current.outDir ?? DEFAULT_DIR)
  const [dirInput, setDirInput] = useState('')
  const [proxy, setProxy] = useState(extra.proxy ?? '')
  const [proxyInput, setProxyInput] = useState('')
  const [proxyCursor, setProxyCursor] = useState(0)
  const [proxyUp, setProxyUp] = useState()
  // live reachability of the configured proxy (re-checked every 5s)
  useEffect(() => {
    setProxyUp(undefined)
    if (!proxy) return
    let alive = true
    const check = () => portUp(proxy).then(ok => alive && setProxyUp(ok)).catch(() => alive && setProxyUp(false))
    check()
    const t = setInterval(check, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [proxy])
  const [info, setInfo] = useState()
  const [choices, setChoices] = useState([])
  const [cursor, setCursor] = useState(0)
  const [choice, setChoice] = useState()
  const [phase, setPhase] = useState(initialUrl ? {name: 'probing', status: 'warming up…'} : {name: 'input'})
  const ytdlpRef = useRef('')
  const abortRef = useRef()

  const columns = stdout?.columns > 0 ? stdout.columns : 80
  const boxWidth = Math.max(24, Math.min(64, columns - 6))

  const startProbe = async target => {
    const ctl = new AbortController()
    abortRef.current = ctl
    setPhase({name: 'probing', status: 'warming up…'})
    try {
      ytdlpRef.current ||= await ensureYtDlp(status => setPhase({name: 'probing', status}), ctl.signal)
      if (ctl.signal.aborted) return
      setPhase({name: 'probing', status: 'fetching info…'})
      const meta = await probe(ytdlpRef.current, target, ctl.signal)
      if (ctl.signal.aborted) return
      setInfo(meta)
      setChoices(buildChoices(meta))
      setCursor(0)
      setPhase({name: 'picking'})
    } catch (e) {
      if (!ctl.signal.aborted) setPhase({name: 'error', message: e instanceof Error ? e.message : String(e)})
    }
  }

  useEffect(() => {
    if (initialUrl) void startProbe(initialUrl)
  }, [])

  const reset = (keepUrl = false) => {
    abortRef.current?.abort()
    if (!keepUrl) setUrlInput('')
    setInfo(undefined)
    setPhase({name: 'input'})
  }

  const startDownload = async (picked, dir) => {
    const ctl = new AbortController()
    abortRef.current = ctl
    setPhase({name: 'downloading', processing: false})
    try {
      await fs.mkdir(dir, {recursive: true})
      const ffmpeg = await findFfmpeg()
      const handlers = {
        onProgress: progress => setPhase(p => (p.name === 'downloading' ? {...p, progress, processing: false} : p)),
        onProcessing: () => setPhase(p => (p.name === 'downloading' ? {...p, processing: true} : p)),
      }
      const base = {ytdlp: ytdlpRef.current, url, choice: picked, outDir: dir, ffmpeg}
      const note = text => setPhase(p => (p.name === 'downloading' ? {...p, progress: undefined, note: text} : p))
      let filepath
      try {
        filepath = await download(base, handlers, ctl.signal)
      } catch (e) {
        if (ctl.signal.aborted || !/403|forbidden/i.test(String(e.message))) throw e
        // blocked: look like a real browser, then update yt-dlp and try once more
        note('blocked — retrying as a browser…')
        try {
          filepath = await download({...base, extraArgs: ['--impersonate', 'chrome']}, handlers, ctl.signal)
        } catch (e2) {
          if (ctl.signal.aborted || !/403|forbidden/i.test(String(e2.message))) throw e2
          note('still blocked — updating yt-dlp…')
          await run(ytdlpRef.current, ['-U', ...proxyArgs()])
          try {
            filepath = await download({...base, extraArgs: ['--impersonate', 'chrome']}, handlers, ctl.signal)
          } catch (e3) {
            if (!extra.browser && /403|forbidden/i.test(String(e3.message)))
              e3.message += ' — this site needs your login/cookies: run yesmike.bat --browser chrome'
            throw e3
          }
        }
      }
      onOutcome({filepath})
      setPhase({name: 'done', filepath})
    } catch (e) {
      if (!ctl.signal.aborted) setPhase({name: 'error', message: e instanceof Error ? e.message : String(e)})
    }
  }

  const chooseAt = i => {
    setChoice(choices[i])
    setDirInput(outDir)
    setPhase({name: 'destination'})
  }

  const openPicker = async () => {
    setPhase(p => ({...p, browsing: true}))
    const chosen = await pickFolder(dirInput.trim() || outDir)
    if (chosen) setDirInput(chosen)
    setPhase(p => ({...p, browsing: false}))
  }

  useInput(
    (input, key) => {
      const n = phase.name
      if (key.escape) {
        if (n === 'proxy' && phase.custom) setPhase({name: 'proxy', up: phase.up})
        else if (n === 'proxy') setPhase({name: 'input'})
        else if (n === 'probing' || n === 'downloading') reset(true)
        else if (n === 'destination') setPhase({name: 'picking'})
        else if (n !== 'input') reset()
      }
      if (n === 'picking') {
        if (key.upArrow || input === 'k') setCursor(c => (c + choices.length - 1) % choices.length)
        else if (key.downArrow || input === 'j') setCursor(c => (c + 1) % choices.length)
        else if (/^[1-9]$/.test(input) && Number(input) <= choices.length) setCursor(Number(input) - 1)
        else if (key.return) chooseAt(cursor)
      }
      if (n === 'input' && key.tab && clipboardUrl && urlInput === '') setUrlInput(clipboardUrl)
      if (n === 'destination' && key.tab && !phase.browsing) void openPicker()
      if (n === 'input' && key.ctrl && input === 'p') openProxy()
      if (n === 'proxy' && !phase.custom) {
        const last = PROXY_PRESETS.length - 1
        if (key.upArrow || input === 'k') setProxyCursor(c => (c + last) % (last + 1))
        else if (key.downArrow || input === 'j') setProxyCursor(c => (c + 1) % (last + 1))
        else if (/^[1-9]$/.test(input) && Number(input) <= last + 1) setProxyCursor(Number(input) - 1)
        else if (key.return) chooseProxy(proxyCursor)
      }
      if ((n === 'error' || n === 'done') && key.return) reset()
    },
    {isActive: Boolean(process.stdin.isTTY)},
  )

  const submitUrl = value => {
    const v = value.trim()
    if (!isUrl(v)) return setPhase({name: 'input', warning: 'that doesn’t look like a link — paste a full url'})
    setUrl(v)
    void startProbe(v)
  }
  const openProxy = () => {
    const current = PROXY_PRESETS.findIndex(x => x.value === proxy)
    setProxyCursor(current >= 0 ? current : PROXY_PRESETS.length - 1)
    setProxyInput(proxy)
    setPhase({name: 'proxy', up: {}})
    // show which local proxies are actually listening
    for (const x of PROXY_PRESETS)
      if (x.value) void portUp(x.value).then(ok => setPhase(p => (p.name === 'proxy' ? {...p, up: {...p.up, [x.value]: ok}} : p)))
  }
  const applyProxy = v => {
    extra.proxy = v || undefined
    setProxy(v)
    saveConfig({proxy: v})
    setPhase({name: 'input'})
  }
  const chooseProxy = i => {
    const value = PROXY_PRESETS[i].value
    if (value === null) setPhase(p => ({...p, custom: true, warning: undefined}))
    else applyProxy(value)
  }
  const submitProxy = value => {
    const v = normalizeProxy(value)
    if (v === undefined) return setPhase(p => ({...p, warning: 'use http://host:port or socks5://host:port'}))
    applyProxy(v)
  }
  const submitDir = value => {
    const dir = path.resolve((value.trim() || outDir).replace(/^~(?=$|[\\/])/, os.homedir()))
    setOutDir(dir)
    saveConfig({outDir: dir})
    void startDownload(choice, dir)
  }

  const clipboardOffered = Boolean(clipboardUrl) && urlInput === ''
  const hints = {
    input: [['↵', 'download'], ['^p', 'proxy'], ['^c', 'quit']],
    proxy: phase.custom ? [['↵', 'save'], ['esc', 'back'], ['^c', 'quit']] : [['↑↓', 'choose'], ['↵', 'use'], ['esc', 'back'], ['^c', 'quit']],
    probing: [['esc', 'cancel'], ['^c', 'quit']],
    picking: [['↑↓', 'choose'], ['↵', 'next'], ['esc', 'back'], ['^c', 'quit']],
    destination: [['↵', 'save here'], ...(process.platform === 'win32' ? [['⇥', 'browse…']] : []), ['esc', 'back'], ['^c', 'quit']],
    downloading: [['esc', 'cancel'], ['^c', 'quit']],
    done: [['↵', 'another'], ['^c', 'quit']],
    error: [['↵', 'try again'], ['^c', 'quit']],
  }[phase.name]

  // everything a mouse user would expect to press is clickable
  const back = () => (phase.name === 'destination' ? setPhase({name: 'picking'}) : phase.name === 'probing' || phase.name === 'downloading' ? reset(true) : reset())
  const hintAction = key => {
    const n = phase.name
    if (key === '^c') return () => exit()
    if (key === 'esc') return back
    if (key === '^p') return n === 'input' ? openProxy : undefined
    if (key === '⇥') return n === 'destination' ? () => !phase.browsing && void openPicker() : undefined
    if (key === '↵') {
      if (n === 'input') return () => submitUrl(urlInput)
      if (n === 'proxy') return () => (phase.custom ? submitProxy(proxyInput) : chooseProxy(proxyCursor))
      if (n === 'picking') return () => chooseAt(cursor)
      if (n === 'destination') return () => submitDir(dirInput)
      if (n === 'done' || n === 'error') return () => reset()
    }
  }
  const targets = []
  if (phase.name === 'input') targets.push({match: ' download ', padY: 1, action: () => submitUrl(urlInput)})
  if (phase.name === 'proxy' && phase.custom) targets.push({match: ' save ', padY: 1, action: () => submitProxy(proxyInput)})
  if (phase.name === 'proxy' && !phase.custom) PROXY_PRESETS.forEach((x, i) => targets.push({match: proxyRow(x, phase.up), action: () => chooseProxy(i)}))
  if (phase.name === 'destination') targets.push({match: ' save ', padY: 1, action: () => !phase.browsing && submitDir(dirInput)})
  if (phase.name === 'picking') choices.forEach((c, i) => targets.push({match: `${c.kind === 'audio' ? '♪' : '▶'} ${c.label}`, action: () => chooseAt(i)}))
  for (const [k, v] of hints) {
    const action = hintAction(k)
    if (action) targets.push({match: `${k} ${v}`, action})
  }
  useMouseClick((x, y) => {
    // the logo goes home
    const row = frameLines.findIndex(l => l.includes(LOGO[0]))
    if (row >= 0 && y - 1 >= row && y - 1 < row + LOGO.length) {
      if (phase.name !== 'input') back()
      return
    }
    targetAt(x, y, targets)?.()
  }, Boolean(process.stdin.isTTY))

  // keep the whole block vertically centred: estimate this screen's height, split the rest above/below
  const rows = stdout?.rows > 0 ? stdout.rows : 26
  const p = phase.progress
  return html`
    <${Box} width=${columns} height=${Math.max(10, rows - 1)} flexDirection="column" alignItems="center" justifyContent="center" backgroundColor=${BG}>
     <${Box} flexDirection="column" alignItems="center" flexShrink=${0}>
      ${LOGO.map((l, i) => html`<${Text} key=${i} bold>${l}<//>`)}
      <${Gap} />
      <${Text}>${TAGLINE}<//>
      <${Text} dimColor>youtube · x · instagram · tiktok · adult sites · +1800 more<//>
      ${proxy && html`
        <${Text} color=${proxyUp === undefined ? undefined : proxyUp ? 'green' : 'red'} dimColor=${proxyUp === undefined}>
          ${proxyUp ? '●' : '○'} ${proxyUp === undefined ? 'checking proxy' : proxyUp ? 'proxy active' : 'proxy not reachable'} · ${PROXY_PRESETS.find(x => x.value === proxy)?.label ?? trunc(proxy.replace(/^\w+:\/\//, ''), 40)}
        <//>`}
      <${Gap} />

      ${phase.name === 'input' && html`
        <${Framed} title=${phase.warning ? `✗ ${phase.warning}` : clipboardOffered ? 'link in your clipboard — ⇥ to paste it' : 'Paste a link'} width=${boxWidth} button="download">
          <${Text}>❯ <//>
          <${TextInput}
            value=${urlInput}
            onChange=${v => {
              v = stripMouse(v)
              setUrlInput(v)
              if (isUrl(v) && v.length - urlInput.length > 8) submitUrl(v) // pasted a whole link
            }}
            onSubmit=${submitUrl}
            placeholder="https://youtube.com/watch?v=…"
          />
        <//>
      `}

      ${phase.name === 'probing' && html`
        <${Framed} title="working…" width=${boxWidth} button="download" dim=${true}>
          <${Text} dimColor>${trunc(url, boxWidth - 12)}<//>
        <//>
      `}

      ${phase.name === 'picking' && html`
        <${Box} flexDirection="column" alignItems="center">
          <${Text} bold>${trunc(info?.title ?? '', Math.max(20, columns - 8))}<//>
          <${Text} dimColor>${[info?.extractor_key, info?.duration ? fmtDur(info.duration) : '', info?.uploader].filter(Boolean).join(' · ')}<//>
          <${Gap} />
          <${Box} borderStyle="round" borderDimColor=${true} flexDirection="column" paddingX=${2}>
            ${choices.map((c, i) => html`<${Text} key=${i} bold=${i === cursor}>${i === cursor ? '❯' : ' '} ${c.kind === 'audio' ? '♪' : '▶'} ${c.label}<//>`)}
          <//>
        <//>
      `}

      ${phase.name === 'proxy' && phase.custom && html`
        <${Framed} title=${phase.warning ? `✗ ${phase.warning}` : 'Custom proxy (empty = off)'} width=${Math.min(columns - 4, 78)} button="save">
          <${Text}>❯ <//>
          <${TextInput} value=${proxyInput} onChange=${v => setProxyInput(stripMouse(v))} onSubmit=${submitProxy} placeholder="socks5://127.0.0.1:1080" />
        <//>
      `}

      ${phase.name === 'proxy' && !phase.custom && html`
        <${Box} flexDirection="column" alignItems="center">
          <${Text} bold>Proxy for all downloads<//>
          <${Text} dimColor>● listening   ○ not running<//>
          <${Gap} />
          <${Box} borderStyle="round" borderDimColor=${true} flexDirection="column" paddingX=${2}>
            ${PROXY_PRESETS.map((x, i) => html`<${Text} key=${i} bold=${i === proxyCursor}>${i === proxyCursor ? '❯' : ' '} ${proxyRow(x, phase.up)}${x.value === proxy ? '  ✓' : ''}<//>`)}
          <//>
        <//>
      `}

      ${phase.name === 'destination' && html`
        <${Framed} title=${phase.browsing ? 'pick a folder in the dialog…' : `Save ${choice.kind === 'audio' ? 'mp3' : choice.label.split(' ')[0]} to`} width=${Math.min(columns - 4, 78)} button="save" dim=${phase.browsing}>
          <${Text}>❯ <//>
          <${TextInput} value=${dirInput} onChange=${v => setDirInput(stripMouse(v))} onSubmit=${submitDir} focus=${!phase.browsing} placeholder=${outDir} />
        <//>
      `}

      ${phase.name === 'downloading' && html`
        <${Box} flexDirection="column" alignItems="center">
          <${Text} dimColor>${trunc(info?.title ?? '', 42)} · ${choice?.label.split('  ')[0]} → ${shorten(outDir)}<//>
          <${Gap} />
          ${phase.processing
            ? html`<${Bar} percent=${1} /><${Gap} /><${Text}><${Spin} /> processing…<//>`
            : p?.total || p?.frag
              ? html`<${Bar} percent=${p.total ? p.downloaded / p.total : p.frag} /><${Gap} /><${Text} dimColor>${`${p.speed ? fmtBytes(p.speed) + '/s' : ''}`.padStart(12)}  ${(p.eta ? fmtEta(p.eta) + ' left' : '').padEnd(12)}<//>`
              : html`<${Text}><${Spin} /> ${phase.note ?? 'downloading…'} ${p ? fmtBytes(p.downloaded) : ''}<//>`}
        <//>
      `}

      ${phase.name === 'done' && html`
        <${Box} flexDirection="column" alignItems="center">
          <${Text}><${Text} bold>✓ saved! <//>find your file in:<//>
          <${Text} dimColor>${trunc(shorten(phase.filepath), columns - 6)}<//>
        <//>
      `}

      ${phase.name === 'error' && html`<${Box} width=${Math.max(20, Math.min(columns - 6, 72))}><${Text} bold>✗ ${phase.message}<//><//>`}

      <${Gap} n=${2} />
      ${phase.name === 'probing' && html`<${Text}><${Spin} /> ${phase.status}<//>`}
      <${Shortcuts} items=${hints} />
     <//>
    <//>
  `
}

// ---------- entry ----------
const HELP = `
  yesmike — paste a link, pick a quality, pick a folder.

  Usage
    yesmike [url] [--browser chrome|firefox|edge]

  --browser  reuse that browser's cookies (logins / age gates)
  Powered by yt-dlp.
`
const argv = process.argv.slice(2)
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(HELP)
  process.exit(0)
}
const bi = argv.findIndex(a => a === '--browser' || a === '-b')
if (bi >= 0) extra.browser = argv.splice(bi, 2)[1]
const pi = argv.indexOf('--proxy')
if (pi >= 0) {
  const v = normalizeProxy(argv.splice(pi, 2)[1] ?? '')
  if (v === undefined) {
    console.error('yesmike: bad --proxy, use http://host:port or socks5://host:port (or "off")')
    process.exit(1)
  }
  extra.proxy = v || undefined
  saveConfig({proxy: v})
}
const initialUrl = argv.find(isUrl)

const isTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY)
const enter = () => process.stdout.write('\x1b[?1049h\x1b[H')
const leave = () => process.stdout.write(MOUSE_OFF + '\x1b[?1049l')
let clipboardUrl
if (!initialUrl && isTTY) {
  const clip = await readClipboard()
  if (clip && !/\s/.test(clip) && isUrl(clip)) clipboardUrl = clip
}
if (isTTY) {
  enter()
  process.on('exit', leave)
  for (const ev of ['uncaughtException', 'unhandledRejection'])
    process.on(ev, e => {
      leave()
      console.error(e)
      process.exit(1)
    })
}

let outcome = {}
const {waitUntilExit} = render(html`<${App} initialUrl=${initialUrl} clipboardUrl=${clipboardUrl} onOutcome=${r => (outcome = r)} />`, {
  stdout: captureFrames(process.stdout),
})
await waitUntilExit()
if (isTTY) leave()
if (outcome.filepath) console.log(`✓ saved → ${outcome.filepath}`)
