import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'

const [storePath, mode] = process.argv.slice(2)
const store = new AgentMuxFileAgentSessionStore(storePath)
const sessionId = 'packed-prompt-owner'
const file = path.join(`${storePath}.prompt-locks`, createHash('sha256').update(sessionId).digest('hex'))
let callbacks = 0
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const input = () => new Promise(resolve => process.stdin.once('data', resolve))
const inode = async () => { const value = await stat(file); return { dev: value.dev, ino: value.ino } }
if (mode === 'hold') {
  await store.withPromptSubmission(sessionId, async () => {
    callbacks += 1
    const core = await realpath(fileURLToPath(import.meta.resolve('@agentmux/core')))
    const fromCore = createRequire(core)
    const native = await realpath(fromCore.resolve('fs-native-extensions'))
    const closure = {}
    const visit = async (name, resolver) => {
      if (closure[name]) return
      const entry = await realpath(resolver.resolve(name))
      let directory = path.dirname(entry), manifest
      while (directory !== path.dirname(directory)) {
        try {
          const candidate = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
          if (candidate.name === name) { manifest = candidate; break }
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        directory = path.dirname(directory)
      }
      assert.equal(manifest?.name, name, 'The loader entry must belong to its physical package')
      closure[name] = { version: manifest.version, entry, sha256: createHash('sha256').update(await readFile(entry)).digest('hex') }
      for (const dependency of Object.keys(manifest.dependencies ?? {})) await visit(dependency, createRequire(entry))
    }
    await visit('fs-native-extensions', fromCore)
    const addon = process.report.getReport().sharedObjects.filter(file => file.endsWith('.node'))
    assert.equal(addon.length, 1, 'The public File Store must load its one native primitive')
    const descriptor = await realpath(addon[0])
    emit({ phase: 'held', pid: process.pid, core, native, addon: descriptor,
      addonSha256: createHash('sha256').update(await readFile(descriptor)).digest('hex'), inode: await inode(),
      versions: process.versions, closure, callbacks })
    await input()
  })
  emit({ phase: 'released', callbacks, inode: await inode() })
} else if (mode === 'contend') {
  await assert.rejects(store.withPromptSubmission(sessionId, async () => { callbacks += 1 }),
    error => error.code === 'AGENT_PROMPT_SUBMISSION_BUSY')
  assert.equal(callbacks, 0)
  await store.withPromptSubmission('another-session', async () => { callbacks += 1 })
  emit({ phase: 'busy', callbacks, inode: await inode() })
} else if (mode === 'acquire') {
  await store.withPromptSubmission(sessionId, async () => { callbacks += 1 })
  await assert.rejects(store.withPromptSubmission(sessionId, async () => {
    callbacks += 1
    throw new Error('callback failed deliberately')
  }), /callback failed deliberately/)
  await store.withPromptSubmission(sessionId, async () => { callbacks += 1 })
  assert.equal(callbacks, 3)
  emit({ phase: 'acquired-and-released', callbacks, inode: await inode() })
} else throw new Error(`Unexpected proof mode: ${mode}`)
