import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const renderer = join(import.meta.dirname, '../src/renderer')
function policy(page: string): Map<string, string> {
  const html = readFileSync(join(renderer, page), 'utf8')
  const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1]
  if (!content) throw new Error(`${page} declares no Content-Security-Policy`)
  return new Map(content.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const [name, ...sources] = part.split(/\s+/)
    return [name!, sources.join(' ')]
  }))
}

describe('renderer page policies', () => {
  // A Region moved into its own window keeps its live media element; that document's policy then decides
  // whether the element may still fetch from the loopback playback lease.
  it('a separate workbench window admits the same media sources as the main window', () => {
    const main = policy('index.html').get('media-src'), window = policy('workbench-window.html').get('media-src')
    expect(main).toMatch(/http:\/\/127\.0\.0\.1:\*/)
    expect(window).toBe(main)
  })
})
