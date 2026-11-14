import { describe, expect, it } from 'vitest'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'

describe('Browser viewport CLI', () => {
  it('projects the exact viewport intent onto the original Browser program and operation', async () => {
    for (const [flags, expected] of [
      [['--preset', 'responsive'], 'responsive'],
      [['--preset', 'mobile'], 'mobile'],
      [['--width', '844', '--height', '390'], { width: 844, height: 390, screenPosition: 'mobile' }],
      [['--width', '1280', '--height', '800', '--screen', 'desktop'], { width: 1280, height: 800, screenPosition: 'desktop' }]
    ] as const) {
      const invocation = await parseAgentMuxCliInvocation(['browser', 'viewport', '--browser', 'exact-browser', '--operation-id', 'original-intent', ...flags])
      expect(invocation.command.method).toBe('browser.run')
      expect(invocation.params).toMatchObject({ browserId: 'exact-browser', operationId: 'original-intent' })
      const applied = await new Function('setViewport', `return (async()=>{${invocation.params.code as string}})()`)((viewport: unknown) => viewport)
      expect(applied).toEqual(expected)
    }
  })

  it('refuses ambiguous or unrepresentable requests before RPC dispatch', async () => {
    for (const flags of [[], ['--preset', 'watch'], ['--preset', 'mobile', '--width', '844', '--height', '390'],
      ['--width', '844'], ['--height', '390'], ['--width', '0', '--height', '390'],
      ['--width', '844.5', '--height', '390'], ['--width', '2147483648', '--height', '390'],
      ['--width', '844', '--height', '390', '--screen', 'watch']]) {
      await expect(parseAgentMuxCliInvocation(['browser', 'viewport', '--browser', 'exact-browser', ...flags]))
        .rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
    }
  })
})
