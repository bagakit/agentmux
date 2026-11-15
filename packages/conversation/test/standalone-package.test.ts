import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { it } from 'vitest'

const run = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '..')
const requireHere = createRequire(join(packageRoot, 'package.json'))

it('ships a standalone typed projection over accepted records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-conversation-package-'))
  try {
    const installed = join(root, 'node_modules/@agentmux/conversation')
    const hashes = join(root, 'node_modules/@noble/hashes')
    await mkdir(installed, { recursive: true })
    await mkdir(dirname(hashes), { recursive: true })
    await symlink(dirname(requireHere.resolve('@noble/hashes/sha2.js')), hashes, 'dir')
    const { stdout } = await run('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: packageRoot })
    await run('tar', ['-xzf', join(root, JSON.parse(stdout)[0].filename), '--strip-components=1', '-C', installed])
    const input = join(root, 'consumer.mts')
    await writeFile(input, `
import { projectConversationStream, type ConversationSourceRecord } from '@agentmux/conversation'

const source = { kind: 'native', providerId: 'provider', nativeSessionId: 'native' } as const
const reference = { hostId: 'source', agentSessionId: 'session' }
const record = {
  id: 'accepted-native', reference: { ...reference, source: { ...source, recordId: 'original' } },
  revision: 'original-version', order: { kind: 'native-page', source, indexInPage: 0 },
  original: { kind: 'native', item: { id: 'original', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original' }] } }
} satisfies ConversationSourceRecord

const timeline = projectConversationStream({ ...reference, reference, records: [record], scope: { sources: [source] }, coverage: [] })
const original: typeof record = timeline.records[0]!
const event = timeline.events[0]
if (original !== record || timeline.events.length !== 1 || event?.author.kind !== 'agent' ||
    event.content[0]?.recordRevision !== 'original-version' || timeline.coverage[0]?.current !== 'partial') {
  throw new Error('The standalone projection lost the original record, event or coverage')
}
`)
    const compiler = resolve(packageRoot, '../../node_modules/typescript/bin/tsc')
    await run(process.execPath, [compiler, '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', input], { cwd: root })
    await run(process.execPath, [input], { cwd: root })
  } finally {
    await rm(root, { recursive: true })
  }
})
