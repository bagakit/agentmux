import { describe, expect, it } from 'vitest'
import { AGENTMUX_CLI_COMMANDS } from '../src/agentmux-cli-commands.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '../src/control-host.js'
import { parseBrowserTargetsResult } from '../src/control-browser-targets.js'

const destination = { kind: 'launcher' as const, regionId: 'original-launcher' }
const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'private-open', operation: 'open.browser', url: 'https://example.invalid/', destination }

describe('original Browser public creation and discovery mode', () => {
  it('actual CLI parser and control codec retain the private choice, and default creation stays normal', async () => {
    const command = AGENTMUX_CLI_COMMANDS.find(row => row.method === 'browser.open')!
    expect(command).toBeDefined()
    const params = await command.parse(['--url', request.url, '--in-region', destination.regionId, '--private'])
    expect(params).toMatchObject({ url: request.url, mode: 'private', destination })
    expect(parseAgentMuxControlRequest({ ...request, ...params })).toMatchObject({ mode: 'private', destination })
    expect(await command.parse(['--url', request.url, '--in-region', destination.regionId])).not.toHaveProperty('mode')
    expect(command.usage).toContain('--private')
    expect(() => parseAgentMuxControlRequest({ ...request, mode: 'unconfirmed' })).toThrow('Browser mode')
  })

  it('creation receipts and target discovery retain actual mode without exposing a partition', () => {
    const region = { tabId: 'original-tab', regionId: 'original-region', workspaceId: 'workspace', kind: 'browser', browserId: 'original-browser', mode: 'private' }
    const result = parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: request.requestId, ok: true, operation: request.operation, result: { region } })
    expect(result).toMatchObject({ result: { region } })
    const target = { id: region.browserId, workspaceId: 'workspace', source: 'embedded', status: 'ready', mode: 'private', url: request.url, title: 'Private', navigationId: 'original-nav', capabilities: [], partition: 'must-not-cross-wire' }
    expect(parseBrowserTargetsResult({ coverage: 'complete', targets: [target] }).targets).toEqual([expect.objectContaining({ mode: 'private' })])
    expect(parseBrowserTargetsResult({ coverage: 'complete', targets: [target] }).targets[0]).not.toHaveProperty('partition')
    expect(() => parseBrowserTargetsResult({ coverage: 'complete', targets: [{ ...target, mode: 'invented' }] })).toThrow('mode')
    expect(parseBrowserTargetsResult({ coverage: 'complete', targets: [{ ...target, source: 'external', mode: undefined }] }).targets[0]).not.toHaveProperty('mode')
  })
})
