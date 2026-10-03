import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { parseSpaceControlRequest as sourceSpaceRequest, parseSpaceControlSuccessReceipt } from '../src/space-control-parser.js'
import { isLongAgentMuxControlOperation } from '../src/control.js'
import { workfaceCliFixture, location, saved } from './helpers/workface-cli.js'
import { AGENTMUX_CLI_COMMANDS } from '../src/agentmux-cli-commands.js'
import { AGENTMUX_CLI_SKILL } from '../src/agentmux-cli-help.js'
const parseSpaceControlRequest: typeof sourceSpaceRequest = process.env.AGENTMUX_TEST_FILE_PARSER_ENTRY
  ? (await import(process.env.AGENTMUX_TEST_FILE_PARSER_ENTRY)).parseSpaceControlRequest : sourceSpaceRequest
const base = { schemaVersion: 5, requestId: 'file-request' }
const body = { operation: 'open.file' as const, requestedPath: 'notes 中文.md',
  resource: { hostId: 'local', workspaceId: 'resource-exact', workspacePath: fixturePath("workspace"), zoneId: 'zone-exact', zonePath: fixturePath("workspace/topic"), path: 'topic/notes 中文.md' },
  placement: { status: 'created' as const, tabId: 'tab-exact', regionId: 'region-exact', locations: [location] },
  data: { kind: 'text' as const, reason: null }, navigation: 'background' as const, changed: true, outcome: 'opened' as const, save: saved, issues: [] }
const args = ['file', 'open', '--zone', 'zone-exact', '--path', 'notes 中文.md']
const region = { tabId: 'tab-exact', regionId: 'anchor-exact', split: 'right' as const,
  displayWorkspaceId: 'display-exact', groupId: 'group-exact' }
const regionArgs = ['--tab', region.tabId, '--region', region.regionId, '--split', region.split,
  '--display-workspace', region.displayWorkspaceId, '--group', region.groupId]
