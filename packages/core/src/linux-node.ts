import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError } from './errors.js'

/** The Linux Node every remote Core runs on. Update both values together from the
 * official SHASUMS256.txt; the Linux release build and the App's first install use them. */
export const LINUX_NODE_VERSION = 'v24.22.1'
export const LINUX_NODE_X64_SHA256 = 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c'
export const LINUX_NODE_ARCHIVE = `node-${LINUX_NODE_VERSION}-linux-x64.tar.gz`
const LINUX_NODE_URL = `https://nodejs.org/dist/${LINUX_NODE_VERSION}/${LINUX_NODE_ARCHIVE}`

export type LinuxNodeArchive = { path: string; version: string; sha256: string }

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** The pinned archive from this cache, downloaded once from nodejs.org when absent. A
 * cached or downloaded archive that does not match the pinned digest is never used. */
export async function linuxNodeArchive(cacheDirectory: string, download: (url: string) => Promise<Uint8Array> = fetchBytes): Promise<LinuxNodeArchive> {
  const path = join(cacheDirectory, LINUX_NODE_ARCHIVE)
  try {
    if (sha(await readFile(path)) === LINUX_NODE_X64_SHA256) return { path, version: LINUX_NODE_VERSION, sha256: LINUX_NODE_X64_SHA256 }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const bytes = await download(LINUX_NODE_URL)
  if (sha(bytes) !== LINUX_NODE_X64_SHA256) throw new AgentMuxError(`${LINUX_NODE_ARCHIVE} does not match its pinned digest; it was not used.`, 'CORE_ARTIFACT_UNAVAILABLE')
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 })
  await writeFile(path + '.partial', bytes, { mode: 0o600 })
  await rename(path + '.partial', path)
  return { path, version: LINUX_NODE_VERSION, sha256: LINUX_NODE_X64_SHA256 }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new AgentMuxError(`Downloading ${url} failed: HTTP ${response.status}.`, 'CORE_ARTIFACT_UNAVAILABLE')
  return new Uint8Array(await response.arrayBuffer())
}
