import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** An Agent's execution context is not input to the private package probe. */
export function privatePackageSmokeEnvironment(inherited, { userData, runtimeRoot, readyFile }) {
  const environment = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']
    .filter(name => inherited[name] !== undefined).map(name => [name, inherited[name]]))
  const home = join(userData, 'home')
  return {
    ...environment,
    HOME: home, ZDOTDIR: home, SHELL: '/bin/zsh', TMPDIR: join(runtimeRoot, 'tmp'),
    CODEX_HOME: join(home, '.codex'), XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    AGENTMUX_AGENT_SESSION_STORE: join(userData, 'agent-sessions.json'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'global-messages.ndjson'),
    AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_DISABLE_CRASH_REPORTER: '1',
    AGENTMUX_RUNTIME_DIRECTORY: runtimeRoot, AGENTMUX_STATE_DIRECTORY: join(runtimeRoot, 'state'),
    AGENTMUX_DESKTOP_READY_FILE: readyFile, AGENTMUX_DESKTOP_EXIT_AFTER_READY: '1'
  }
}

const LOG_TAIL_BYTES = 1024 * 1024

/** Preserve known private smoke files, never staging bundles or user profiles. */
export async function preservePackageSmokeFailure(temporaryRoot, failureRoot, error) {
  await mkdir(failureRoot, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(failureRoot, 'smoke-'))
  const files = []
  for (const [prefix, root] of [['app', temporaryRoot], ['dmg', join(temporaryRoot, 'verification')]]) {
    for (const name of ['desktop-stdout.log', 'desktop-stderr.log', 'user-data/agentmux-host.log', 'semantic-host-cleanup.json', 'runtime-cleanup.json']) {
      const relative = `${prefix}-${name.replaceAll('/', '-')}`
      let handle
      try {
        handle = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const before = await handle.stat()
        if (!before.isFile()) throw new Error('The private diagnostic source is not a regular file.')
        const offset = Math.max(0, before.size - LOG_TAIL_BYTES)
        const buffer = Buffer.alloc(Math.min(before.size, LOG_TAIL_BYTES))
        let bytes = 0
        while (bytes < buffer.length) {
          const read = await handle.read(buffer, bytes, buffer.length - bytes, offset + bytes)
          if (read.bytesRead === 0) break
          bytes += read.bytesRead
        }
        const captured = buffer.subarray(0, bytes), after = await handle.stat()
        const stable = before.size === after.size && before.mtimeMs === after.mtimeMs
        await writeFile(join(directory, relative), captured, { mode: 0o600, flag: 'wx' })
        files.push({ source: `${prefix}/${name}`, file: relative, sourceBytes: before.size, offset, bytes,
          status: !stable ? 'changed-during-read' : offset > 0 || bytes !== before.size ? 'truncated' : 'complete',
          capturedSha256: createHash('sha256').update(captured).digest('hex') })
      } catch (cause) {
        if (cause.code !== 'ENOENT') throw cause
        files.push({ source: `${prefix}/${name}`, status: 'unavailable', code: cause.code })
      } finally { await handle?.close() }
    }
  }
  const failures = error instanceof AggregateError ? error.errors : [error]
  const receipt = { schema: 'agentmux.private-package-failure.v1', directory, logTailBytes: LOG_TAIL_BYTES,
    ...(error.privateSmokeCleanup ? { cleanup: error.privateSmokeCleanup } : {}),
    failures: failures.map(failure => {
      const message = String(failure?.message ?? failure)
      return { name: String(failure?.name ?? typeof failure), message: message.slice(0, 8192),
        messageChars: message.length, messageTruncated: message.length > 8192 }
    }), files }
  await writeFile(join(directory, 'failure.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  return receipt
}
