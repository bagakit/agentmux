import { expect, it, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { APP_ICON_IDS } from '@agentmux/client-ui/app-icon-catalog'
import { desktopBotCreationPreset } from '../src/renderer/src/lib/bot-creation-preset'

afterEach(() => vi.unstubAllGlobals())

it('uses the exact selected published PNG for every new bot, with bounded dimensions', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const parsed = new URL(url, 'http://fixture.invalid')
    const bytes = await readFile(resolve('.' + parsed.pathname))
    return new Response(new Uint8Array(bytes))
  }))
  for (const id of APP_ICON_IDS) {
    const preset = await desktopBotCreationPreset('Unchanged bot name', id)
    const bytes = await readFile(resolve('packages/client-ui/src/assets/app-icons', id + '.png'))
    expect(preset.name).toBe('Unchanged bot name')
    const delivered = Buffer.from(preset.avatar.pngDataUrl.split(',')[1]!, 'base64')
    expect(createHash('sha256').update(delivered).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(bytes.readUInt32BE(16)).toBe(512)
    expect(bytes.readUInt32BE(20)).toBe(512)
  }
})
