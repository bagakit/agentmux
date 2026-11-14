import type { ChildProcess } from 'node:child_process'
import { spawnClaudeNativeInputProducer } from '../../../core/test/helpers/claude-native-input-producer.js'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Independent native socket/file producer. Provider/Core admission and authenticated Hook HTTP stay real. */
export async function moteChatNativeProcess(id: string, workspace: string, env: Record<string, string>) {
  const root = await mkdtemp('/tmp/amx-mote-native-'), source = join(root, 'config', 'projects', 'project', id + '.jsonl')
  const inputs: Array<Record<string, any>> = []
  const child = spawnClaudeNativeInputProducer({ root, id, socketPath: join(root, 'input.sock'), sourcePath: source, workspace, adoptInput: true, env: { ...process.env, ...env } })
  let stderr = ''; child.stderr!.on('data', bytes => { stderr += bytes })
  child.on('message', value => { if (value && typeof value === 'object' && 'frame' in value && (value as any).frame.type === 'user') inputs.push((value as { frame: Record<string, any> }).frame) })
  try {
    const [ready] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error('Native producer exited: ' + stderr) })])
    if (!ready?.ready) throw Error('Native producer did not open its exact socket')
  } catch (error) { await close(child); await rm(root, { recursive: true, force: true }); throw error }
  return { processId: child.pid!, source, inputs, async close() { await close(child); await rm(root, { recursive: true, force: true }) } }
}
async function close(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = once(child, 'exit'); child.disconnect(); await done
}
