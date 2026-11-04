// The short text System info ▸ Copy for bug report puts on the clipboard, and the head
// of the console's Save TXT: what a bug report needs to know about the machine, and
// nothing about the project (no names, paths, coordinates or images). Pure: the probe
// that fills `info` is utils/systemInfo.js.
import { formatBytes } from './formatBytes.js'

// Browser and OS from the user-agent string, and from User-Agent Client Hints where the
// browser gives them (Chromium: `brands`, and `platformVersion`, the only way to tell
// Windows 11 from 10). → { browser, os }
export function describeBrowser(ua = '', hints = null) {
  const browser = browserFromHints(hints) ?? browserFromUa(ua)
  const os = osFromHints(hints) ?? osFromUa(ua)
  return { browser, os }
}

const HINT_BRANDS = [
  ['Microsoft Edge', 'Edge'],
  ['Opera', 'Opera'],
  ['Brave', 'Brave'],
  ['Google Chrome', 'Chrome'],
  ['Chromium', 'Chromium'],
]
function browserFromHints(hints) {
  const list = hints?.fullVersionList ?? hints?.brands
  if (!Array.isArray(list)) return null
  for (const [brand, name] of HINT_BRANDS) {
    const hit = list.find((b) => b.brand === brand)
    if (hit) return `${name} ${hit.version}`
  }
  return null
}

function browserFromUa(ua) {
  const rules = [
    [/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Edge'],
    [/OPR\/([\d.]+)/, 'Opera'],
    [/Firefox\/([\d.]+)/, 'Firefox'],
    [/FxiOS\/([\d.]+)/, 'Firefox'],
    [/CriOS\/([\d.]+)/, 'Chrome'],
    [/Chrome\/([\d.]+)/, 'Chrome'],
    [/Version\/([\d.]+).*Safari\//, 'Safari'],
  ]
  for (const [re, name] of rules) {
    const m = ua.match(re)
    if (m) return `${name} ${m[1]}`
  }
  return 'unknown browser'
}

function osFromHints(hints) {
  const platform = hints?.platform
  if (!platform) return null
  const version = hints.platformVersion
  if (platform === 'Windows' && version) {
    // platformVersion 13 and up is Windows 11; 1–10 are Windows 10's releases.
    return Number.parseInt(version, 10) >= 13 ? 'Windows 11' : 'Windows 10'
  }
  if (platform === 'macOS' && version) return `macOS ${version}`
  return version ? `${platform} ${version}` : platform
}

function osFromUa(ua) {
  if (/Windows NT 10/.test(ua)) return 'Windows 10 or 11'
  if (/Windows NT/.test(ua)) return 'Windows'
  if (/iPhone|iPad|iPod/.test(ua)) {
    const m = ua.match(/OS (\d+)[_.](\d+)/)
    return m ? `iOS ${m[1]}.${m[2]}` : 'iOS'
  }
  if (/Android/.test(ua)) {
    const m = ua.match(/Android ([\d.]+)/)
    return m ? `Android ${m[1]}` : 'Android'
  }
  // macOS froze its user-agent version at 10.15, so a number here would mislead.
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  if (/Linux/.test(ua)) return 'Linux'
  return 'unknown OS'
}

const yesNo = (v) => (v == null ? 'unknown' : v ? 'yes' : 'no')

/**
 * info = { appVersion, browser, os, gpu, cores, deviceMemoryGB, webgpu, simd, isolated,
 *          storage: { mode: 'browser' | 'folder' | null, used, quota, durable }, missing: [label] }
 * → the summary's lines.
 */
export function systemSummaryLines(info = {}) {
  const s = info.storage ?? {}
  const lines = [
    `WebSfM ${info.appVersion ?? 'unknown version'}`,
    `Browser: ${info.browser ?? 'unknown'} on ${info.os ?? 'unknown OS'}`,
    `GPU: ${info.gpu || 'unknown'}`,
    `CPU cores: ${info.cores || 'unknown'} · memory: ${info.deviceMemoryGB ? `${info.deviceMemoryGB} GB or more` : 'unknown'}`,
    `WebGPU: ${yesNo(info.webgpu)} · WASM SIMD: ${yesNo(info.simd)} · threads (cross-origin isolated): ${yesNo(info.isolated)}`,
  ]
  const where = s.mode === 'folder' ? 'in a folder on disk' : s.mode === 'browser' ? 'in browser storage' : 'none open'
  const room =
    Number.isFinite(s.used) && Number.isFinite(s.quota)
      ? ` · browser storage: ${formatBytes(s.used)} used of ${formatBytes(s.quota)}`
      : ''
  lines.push(`Project: ${where}${room}${s.durable == null ? '' : ` · durable: ${yesNo(s.durable)}`}`)
  if (info.missing?.length) lines.push(`Missing: ${info.missing.join(', ')}`)
  return lines
}

export const systemSummaryText = (info) => systemSummaryLines(info).join('\n')
