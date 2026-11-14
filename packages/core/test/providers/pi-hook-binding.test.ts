import { afterEach, expect, it, vi } from 'vitest'
import { createPiManagedHookPlan } from '../../src/providers/pi.js'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

afterEach(() => vi.unstubAllEnvs())
const marker = { AGENTMUX_ENV: '1', AGENTMUX_PROVIDER_ID: 'pi' }
const binding = { AGENTMUX_HOOK_URL: 'http://127.0.0.1:1/original', AGENTMUX_HOOK_TOKEN: 'original-token' }
const context = { sessionManager: { getSessionId: () => 'native-pi' } }
async function generated() {
  const content = createPiManagedHookPlan({ PI_CODING_AGENT_DIR: '/private/unused-pi' }).mutations[0]!.content
  return await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(content).toString('base64')}`)
}

it.each([undefined, 'claude'])('an outside/foreign Pi host (%s) reads no credentials and registers no handlers', async provider => {
  const original = process.env
  let reads = 0
  const env = { ...marker, ...(provider === undefined ? { AGENTMUX_ENV: undefined } : { AGENTMUX_PROVIDER_ID: provider }) }
  Object.defineProperties(env, { AGENTMUX_HOOK_URL: { get() { reads++; return binding.AGENTMUX_HOOK_URL } },
    AGENTMUX_HOOK_TOKEN: { get() { reads++; return binding.AGENTMUX_HOOK_TOKEN } } })
  const handlers = new Map(), fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
  try {
    process.env = env as NodeJS.ProcessEnv
    ;(await generated()).default({ on: (name: string, handler: unknown) => handlers.set(name, handler) })
    expect(reads).toBe(0); expect(handlers.size).toBe(0); expect(fetch).not.toHaveBeenCalled()
  } finally { process.env = original; fetch.mockRestore() }
})

it('each loaded Pi extension keeps its original Run binding after ambient environment changes', async () => {
  const original = process.env, sent: { url: string; token: string }[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    sent.push({ url: String(url), token: (init!.headers as Record<string, string>).authorization! }); return new Response('{}')
  })
  try {
    process.env = { ...marker, ...binding }
    const first = new Map<string, (event: unknown, ctx: unknown) => void>(), second = new Map<string, (event: unknown, ctx: unknown) => void>()
    const module = await generated()
    module.default({ on: (name: string, handler: any) => first.set(name, handler) })
    process.env.AGENTMUX_HOOK_URL = 'http://127.0.0.1:2/second'; process.env.AGENTMUX_HOOK_TOKEN = 'second-token'
    module.default({ on: (name: string, handler: any) => second.set(name, handler) })
    process.env.AGENTMUX_HOOK_URL = 'http://127.0.0.1:3/foreign'; process.env.AGENTMUX_HOOK_TOKEN = 'foreign-token'
    first.get('agent_start')!({}, context); second.get('agent_start')!({}, context)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent).toEqual([{ url: binding.AGENTMUX_HOOK_URL, token: 'Bearer original-token' },
      { url: 'http://127.0.0.1:2/second', token: 'Bearer second-token' }])
  } finally { process.env = original; fetch.mockRestore() }
})

it('preserves the native literal root and home expansion rules', () => {
  const workspace = '/private/workspace', home = '/private/home'
  for (const [value, expected] of [['', home + '/.pi/agent'], ['  ', workspace + '/  '], [' relative-root ', workspace + '/ relative-root '],
    ['~', home], ['~/literal-root', home + '/literal-root'], [pathToFileURL('/private/url-root').href, '/private/url-root']]) {
    expect(createPiManagedHookPlan({ HOME: home, PI_CODING_AGENT_DIR: value }, workspace).mutations[0]!.path)
      .toBe(resolve(expected!, 'extensions/agentmux.js'))
  }
})
