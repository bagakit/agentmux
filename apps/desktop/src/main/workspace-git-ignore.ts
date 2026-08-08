import type { ExecutionHost } from '@agentmux/core'

/** Optional Git decoration never prevents browsing a directory. */
export async function gitIgnoredNames(host: ExecutionHost, directory: string, names: string[]): Promise<Set<string>> {
  if (!names.length) return new Set()
  try {
    const result = await host.run('git', ['-C', directory, 'check-ignore', '-z', '--stdin'], {
      input: names.join('\0') + '\0', timeoutMs: 5000, maxOutputBytes: 2 * 1024 * 1024
    })
    return new Set(result.exitCode === 0 || result.exitCode === 1 ? result.stdout.split('\0').filter(Boolean) : [])
  } catch { return new Set() }
}
