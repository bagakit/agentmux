import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { AGENTMUX_CLI_COMMANDS } from '../../../packages/core/src/agentmux-cli-commands.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { ownedSettings, scalarSettings } from '../src/main/settings/setting-catalog.js'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

// A private document copy lets the same guard exercise mutations without changing shared docs.
const catalogFile = process.env.AGENTMUX_SETTINGS_CATALOG_DOC ?? new URL('../../../docs/settings-catalog.md', import.meta.url)
const catalog = await readFile(catalogFile, 'utf8')
const commands = [...catalog.matchAll(/(?:^|`)(?:amux ([^`\n]+)|(settings (?:inspect|set)\b[^`\n]*))/gm)]
  .map(match => (match[1] ?? match[2])!.trim())

it('resolves every documented inspect target through the real scalar and owned setting declarations', () => {
  // Discover the independent owner's declaration only; no real directory or operation is observed.
  const owned = ownedSettings({
    inspect: async () => { throw new Error('Document discovery must not inspect user storage.') },
    change: async () => { throw new Error('Document discovery must not change user storage.') }
  })
  const scalar = scalarSettings(DEFAULT_CONFIG)
  expect(scalar.length).toBeGreaterThan(0)
  expect(owned.length).toBeGreaterThan(0)
  const keys = [...scalar, ...owned].map(setting => setting.key)
  expect(new Set(keys).size).toBe(keys.length)
  const targets = [...new Set(commands.flatMap(command => {
    const match = /^settings inspect(?:\s+(\S+))?/.exec(command)
    return match?.[1] ? [match[1]] : []
  }))]
  expect(targets.length).toBeGreaterThan(0)
  for (const target of targets) {
    expect(keys.some(key => key === target || key.startsWith(`${target}.`)), `Unsupported documented inspect target: ${target}`).toBe(true)
  }
  // This entry must remain discoverable even though it is intentionally absent from AppConfig.
  expect(targets).toContain('notes.directory')
  expect(owned.map(setting => setting.key)).toContain('notes.directory')
  const writes = commands.flatMap(command => /^settings set (\S+)/.exec(command)?.[1] ?? [])
  expect(writes.length).toBeGreaterThan(0)
  for (const key of writes) expect(keys, `Unsupported documented set key: ${key}`).toContain(key)
})

it('finds every documented resource command in the actual CLI command tree', () => {
  const methods = new Set(AGENTMUX_CLI_COMMANDS.map(command => command.method))
  expect(methods.size).toBeGreaterThan(0)
  expect(commands.length).toBeGreaterThan(0)
  let resources = 0
  for (const command of commands) {
    const words = command.split(/\s+/)
    const scalar = words[0] === 'settings' && ['inspect', 'set'].includes(words[1]!)
    // Arguments, flags and placeholders are not part of a command's identity.
    const boundary = words.findIndex(word => !/^[a-z][a-z0-9-]*$/.test(word))
    const path = scalar ? words.slice(0, 2) : words.slice(0, boundary < 0 ? words.length : boundary)
    const method = path.join('.')
    const helpGroup = words.includes('--help') && [...methods].some(entry => entry.startsWith(`${method}.`))
    expect(methods.has(method) || helpGroup, `Unsupported documented CLI command: amux ${command}`).toBe(true)
    if (!scalar) resources++
  }
  expect(resources).toBeGreaterThan(0)
})
