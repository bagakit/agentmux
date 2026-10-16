import { build } from 'esbuild'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentMuxClient } from '../../src/client.js'
import type { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'

/** Two real Core owners with different wire producers, without a stale package dist.
 * Only the old generation's readable formatter changes. Its journal, author
 * checks, claim recipe and transport are compiled from this candidate's source.
 */
export async function previousWireCore(): Promise<{
  owner: { AgentMuxClient: typeof AgentMuxClient; AgentMuxFileAgentSessionStore: typeof AgentMuxFileAgentSessionStore }
  close(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'amux-previous-wire-'))
  const packageRoot = resolve(import.meta.dirname, '../..')
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
    await symlink(join(packageRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
    await build({
      stdin: { contents: "export { AgentMuxClient } from './src/client.js'; export { AgentMuxFileAgentSessionStore } from './src/agent-session-store.js'", resolveDir: packageRoot, sourcefile: 'previous-core-entry.ts', loader: 'ts' },
      outfile: join(root, 'core.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', logLevel: 'silent',
      plugins: [{ name: 'previous-wire-producer-only', setup(builder) {
        builder.onLoad({ filter: /[/\\]agent-message-render\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8')
          const start = source.indexOf('export function renderAgentMuxMessageEnvelope(')
          const end = source.indexOf('\nexport type AgentMuxMessagePrefix', start)
          if (start < 0 || end < start) throw Error('Previous wire fixture lost its formatter boundary')
          return { loader: 'ts', contents: source.slice(0, start) + `
export function renderAgentMuxMessageEnvelope(envelope: Pick<AgentMuxMessageEnvelope, 'messageId' | 'sender' | 'senderSessionId' | 'body'>): string {
  const source = envelope.sender.kind === 'agent-session' && envelope.senderSessionId !== null
    ? 'Agent ' + envelope.senderSessionId
    : envelope.sender.kind === 'external'
      ? 'External ' + [envelope.sender.actor.application.domain, envelope.sender.actor.application.appId, envelope.sender.actor.idType, envelope.sender.actor.userId, envelope.sender.externalConversationId].map(encodeURIComponent).join('/')
      : 'unverified local process'
  return '[Message from ' + source + ']\\n' + envelope.body
}
` + source.slice(end) }
        })
        builder.onLoad({ filter: /[/\\]agent-outbound-message\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8'), anchor = 'const envelope = document.documentElement!'
          if (source.split(anchor).length !== 2) throw Error('Previous wire fixture lost its platform envelope boundary')
          return { loader: 'ts', contents: source.replace(anchor, anchor + "; envelope.setAttribute('from', 'amux')") }
        })
      } }]
    })
    return { owner: await import(pathToFileURL(join(root, 'core.mjs')).href), close: async () => { await rm(root, { recursive: true, force: true }) } }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