describe('File opening public CLI wire', () => {
  const h = workfaceCliFixture(body)
  it('passes the literal Zone path and preserves background as the explicit default', async () => {
    expect(await h.receipt(args)).toMatchObject({ result: { resource: body.resource, navigation: 'background', placement: body.placement } })
    expect(h.seen.at(-1)).toEqual({ schemaVersion: 5, requestId: expect.any(String), operation: 'open.file', path: 'notes 中文.md', zoneId: 'zone-exact', focus: false })
    expect(isLongAgentMuxControlOperation('open.file')).toBe(true)
  })
  it('passes exact display parents and explicit navigation separately from the resource root', async () => {
    await h.receipt([...args, '--space', 'space-exact', '--display-workspace', 'display-exact', '--group', 'group-exact', '--focus', '--operation-id', 'file-request'])
    expect(h.seen.at(-1)).toEqual({ ...base, operation: 'open.file', path: 'notes 中文.md', zoneId: 'zone-exact', spaceId: 'space-exact', displayWorkspaceId: 'display-exact', groupId: 'group-exact', focus: true })
  })
  it.each(['left', 'right', 'up', 'down'])('passes the exact existing occurrence and %s direction through the compiled CLI', async split => {
    const selected = regionArgs.map((value, index) => index === 5 ? split : value)
    expect(await h.receipt([...args, ...selected, '--operation-id', 'file-region-request'])).toMatchObject({ result: { placement: body.placement, navigation: 'background' } })
    expect(h.seen.at(-1)).toEqual({ schemaVersion: 5, requestId: 'file-region-request', operation: 'open.file',
      path: 'notes 中文.md', zoneId: 'zone-exact', focus: false, ...region, split })
    expect(body.placement.regionId).not.toBe(region.regionId)
  })
  it('carries the typed SDK Region destination over a private Unix socket and retains actual owner facts', async () => {
    const params = { operationId: 'typed-file-region', path: 'notes 中文.md', zoneId: 'zone-exact', focus: true, ...region }
    const { operation: _operation, ...result } = body
    expect(await h.fileOpen(params)).toEqual(result)
    expect(h.seen.at(-1)).toEqual({ schemaVersion: 5, requestId: params.operationId, operation: 'open.file',
      path: params.path, zoneId: params.zoneId, focus: true, ...region })
  })
  it('preserves every valid occurrence of the same File Region while confirming the requested occurrence', async () => {
    const placement = { ...body.placement, locations: [location, { ...location, displayWorkspaceId: 'other-display', groupId: 'other-group' }] }
    h.setReply({ ...body, placement })
    expect(await h.receipt([...args, ...regionArgs])).toMatchObject({ result: { placement } })
    expect(await h.fileOpen({ path: 'notes 中文.md', zoneId: 'zone-exact', focus: false, ...region })).toMatchObject({ placement })
    h.setReply(body)
  })
  it('rejects partial Region tuples, implicit targets and unsupported destinations before CLI contact', async () => {
    const malformed = [
      ['--tab', region.tabId], ['--region', region.regionId], ['--split', 'right'],
      ['--tab', region.tabId, '--region', region.regionId, '--split', 'right'],
      [...regionArgs, '--new-tab'], [...regionArgs.slice(0, 4), '--split', 'above', ...regionArgs.slice(6)],
      ['--tab', 'self', ...regionArgs.slice(2)], ['--region', 'self', ...regionArgs.slice(0, 2), ...regionArgs.slice(4)]
    ]
    for (const flags of malformed) {
      const count = h.seen.length, actual = await h.run([...args, ...flags])
      expect(actual.code, JSON.stringify(flags)).toBe(1); expect(h.seen).toHaveLength(count)
    }
  })
  it('strictly rejects incomplete or unrelated Region parameters in both Control and typed Unix RPC', async () => {
    const params = { path: 'notes 中文.md', zoneId: 'zone-exact', focus: false, ...region }
    const { displayWorkspaceId: _display, groupId: _group, ...withoutOccurrence } = params
    const malformed: Record<string, unknown>[] = [withoutOccurrence]
    for (const field of ['tabId', 'regionId', 'split', 'displayWorkspaceId', 'groupId']) {
      const copy: Record<string, unknown> = { ...params }; delete copy[field]; malformed.push(copy)
    }
    malformed.push({ ...params, split: 'above' }, { ...params, tabId: 'self' }, { ...params, regionId: null },
      { ...params, newTab: true }, { ...params, destination: { newTab: true } }, { ...params, target: { regionId: 'other' } })
    for (const invalid of malformed) {
      expect(() => parseSpaceControlRequest({ ...base, operation: 'open.file', ...invalid })).toThrow()
      const count = h.seen.length
      await expect(h.fileOpen(invalid as typeof params)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
      expect(h.seen).toHaveLength(count)
    }
  })
  it('refuses claimed placement in another Tab, output Region or display occurrence', async () => {
    const badPlacements = [
      { ...body.placement, tabId: 'other-tab' },
      { ...body.placement, regionId: null },
      { ...body.placement, locations: [{ ...location, tabId: 'other-tab' }] },
      { ...body.placement, locations: [{ ...location, regionId: 'other-file-region' }] },
      { ...body.placement, locations: [{ ...location, displayWorkspaceId: 'other-display' }] },
      { ...body.placement, locations: [{ ...location, groupId: 'other-group' }] }
    ]
    for (const placement of badPlacements) {
      h.setReply({ ...body, placement })
      const actual = await h.run([...args, ...regionArgs])
      expect(actual.code, actual.stderr).toBe(1); expect(JSON.parse(actual.stderr)).toMatchObject({ error: { code: 'CONTROL_PROTOCOL_ERROR' } })
      await expect(h.fileOpen({ path: 'notes 中文.md', zoneId: 'zone-exact', focus: false, ...region })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    }
    h.setReply(body)
  })
  it('preserves a truthful refused destination and does not invent a File Region', async () => {
    h.setReply({ ...body, placement: { status: 'none', tabId: null, regionId: null, locations: [] },
      navigation: 'cancelled', changed: false, outcome: 'refused', save: null,
      issues: [{ step: 'placement', code: 'INVALID_REGION_DESTINATION', message: 'The exact anchor is unavailable.', recovery: 'Inspect the exact Tab and Region before choosing another destination.' }] })
    expect(await h.receipt([...args, ...regionArgs], 1)).toMatchObject({ result: { outcome: 'refused', placement: { status: 'none', tabId: null, regionId: null } } })
    h.setReply(body)
  })
  it('keeps option-looking paths as data and reports failed reads without fabricating editable text', async () => {
    h.setReply({ ...body, requestedPath: '--help', data: { kind: 'failed', reason: 'read unavailable' }, outcome: 'partial' })
    expect(await h.receipt(['file', 'open', '--zone', 'zone-exact', '--path', '--help'], 1)).toMatchObject({ result: { requestedPath: '--help', placement: { status: 'created' }, data: { kind: 'failed' } } })
    expect(h.seen.at(-1)).toMatchObject({ path: '--help' }); h.setReply(body)
  })
  it('rejects missing exact roots, half display addresses and unsupported line navigation before contact', async () => {
    for (const bad of [['file', 'open', '--path', 'a'], [...args, '--display-workspace', 'display-exact'], [...args, '--line', '8']]) {
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
    const count = h.seen.length, help = await h.run(['file', 'open', '--help'])
    expect(help.code).toBe(0); expect(help.stdout).toContain('PATH'); expect(h.seen).toHaveLength(count)
    expect(help.stdout).toContain('--tab ID --region ID --split left|right|up|down')
    expect(help.stdout).toContain('actual File Region'); expect(help.stdout).toContain('default is background')
    const registered = AGENTMUX_CLI_COMMANDS.filter(command => command.method === 'file.open')
    expect(registered).toHaveLength(1); expect(registered[0]!.flags).toMatchObject({ '--tab': 'data', '--region': 'data', '--split': 'value' })
    expect(AGENTMUX_CLI_SKILL).toContain('agentmux file open --path PATH --zone ZONE --tab TAB --region REGION --split right')
  })
})
