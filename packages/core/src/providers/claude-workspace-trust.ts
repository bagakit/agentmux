import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentWorkspaceTrustContext, AgentWorkspaceTrustReceipt } from '../agent-provider.js'

/**
 * Claude asks "Is this a project you trust?" on its first start in an untrusted folder. The
 * cursor rests on "No, exit", so the first Enter AgentMux types ends the Run before any native
 * conversation exists. AgentMux pre-trusts only the exact home the Host confirmed for this launch
 * (a Mote or Topic home), through the same record Claude writes when a person accepts that dialog.
 *
 * Facts read from the shipped Claude Code bundle, not guessed:
 * - The global file is `$CLAUDE_CONFIG_DIR` (else `$HOME`) / `.claude<suffix>.json`; a non-empty
 *   legacy `<config dir>/.config.json` wins when present.
 * - A folder is trusted when `projects[<key>].hasTrustDialogAccepted === true` for its git root, or
 *   for it or an ancestor up to that git root (any ancestor outside git). Trusting exactly the home
 *   covers its own folders but never a foreign repository nested in it: Claude stops that walk at
 *   the nested repository's root and keeps asking.
 * - Claude serializes writes with a `mkdir <file>.lock` lock (proper-lockfile, stale after 10 s)
 *   and rebuilds `projects` by merging per key, so one key changed under that lock survives.
 */

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 5_000
const LOCK_POLL_MS = 25

type ClaudeConfig = Record<string, unknown> & { projects?: Record<string, Record<string, unknown>> }

/** The path Claude records for a folder: absolute, normalized and NFC, without symlink resolution. */
export function claudeTrustKey(directory: string): string {
  return resolve(directory).normalize('NFC')
}

/** Mirror Claude's own choice of its global configuration file. */
export async function claudeGlobalConfigPath(env: Readonly<Record<string, string>>): Promise<string> {
  const configDirectory = env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
  const home = env.HOME ?? homedir()
  const legacy = join(configDirectory ? resolve(configDirectory) : join(home, '.claude'), '.config.json')
  try {
    const legacyStat = await stat(legacy)
    if (legacyStat.isFile() && legacyStat.size > 0) return legacy
  } catch { /* absent legacy file: use the current name */ }
  const suffix = (env.CLAUDE_CODE_CUSTOM_OAUTH_URL ?? process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL) ? '-custom-oauth' : ''
  return join(configDirectory ? resolve(configDirectory) : home, `.claude${suffix}.json`)
}

function trusted(config: ClaudeConfig, key: string): boolean {
  return config.projects?.[key]?.hasTrustDialogAccepted === true
}

async function readConfig(path: string): Promise<ClaudeConfig | null> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch { return null }
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The Claude configuration is not a JSON object.')
  return parsed as ClaudeConfig
}

async function acquireLock(lockPath: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    signal?.throwIfAborted()
    try {
      await mkdir(lockPath)
      return async () => { await rmdir(lockPath).catch(() => undefined) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        // proper-lockfile refreshes the lock's mtime while held; an old one is abandoned.
        if (Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS) { await rmdir(lockPath).catch(() => undefined); continue }
      } catch { continue }
      if (Date.now() >= deadline) throw new Error('Another Claude process holds its configuration lock.')
      await new Promise(done => setTimeout(done, LOCK_POLL_MS))
    }
  }
}

async function writeAtomically(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.agentmux-${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', mode)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally { await handle.close() }
  try { await rename(temporary, path) } catch (error) { await unlink(temporary).catch(() => undefined); throw error }
}

/**
 * Record Claude folder trust for `workspacePath`, a home the Host confirmed as AgentMux's own.
 * Never creates the configuration file and changes only that one project entry.
 */
export async function prepareClaudeOwnedWorkspaceTrust(context: AgentWorkspaceTrustContext): Promise<AgentWorkspaceTrustReceipt> {
  const trustKey = claudeTrustKey(context.workspacePath)
  const configPath = await claudeGlobalConfigPath(context.env)
  try {
    const before = await readConfig(configPath)
    // Claude creates and owns a missing configuration during its own onboarding.
    if (!before) return { status: 'unconfirmed', trustKey, configPath, code: 'CLAUDE_CONFIG_ABSENT' }
    if (trusted(before, trustKey)) return { status: 'already-trusted', trustKey, configPath, code: 'CLAUDE_TRUST_PRESENT' }
    const release = await acquireLock(`${configPath}.lock`, context.signal)
    try {
      const current = await readConfig(configPath)
      if (!current) return { status: 'unconfirmed', trustKey, configPath, code: 'CLAUDE_CONFIG_ABSENT' }
      if (trusted(current, trustKey)) return { status: 'already-trusted', trustKey, configPath, code: 'CLAUDE_TRUST_PRESENT' }
      const projects = current.projects && typeof current.projects === 'object' ? current.projects : {}
      const entry = projects[trustKey] && typeof projects[trustKey] === 'object' ? projects[trustKey] : {}
      const next: ClaudeConfig = { ...current, projects: { ...projects, [trustKey]: { ...entry, hasTrustDialogAccepted: true } } }
      const mode = (await stat(configPath)).mode & 0o777
      await writeAtomically(configPath, JSON.stringify(next, null, 2), mode)
      return { status: 'trusted', trustKey, configPath, code: 'CLAUDE_TRUST_RECORDED' }
    } finally { await release() }
  } catch (error) {
    if (context.signal?.aborted) throw error
    return { status: 'unconfirmed', trustKey, configPath, code: 'CLAUDE_TRUST_UNCONFIRMED',
      issue: error instanceof Error ? error.message : String(error) }
  }
}
