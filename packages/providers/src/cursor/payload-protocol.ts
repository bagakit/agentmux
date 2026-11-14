import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { NativeProviderError } from '../provider-error.js'

export type CursorWriter = { processId?: number; command?: string; args: readonly string[]; signal?: AbortSignal }
type CursorWriterServices = {
  AgentMuxError: NativeProviderError
  nativeProcessBirth(processId: number, signal: AbortSignal): Promise<string>
  nativeProcessExecutable(processId: number, signal: AbortSignal): Promise<{ path: string; device: bigint; inode: bigint }>
}

export function createCursorPayloadProtocol({
  AgentMuxError, nativeProcessBirth, nativeProcessExecutable
}: CursorWriterServices) {
  // Qualified together with the actual 2026.11.05-86047df native parser probe.
  // A version label or the pasted-body JSON schema alone does not qualify its
  // input timing. Unknown artifacts remain observable and retain their raw TTY.
  const qualified = {
    'cursor-agent': '2ccc9a8e167797641448b5e5c936f006ba137a2555f117f38c5eb76a5238a233',
    'index.js': '932a6744cb9cd5e06b9ef292a1dc58bc17e69f8a4f72c21e7cb572fa0561d15b',
    '1706.index.js': '146dd450f58e927f99b6d3674d6bccd9cb0b4946883f95a145a90e377207b1b7',
    '2166.index.js': 'be56a0eefd7c4324f8d7e8037c2bfcacfdac6d1effef8aa4dfa2119a648457a9'
  }
  function unavailable(): never { throw new AgentMuxError('This original native writer input protocol is unconfirmed. The original input and healthy terminal remain available.', 'AGENT_PROMPT_PAYLOAD_PROTOCOL_UNCONFIRMED') }
  // One bounded observation memo. Every use still checks current kernel identity,
  // mapped executable and all original file identities; this never grants input.
  let last: { signature: string; proof: string } | undefined

  async function qualifyCursorPayloadProtocol(context: CursorWriter): Promise<string> {
    if (!context.processId || !context.command || !isAbsolute(context.command)) unavailable()
    const signal = context.signal ?? new AbortController().signal
    const birth = await nativeProcessBirth(context.processId, signal)
    // This is the existing Core kernel-identity receipt, not ps/display parsing.
    const identity: unknown = JSON.parse(birth)
    if (!Array.isArray(identity) || identity.length !== 5 || identity[0] !== 'darwin' || identity[1] !== context.processId ||
        typeof identity[3] !== 'string' || !/^[1-9][0-9]*$/.test(identity[3]) || typeof identity[4] !== 'string' || !/^[0-9]{1,6}$/.test(identity[4])) unavailable()
    const startedNs = BigInt(identity[3]) * 1_000_000_000n + BigInt(identity[4]) * 1_000n
    const mapped = await nativeProcessExecutable(context.processId, signal), root = dirname(mapped.path)
    const node = await realpath(join(root, 'node')), command = await realpath(context.command)
    const nodeFile = await stat(node, { bigint: true })
    if (mapped.path !== node || String(nodeFile.dev) !== String(mapped.device) || String(nodeFile.ino) !== String(mapped.inode)) unavailable()
    const launcher = join(root, 'cursor-agent'), entry = join(root, 'index.js')
    // These are sufficient original entry witnesses. The Runtime has no typed OS
    // argv port for an arbitrary exec wrapper: that source stays unconfirmed,
    // rather than being labelled unsupported because its wrapper has another name.
    if (command !== launcher && !(command === node && (context.args[0] === entry || context.args[0] === '--use-system-ca' && context.args[1] === entry))) unavailable()
    const files: { path: string; hash: string; file: Awaited<ReturnType<typeof open>>; before: BigIntStats }[] = []
    try {
      for (const [name, hash] of Object.entries(qualified)) {
        const path = join(root, name), file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const before = await file.stat({ bigint: true })
          if (!before.isFile() || before.mtimeNs > startedNs || before.ctimeNs > startedNs) unavailable()
          files.push({ path, hash, file, before })
        } catch (error) { await file.close(); throw error }
      }
      const signature = JSON.stringify([birth, mapped.path, String(mapped.device), String(mapped.inode),
        ...files.map(({ path, before }) => [path, String(before.dev), String(before.ino), String(before.size), String(before.mtimeNs), String(before.ctimeNs)])])
      if (last?.signature !== signature) {
        for (const { file, hash, before } of files) {
          signal.throwIfAborted()
          const data = await file.readFile(), after = await file.stat({ bigint: true })
          if (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.size !== before.size ||
              createHash('sha256').update(data).digest('hex') !== hash) unavailable()
        }
        last = { signature, proof: createHash('sha256').update(signature).digest('base64url') }
      }
      const proof = last!.proof
      const current = await nativeProcessExecutable(context.processId, signal)
      if (current.path !== mapped.path || current.device !== mapped.device || current.inode !== mapped.inode || await nativeProcessBirth(context.processId, signal) !== birth) unavailable()
      for (const { path, before } of files) {
        const current = await stat(path, { bigint: true })
        if (current.dev !== before.dev || current.ino !== before.ino || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) unavailable()
      }
      return proof
    } finally { await Promise.all(files.map(({ file }) => file.close())) }
  }

  return { qualifyCursorPayloadProtocol }
}
