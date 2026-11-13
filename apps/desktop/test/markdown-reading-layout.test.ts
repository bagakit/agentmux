import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp") } }))
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { settingsCliCommand as parseSettingsCommand } from '../../../packages/core/test/helpers/settings-command.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'

const principal = { transport: 'unix', principal: { kind: 'user', id: 'markdown-reading-layout-test' } } as const
function settings(f: Awaited<ReturnType<typeof configOwnerFixture>>) {
  const rpc = new AgentMuxRpcService({ execute: async request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Wrong settings owner')
    return executeSettingsControl(request, f.owner)
  } })
  return async (args: string[]) => {
    const command = await parseSettingsCommand(args)
    return rpc.call(command.method, command.params, principal)
  }
}
const defaults = [
  { key: 'markdown.readingWidth', kind: 'string', value: 'standard', default: 'standard', enum: ['standard', 'wide', 'full'] },
  { key: 'markdown.readingTypeface', kind: 'string', value: 'sans', default: 'sans', enum: ['sans', 'serif'] },
  { key: 'markdown.readingFontSize', kind: 'number', value: 13, default: 13, enum: Array.from({ length: 9 }, (_, index) => index + 12) }
] as const

it('CLI/RPC discover the Markdown reading layout through the original settings owner without materializing defaults', async () => {
  const f = await configOwnerFixture(), call = settings(f), bytes = await f.bytes()
  expect(await call(['inspect', 'markdown'])).toMatchObject({ partial: true, entries: defaults })
  for (const entry of defaults) expect((await call(['inspect', entry.key])).entries).toEqual([entry])
  expect(f.owner.current.markdown).toBeUndefined()
  expect(await f.bytes()).toBe(bytes)
  expect(f.save).not.toHaveBeenCalled()
})

it('each legal value persists durably through the ConfigOwner and publishes after commit', async () => {
  const f = await configOwnerFixture(), call = settings(f)
  for (const [key, values] of [['markdown.readingWidth', ['wide', 'full', 'standard']], ['markdown.readingTypeface', ['serif', 'sans']],
    ['markdown.readingFontSize', ['12', '20', '16']]] as const) {
    for (const value of values) {
      const receipt = await call(['set', key, value])
      expect(receipt.entry).toMatchObject({ key, value: key === 'markdown.readingFontSize' ? Number(value) : value })
      const reopened = await new ConfigStore(f.store.filePath).get()
      expect(reopened.markdown).toEqual(f.owner.current.markdown)
    }
  }
  expect(f.owner.current.markdown).toEqual({ readingWidth: 'standard', readingTypeface: 'sans', readingFontSize: 16 })
})

it('invalid values never clamp, round, coerce or publish', async () => {
  const f = await configOwnerFixture(), call = settings(f), bytes = await f.bytes()
  for (const value of ['11', '21', '13.5', 'NaN', '', '0x10', ' 13']) await expect(call(['set', 'markdown.readingFontSize', value])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  for (const [key, value] of [['markdown.readingWidth', 'WIDE'], ['markdown.readingWidth', 'narrow'], ['markdown.readingTypeface', 'mono']]) {
    await expect(call(['set', key!, value!])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  }
  for (const markdown of [{ readingFontSize: 11 }, { readingFontSize: 13.5 }, { readingWidth: 'narrow' }, { arbitrary: true }]) {
    expect(() => f.store.validate({ ...f.owner.current, markdown } as never)).toThrow()
  }
  expect(await f.bytes()).toBe(bytes); expect(f.publish).not.toHaveBeenCalled()
})

it('a first authored edit of one field keeps a concurrently saved other field', async () => {
  const f = await configOwnerFixture(), before = structuredClone(f.owner.current)
  await f.owner.update(current => ({ ...current, markdown: { readingTypeface: 'serif' } }))
  await f.owner.edit({ ...before, markdown: { readingWidth: 'standard', readingTypeface: 'sans', readingFontSize: 13 } },
    { ...before, markdown: { readingWidth: 'wide', readingTypeface: 'sans', readingFontSize: 13 } })
  expect(f.owner.current.markdown).toEqual({ readingWidth: 'wide', readingTypeface: 'serif' })
  expect((await f.disk()).markdown).toEqual(f.owner.current.markdown)
})
