import { describe, expect, it } from 'vitest'
import { runDemandCli } from '../src/cli.js'

describe('agentmux-demand JSON contract', () => {
  it('does not accept task aliases or an implicit current working directory', async () => {
    const errors: string[] = []
    const code = await runDemandCli(['task', 'list'], {
      env: {},
      stdout: () => undefined,
      stderr: (text) => errors.push(text),
    })
    expect(code).toBe(1)
    expect(JSON.parse(errors[0] ?? '{}')).toMatchObject({ error: { code: 'INVALID_INPUT' } })
    const noRoot = await runDemandCli(['list'], {
      env: {},
      stdout: () => undefined,
      stderr: (text) => errors.push(text),
    })
    expect(noRoot).toBe(1)
    expect(JSON.parse(errors.at(-1) ?? '{}')).toMatchObject({ error: { message: expect.stringContaining('--root') } })
  })
})
