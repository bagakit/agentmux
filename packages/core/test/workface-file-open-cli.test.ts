import { describe, expect, it } from 'vitest'
import { parseSpaceControlRequest, parseSpaceControlSuccessReceipt } from '../src/space-control-parser.js'
import { isLongAgentMuxControlOperation } from '../src/control.js'
import { workfaceCliFixture, location, saved } from './helpers/workface-cli.js'
const base = { schemaVersion: 5, requestId: 'file-request' }
const body = { operation: 'open.file' as const, requestedPath: 'notes 中文.md',
  resource: { hostId: 'local', workspaceId: 'resource-exact', workspacePath: '/workspace', zoneId: 'zone-exact', zonePath: '/workspace/topic', path: 'topic/notes 中文.md' },
  placement: { status: 'created' as const, tabId: 'tab-exact', regionId: 'region-exact', locations: [location] },
  data: { kind: 'text' as const, reason: null }, navigation: 'background' as const, changed: true, outcome: 'opened' as const, save: saved, issues: [] }
const args = ['open', 'file', '--zone', 'zone-exact', '--path', 'notes 中文.md']
describe('File opening public CLI wire', () => {
  const h = workfaceCliFixture(body)
  it('passes the literal Zone path and preserves background as the explicit default', async () => {
    expect(await h.receipt(args)).toMatchObject({ result: { resource: body.resource, navigation: 'background', placement: body.placement } })
    expect(h.seen.at(-1)).toEqual({ schemaVersion: 5, requestId: expect.any(String), operation: 'open.file', path: 'notes 中文.md', zoneId: 'zone-exact', focus: false })
    expect(isLongAgentMuxControlOperation('open.file')).toBe(true)
  })
  it('passes exact display parents and explicit navigation separately from the resource root', async () => {
    await h.receipt([...args, '--space', 'space-exact', '--display-workspace', 'display-exact', '--group', 'group-exact', '--focus', '--request-id', 'file-request'])
    expect(h.seen.at(-1)).toEqual({ ...base, operation: 'open.file', path: 'notes 中文.md', zoneId: 'zone-exact', spaceId: 'space-exact', displayWorkspaceId: 'display-exact', groupId: 'group-exact', focus: true })
  })
  it('keeps option-looking paths as data and reports failed reads without fabricating editable text', async () => {
    h.setReply({ ...body, requestedPath: '--help', data: { kind: 'failed', reason: 'read unavailable' }, outcome: 'partial' })
    expect(await h.receipt(['open', 'file', '--zone', 'zone-exact', '--path', '--help'], 1)).toMatchObject({ result: { requestedPath: '--help', placement: { status: 'created' }, data: { kind: 'failed' } } })
    expect(h.seen.at(-1)).toMatchObject({ path: '--help' }); h.setReply(body)
  })
  it('rejects missing exact roots, half display addresses and unsupported line navigation before contact', async () => {
    for (const bad of [['open', 'file', '--path', 'a'], [...args, '--display-workspace', 'display-exact'], [...args, '--line', '8']]) {
      const count = h.seen.length; expect((await h.run(bad)).code).toBe(1); expect(h.seen).toHaveLength(count)
    }
  })
  it('strictly decodes media results and refuses extra lifecycle fields', () => {
    const { operation, ...result } = body
    expect(parseSpaceControlSuccessReceipt({ ...base, ok: true, operation, result: { ...result, data: { kind: 'media-preview', reason: null } } })).toMatchObject({ result: { data: { kind: 'media-preview' } } })
    const longTab = 'file:resource:' + 'directory/'.repeat(60) + 'note.md', longRegion = 'region:' + longTab
    expect(parseSpaceControlSuccessReceipt({ ...base, ok: true, operation, result: { ...result,
      placement: { ...result.placement, tabId: longTab, regionId: longRegion,
        locations: [{ ...location, tabId: longTab, regionId: longRegion }] } } })).toMatchObject({ result: { placement: { tabId: longTab, regionId: longRegion } } })
    expect(() => parseSpaceControlRequest({ ...base, operation, path: 'a', zoneId: 'zone-exact', focus: false, executorId: 'codex' })).toThrow()
    expect(() => parseSpaceControlSuccessReceipt({ ...base, ok: true, operation, result: { ...result, data: { kind: 'directory', reason: null } } })).toThrow()
  })
  it('refuses a reply for another literal path and discovers its Zone-specific grammar', async () => {
    h.setReply({ ...body, requestedPath: 'replacement.md' }); expect((await h.run(args)).code).toBe(1)
    h.setReply({ ...body, resource: { ...body.resource, zoneId: 'other-zone' } })
    const foreign = await h.run(args)
    expect(foreign.code).toBe(1); expect(JSON.parse(foreign.stderr)).toMatchObject({ error: { code: 'CONTROL_PROTOCOL_ERROR' } })
    h.setReply(body)
    const count = h.seen.length, help = await h.run(['open', 'file', '--help'])
    expect(help.code).toBe(0); expect(help.stdout).toContain('Zone-relative-path'); expect(h.seen).toHaveLength(count)
  })
})
