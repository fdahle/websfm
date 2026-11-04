import { describe, expect, it } from 'vitest'
import { describeBrowser, systemSummaryLines, systemSummaryText } from './systemSummary.js'

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const EDGE_WIN = CHROME_WIN + ' Edg/141.0.3537.57'
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0'
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15'
const SAFARI_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1'

describe('describeBrowser', () => {
  it('reads the user-agent string', () => {
    expect(describeBrowser(CHROME_WIN)).toEqual({ browser: 'Chrome 141.0.0.0', os: 'Windows 10 or 11' })
    expect(describeBrowser(EDGE_WIN).browser).toBe('Edge 141.0.3537.57')
    expect(describeBrowser(FIREFOX_LINUX)).toEqual({ browser: 'Firefox 144.0', os: 'Linux' })
    // macOS froze its user-agent version, so none is claimed.
    expect(describeBrowser(SAFARI_MAC)).toEqual({ browser: 'Safari 18.4', os: 'macOS' })
    expect(describeBrowser(SAFARI_IPAD).os).toBe('iOS 18.4')
    expect(describeBrowser('')).toEqual({ browser: 'unknown browser', os: 'unknown OS' })
  })

  it('prefers client hints, which tell Windows 11 from 10', () => {
    const hints = {
      platform: 'Windows',
      platformVersion: '15.0.0',
      fullVersionList: [
        { brand: 'Not.A/Brand', version: '99.0.0.0' },
        { brand: 'Chromium', version: '141.0.7390.55' },
        { brand: 'Google Chrome', version: '141.0.7390.55' },
      ],
    }
    expect(describeBrowser(CHROME_WIN, hints)).toEqual({ browser: 'Chrome 141.0.7390.55', os: 'Windows 11' })
    expect(describeBrowser(CHROME_WIN, { ...hints, platformVersion: '10.0.0' }).os).toBe('Windows 10')
  })
})

describe('systemSummaryLines', () => {
  const info = {
    appVersion: '0.6.1',
    browser: 'Chrome 141',
    os: 'Linux',
    gpu: 'ANGLE (NVIDIA GeForce RTX 3060)',
    cores: 16,
    deviceMemoryGB: 8,
    webgpu: true,
    simd: true,
    isolated: true,
    storage: { mode: 'browser', used: 2 * 1024 ** 3, quota: 100 * 1024 ** 3, durable: false },
    missing: [],
  }

  it('says what a bug report needs, in a few lines', () => {
    const lines = systemSummaryLines(info)
    expect(lines[0]).toBe('WebSfM 0.6.1')
    expect(lines[1]).toBe('Browser: Chrome 141 on Linux')
    expect(lines).toContain('GPU: ANGLE (NVIDIA GeForce RTX 3060)')
    expect(lines.join('\n')).toMatch(/memory: 8 GB or more/)
    expect(lines.at(-1)).toMatch(
      /^Project: in browser storage · browser storage: 2(\.0)? GB used of 100(\.0)? GB · durable: no$/,
    )
    expect(lines.some((l) => l.startsWith('Missing'))).toBe(false)
  })

  it('names what is missing, and copes with unknowns', () => {
    const text = systemSummaryText({ missing: ['WebGPU', 'Folder projects'] })
    expect(text).toMatch(/WebSfM unknown version/)
    expect(text).toMatch(/GPU: unknown/)
    expect(text).toMatch(/Project: none open/)
    expect(text).toMatch(/Missing: WebGPU, Folder projects$/)
  })
})
