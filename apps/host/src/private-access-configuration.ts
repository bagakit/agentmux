import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { AgentMuxError } from '@agentmux/core'
import { requirePrivateHostAddress, type PrivateTlsConfiguration } from './private-tls.js'

export type PrivateAccessConfiguration = PrivateTlsConfiguration & { readonly mobileBuildDirectory?: string }
export function defaultPrivateAccessConfigurationPath(storePath: string): string {
  return join(dirname(storePath), 'agentmux-private-access.json')
}

/** One explicit Host-owned, non-secret startup manifest. Reading never creates or repairs it. */
export async function readPrivateAccessConfiguration(path: string): Promise<PrivateAccessConfiguration> {
  const invalid = () => new AgentMuxError('Private mobile access configuration is invalid. Its original bytes are retained; correct the private IP, port and absolute certificate/build paths to restore mobile access. Unix and Agent Sessions remain available.', 'INVALID_CONTROL_REQUEST')
  if (!isAbsolute(path)) throw invalid()
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4096) throw invalid()
  let value: unknown
  try {
    const bytes = await readFile(path)
    if (bytes.byteLength < 1 || bytes.byteLength > 4096) throw invalid()
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }
  catch { throw invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const input = value as Record<string, unknown>
  const required = ['host', 'port', 'keyPath', 'certificatePath']
  if (!required.every(key => Object.hasOwn(input, key)) || Object.keys(input).some(key => ![...required, 'mobileBuildDirectory'].includes(key))
    || typeof input.host !== 'string' || typeof input.port !== 'number' || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535
    || typeof input.keyPath !== 'string' || !isAbsolute(input.keyPath)
    || typeof input.certificatePath !== 'string' || !isAbsolute(input.certificatePath)
    || Object.hasOwn(input, 'mobileBuildDirectory') && (typeof input.mobileBuildDirectory !== 'string' || !isAbsolute(input.mobileBuildDirectory))) throw invalid()
  requirePrivateHostAddress(input.host)
  return { host: input.host, port: input.port, keyPath: input.keyPath, certificatePath: input.certificatePath,
    ...(typeof input.mobileBuildDirectory === 'string' ? { mobileBuildDirectory: input.mobileBuildDirectory } : {}) }
}
