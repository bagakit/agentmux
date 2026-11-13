import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LocalExecutionHost } from '@agentmux/core'
import { WorkspaceMediaStreams, livePlaylistHoldMs, playlistReferences, resolvePlaylistReference } from '../src/main/workspace-media-streams.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'

const roots: string[] = []
const owners: WorkspaceMediaStreams[] = []
const segment = (seed: number) => Buffer.from(Array.from({ length: 1880 }, (_, index) => (index * seed) % 256))

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'agentmux-media-playlist-'))
  roots.push(base)
  const root = join(base, 'workspace')
  await mkdir(join(root, 'hls'), { recursive: true })
  const workspace: WorkspaceRecord = { id: 'workspace', name: 'Media', hostId: 'local', path: root, kind: 'folder' }
  const files = new WorkspaceFiles(() => new LocalExecutionHost())
  const streams = new WorkspaceMediaStreams(files, id => id === workspace.id ? workspace : undefined)
  owners.push(streams)
  // Encoders publish a playlist by rename, so every rewrite here does too.
  const put = async (path: string, content: string | Buffer) => {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(`${target}.tmp`, content)
    await rename(`${target}.tmp`, target)
  }
  return { base, root, workspace, files, streams, put }
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; at: number }
function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(url), { method, headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks), at: Date.now() }))
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function ready(f: Awaited<ReturnType<typeof fixture>>, path: string) {
  const opened = await f.streams.open(f.workspace, path)
  if (opened.status !== 'ready') throw new Error(`playlist not ready: ${JSON.stringify(opened)}`)
  return opened
}

const vod = (...uris: string[]) => ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-PLAYLIST-TYPE:VOD',
  ...uris.flatMap(uri => ['#EXTINF:2.0,', uri]), '#EXT-X-ENDLIST', ''].join('\n')
const live = (sequence: number, ...uris: string[]) => ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1',
  `#EXT-X-MEDIA-SEQUENCE:${sequence}`, ...uris.flatMap(uri => ['#EXTINF:1.0,', uri]), ''].join('\n')

afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

describe('playlist reference scanning', () => {
  it('reads URI lines and only the fetchable URI attribute, even beside quoted values that look like one', () => {
    const text = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="say ,URI=\\"x\\"",URI="audio/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.4d401f,mp4a.40.2"', 'v0/index.m3u8',
      '#EXT-X-SESSION-DATA:DATA-ID="com.example",URI="ignored.json"', '#ext-x-key:METHOD=AES-128,URI="k.key"', '#EXTINF:2,', 'seg 1.ts\rhidden.ts', ''].join('\r\n')
    expect(playlistReferences(text)).toEqual(['init.mp4', 'audio/en.m3u8', 'v0/index.m3u8', 'k.key', 'seg 1.ts', 'hidden.ts'])
  })

  it.each([
    ['http://cdn.example/a.ts', 'external-reference'], ['HTTPS://cdn.example/a.ts', 'external-reference'],
    ['//cdn.example/a.ts', 'external-reference'], ['/etc/a.ts', 'external-reference'], ['\\\\cdn.example\\a.ts', 'external-reference'],
    [' data:video/mp2t,00', 'external-reference'], ['file:///etc/a.ts', 'external-reference'],
    ['../../../a.ts', 'outside-workspace'], ['../../../a/hls/a.ts', 'outside-workspace'], ['..\\..\\..\\b\\a.ts', 'outside-workspace'],
    ['%2e%2e/%2e%2e/%2e%2e/a.ts', 'outside-workspace'], ['a%2Fb.ts', 'unsupported-resource'],
    ['{$host}/a.ts', 'unsupported-resource']
  ] as const)('%s is refused as %s', (reference, state) =>
    expect(resolvePlaylistReference(reference, 'hls/v0/index.m3u8')).toEqual({ state, path: 'hls/v0/index.m3u8' }))

  it('resolves relative references as the player does, decoding each segment once', () => {
    expect(resolvePlaylistReference('../seg/a.ts', 'hls/v0/index.m3u8')).toBe('hls/seg/a.ts')
    expect(resolvePlaylistReference('片 段.ts?v=1#t', 'hls/index.m3u8')).toBe('hls/片 段.ts')
    expect(resolvePlaylistReference('100%25.ts', 'hls/index.m3u8')).toBe('hls/100%.ts')
    expect(resolvePlaylistReference('..\\seg\\a.ts', 'hls/v0/index.m3u8')).toBe('hls/seg/a.ts')
    expect(resolvePlaylistReference('../../a.ts', 'hls/v0/index.m3u8')).toBe('a.ts')
    // The type is the request's question, not the playlist's: a key or caption file stays in scope.
    expect(resolvePlaylistReference('enc.key', 'hls/v0/index.m3u8')).toBe('hls/v0/enc.key')
  })

  it('holds only a playlist that can still grow', () => {
    expect(livePlaylistHoldMs(vod('a.ts'))).toBeNull()
    expect(livePlaylistHoldMs(live(0, 'a.ts'))).toBe(1000)
    expect(livePlaylistHoldMs(live(0, 'a.ts').replace('TARGETDURATION:1', 'TARGETDURATION:6'))).toBe(3000)
    expect(livePlaylistHoldMs(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1', 'v0/index.m3u8', ''].join('\n'))).toBeNull()
  })
})

describe('workspace playlist leases', () => {
  it('plays an on-demand TS playlist without holding its reload, and serves segments by range', async () => {
    const f = await fixture()
    await f.put('hls/index.m3u8', vod('index0.ts', 'index1.ts'))
    await f.put('hls/index0.ts', segment(3))
    await f.put('hls/index1.ts', segment(5))
    const opened = await ready(f, 'hls/index.m3u8')
    expect(opened).toMatchObject({ kind: 'playlist', mimeType: 'application/vnd.apple.mpegurl' })
    const playlist = await get(opened.url, { 'Sec-Fetch-Dest': 'video' })
    expect(playlist.status).toBe(200)
    expect(playlist.headers['content-type']).toBe('application/vnd.apple.mpegurl')
    expect(playlist.body.toString()).toBe(vod('index0.ts', 'index1.ts'))
    expect(playlist.headers['access-control-allow-origin']).toBeUndefined()
    const started = Date.now()
    expect((await get(opened.url)).status).toBe(200)
    expect(Date.now() - started).toBeLessThan(500)
    const first = await get(new URL('index0.ts', opened.url).href, { 'Sec-Fetch-Dest': 'video' })
    expect(first.status).toBe(200)
    expect(first.headers['content-type']).toBe('video/mp2t')
    expect(first.body).toEqual(segment(3))
    const part = await get(new URL('index1.ts', opened.url).href, { Range: 'bytes=10-19' })
    expect(part.status).toBe(206)
    expect(part.headers['content-range']).toBe('bytes 10-19/1880')
    expect(part.body).toEqual(segment(5).subarray(10, 20))
    expect((await get(new URL('index1.ts', opened.url).href, { Range: 'bytes=1880-' })).status).toBe(416)
    expect(f.streams.status(opened.id)).toEqual({ state: 'active' })
  })

  it('admits a variant and its ../ segments only after the playlist naming them was served', async () => {
    const f = await fixture()
    await f.put('hls/master.m3u8', ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000', 'v0/index.m3u8', ''].join('\n'))
    await f.put('hls/v0/index.m3u8', vod('../seg/片 段.ts'))
    await f.put('hls/seg/片 段.ts', segment(7))
    const opened = await ready(f, 'hls/master.m3u8')
    const variant = new URL('v0/index.m3u8', opened.url).href, media = new URL('../seg/片 段.ts', variant).href
    expect((await get(variant)).status).toBe(404)
    expect((await get(opened.url)).status).toBe(200)
    expect((await get(media)).status).toBe(404)
    expect((await get(variant)).body.toString()).toBe(vod('../seg/片 段.ts'))
    const bytes = await get(media)
    expect(bytes.status).toBe(200)
    expect(bytes.body).toEqual(segment(7))
    expect(f.streams.status(opened.id)).toEqual({ state: 'active' })
  })

  it('serves an fMP4 initialization map and its segments with their own types', async () => {
    const f = await fixture()
    await f.put('hls/fmp4.m3u8', vod('s0.m4s').replace('#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"'))
    await f.put('hls/init.mp4', segment(11))
    await f.put('hls/s0.m4s', segment(13))
    const opened = await ready(f, 'hls/fmp4.m3u8')
    expect((await get(opened.url)).status).toBe(200)
    const init = await get(new URL('init.mp4', opened.url).href)
    expect([init.status, init.headers['content-type']]).toEqual([200, 'video/mp4'])
    expect(init.body).toEqual(segment(11))
    const media = await get(new URL('s0.m4s', opened.url).href)
    expect([media.status, media.headers['content-type']]).toEqual([200, 'video/iso.segment'])
  })

  it('refuses a playlist naming an absolute address and records it, then plays again once the playlist is fixed', async () => {
    const f = await fixture()
    await f.put('hls/index.m3u8', vod('a.ts'))
    await f.put('hls/a.ts', segment(2))
    const opened = await ready(f, 'hls/index.m3u8')
    const cases = [vod('http://127.0.0.1:9/a.ts'), vod('//cdn.example/a.ts'), vod('/hls/a.ts'),
      vod('a.ts').replace('#EXT-X-VERSION:3', '#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k"'),
      vod('a.ts').replace('#EXT-X-VERSION:3', '#EXT-X-VERSION:3\n#EXT-X-MAP:URI="file:///etc/hosts"')]
    expect(cases).toHaveLength(5)
    for (const body of cases) {
      await f.put('hls/index.m3u8', body)
      const refused = await get(opened.url)
      expect(refused.status).toBe(422)
      expect(refused.body.toString()).not.toContain('#EXTM3U')
      expect(f.streams.status(opened.id)).toEqual({ state: 'external-reference', path: 'hls/index.m3u8' })
    }
    await f.put('hls/index.m3u8', vod('a.ts'))
    expect((await get(opened.url)).status).toBe(200)
    expect(f.streams.status(opened.id)).toEqual({ state: 'active' })
    expect((await get(new URL('a.ts', opened.url).href)).body).toEqual(segment(2))
  })

  it('plays a playlist that also names a resource it does not serve, refusing only that resource', async () => {
    const f = await fixture()
    await f.put('hls/index.m3u8', vod('a.ts', 'enc.key'))
    await f.put('hls/a.ts', segment(2))
    await f.put('hls/enc.key', 'secret key bytes')
    const opened = await ready(f, 'hls/index.m3u8')
    expect((await get(opened.url)).status).toBe(200)
    expect((await get(new URL('a.ts', opened.url).href)).body).toEqual(segment(2))
    const key = await get(new URL('enc.key', opened.url).href)
    expect(key.status).toBe(422)
    expect(key.body.toString()).not.toContain('secret')
    expect(f.streams.status(opened.id)).toEqual({ state: 'unsupported-resource', path: 'hls/enc.key' })
    // An unlisted file beside it is still out of scope, whatever its type.
    expect((await get(new URL('run.sh', opened.url).href)).status).toBe(404)
  })

  it('answers an unreferenced sibling or a missing listed segment with 404 and keeps the lease playing', async () => {
    const f = await fixture()
    await f.put('hls/index.m3u8', vod('a.ts', 'gone.ts'))
    await f.put('hls/a.ts', segment(2))
    await f.put('hls/sibling.ts', segment(9))
    const opened = await ready(f, 'hls/index.m3u8')
    expect((await get(opened.url)).status).toBe(200)
    const probe = await get(new URL('sibling.ts', opened.url).href)
    expect(probe.status).toBe(404)
    expect(probe.body.equals(segment(9))).toBe(false)
    expect((await get(new URL('gone.ts', opened.url).href)).status).toBe(404)
    // The miss is recorded as retryable, so a player error now explains itself; it never ends the lease.
    expect(f.streams.status(opened.id)).toEqual({ state: 'transient', path: 'hls/gone.ts', code: 'ENOENT' })
    expect((await get(new URL('a.ts', opened.url).href)).status).toBe(200)
    expect(f.streams.status(opened.id)).toEqual({ state: 'active' })
  })

  it('refuses a listed segment whose link leaves the real Workspace root', async () => {
    const f = await fixture()
    await writeFile(join(f.base, 'outside.ts'), 'outside secret')
    await symlink(join(f.base, 'outside.ts'), join(f.root, 'hls/escape.ts'))
    await f.put('hls/index.m3u8', vod('escape.ts'))
    const opened = await ready(f, 'hls/index.m3u8')
    expect((await get(opened.url)).status).toBe(200)
    const escaped = await get(new URL('escape.ts', opened.url).href)
    expect(escaped.status).toBe(403)
    expect(escaped.body.toString()).not.toContain('outside secret')
    expect(f.streams.status(opened.id)).toEqual({ state: 'outside-workspace', path: 'hls/escape.ts' })
  })

  it('refuses a playlist beyond the owner read budget as a read error instead of serving part of it', async () => {
    const f = await fixture()
    await f.put('hls/index.m3u8', vod('a.ts'))
    const opened = await ready(f, 'hls/index.m3u8')
    await f.put('hls/index.m3u8', Buffer.alloc(16 * 1024 * 1024 + 1, 0x23))
    expect((await get(opened.url)).status).toBe(413)
    expect(f.streams.status(opened.id)).toEqual({ state: 'read-error', path: 'hls/index.m3u8', code: 'WORKSPACE_FILE_BYTE_LIMIT' })
    expect(await f.streams.open(f.workspace, 'hls/index.m3u8')).toMatchObject({ status: 'unavailable', code: 'WORKSPACE_FILE_BYTE_LIMIT' })
  })

  it('reports a deleted playlist as deleted', async () => {
    const f = await fixture()
    await f.put('hls/index.m3u8', vod('a.ts'))
    const opened = await ready(f, 'hls/index.m3u8')
    expect((await get(opened.url)).status).toBe(200)
    await rm(join(f.root, 'hls/index.m3u8'))
    expect((await get(opened.url)).status).toBe(404)
    expect(f.streams.status(opened.id)).toEqual({ state: 'deleted', path: 'hls/index.m3u8' })
  })
})

describe('retryable refusals', () => {
  it('a playlist rewritten during every read is recorded as transient, so the player offers Retry instead of a codec verdict', async () => {
    const f = await fixture()
    await f.put('hls/live.m3u8', live(0, 'live0.ts'))
    await f.put('hls/live0.ts', segment(1))
    const opened = await ready(f, 'hls/live.m3u8')
    vi.spyOn(f.files, 'readMediaPlaylist').mockRejectedValueOnce(Object.assign(new Error('rewritten'), { code: 'WORKSPACE_FILE_CHANGED_WHILE_READING' }))
    const refused = await get(opened.url)
    expect(refused.status).toBe(503)
    expect(f.streams.status(opened.id)).toEqual({ state: 'transient', path: 'hls/live.m3u8', code: 'WORKSPACE_FILE_CHANGED_WHILE_READING' })
    expect((await get(opened.url)).status).toBe(200)
    expect(f.streams.status(opened.id)).toEqual({ state: 'active' })
  })
})

describe('live playlist pacing', () => {
  it('serves an appended segment on the next reload without waiting', async () => {
    const f = await fixture()
    await f.put('hls/live.m3u8', live(0, 'live0.ts'))
    await f.put('hls/live0.ts', segment(2))
    const opened = await ready(f, 'hls/live.m3u8')
    expect((await get(opened.url)).body.toString()).toBe(live(0, 'live0.ts'))
    expect((await get(new URL('live1.ts', opened.url).href)).status).toBe(404)
    await f.put('hls/live1.ts', segment(4))
    await f.put('hls/live.m3u8', live(1, 'live1.ts'))
    const started = Date.now(), next = await get(opened.url)
    expect(Date.now() - started).toBeLessThan(500)
    expect(next.body.toString()).toBe(live(1, 'live1.ts'))
    expect((await get(new URL('live1.ts', opened.url).href)).body).toEqual(segment(4))
    // The window dropped live0; the player may still ask for it once, and the lease keeps playing.
    await rm(join(f.root, 'hls/live0.ts'))
    expect((await get(new URL('live0.ts', opened.url).href)).status).toBe(404)
    expect(f.streams.status(opened.id)).toMatchObject({ state: 'transient', path: 'hls/live0.ts' })
    expect((await get(opened.url)).status).toBe(200)
    expect(f.streams.status(opened.id)).toEqual({ state: 'active' })
  })

  it('holds an unchanged reload about half a target duration, and answers early when the playlist changes', async () => {
    const f = await fixture()
    await f.put('hls/live.m3u8', live(0, 'live0.ts'))
    const opened = await ready(f, 'hls/live.m3u8')
    const first = await get(opened.url)
    // While an unchanged reload is held, only a cheap stamp is checked; no full confined read happens.
    const reads = vi.spyOn(f.files, 'readMediaPlaylist')
    const held = await get(opened.url)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(held.at - first.at).toBeGreaterThanOrEqual(900)
    expect(held.at - first.at).toBeLessThan(1600)
    expect(held.body.toString()).toBe(live(0, 'live0.ts'))
    const pending = get(opened.url), started = Date.now()
    setTimeout(() => { void f.put('hls/live.m3u8', live(1, 'live1.ts')) }, 300)
    const changed = await pending
    expect(changed.at - started).toBeLessThan(900)
    expect(changed.body.toString()).toBe(live(1, 'live1.ts'))
    // The list that arrived while held is the one scanned: what it names is admitted.
    await f.put('hls/live1.ts', segment(4))
    expect((await get(new URL('live1.ts', opened.url).href)).body).toEqual(segment(4))
  })

  it('stops holding once the encoder ends the list', async () => {
    const f = await fixture()
    await f.put('hls/live.m3u8', live(0, 'live0.ts'))
    const opened = await ready(f, 'hls/live.m3u8')
    await get(opened.url)
    await f.put('hls/live.m3u8', live(0, 'live0.ts') + '#EXT-X-ENDLIST\n')
    const ended = await get(opened.url)
    expect(ended.body.toString()).toContain('#EXT-X-ENDLIST')
    const again = await get(opened.url)
    expect(again.status).toBe(200)
    expect(again.at - ended.at).toBeLessThan(500)
  })

  it('never holds an unchanged master playlist reload', async () => {
    const f = await fixture()
    await f.put('hls/master.m3u8', ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000', 'v0/index.m3u8', ''].join('\n'))
    const opened = await ready(f, 'hls/master.m3u8')
    const first = await get(opened.url), again = await get(opened.url)
    expect(again.status).toBe(200)
    expect(again.at - first.at).toBeLessThan(500)
  })

  it('ends a held reply promptly when the lease is released', async () => {
    const f = await fixture()
    await f.put('hls/live.m3u8', live(0, 'live0.ts'))
    const opened = await ready(f, 'hls/live.m3u8')
    await get(opened.url)
    const reads = vi.spyOn(f.files, 'readMediaPlaylist'), readsBefore = reads.mock.calls.length
    let releasedAt = 0, readsAtRelease = 0
    const outcome = await new Promise<{ result: string; at: number }>(resolve => {
      const req = request(new URL(opened.url), response => {
        response.on('end', () => resolve({ result: `replied ${response.statusCode}`, at: Date.now() }))
        response.on('error', () => resolve({ result: 'aborted', at: Date.now() }))
        response.resume()
      })
      req.on('error', () => resolve({ result: 'aborted', at: Date.now() }))
      req.end()
      setTimeout(() => { releasedAt = Date.now(); readsAtRelease = reads.mock.calls.length; f.streams.release(opened.id) }, 300)
    })
    expect(outcome.result).toBe('aborted')
    expect(outcome.at - releasedAt).toBeLessThan(300)
    // The held reply re-checked the playlist while waiting, and stops once released.
    expect(readsAtRelease).toBeGreaterThan(readsBefore)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(reads.mock.calls.length).toBe(readsAtRelease)
    expect(f.streams.status(opened.id)).toEqual({ state: 'released' })
    expect((await get(opened.url)).status).toBe(404)
  })
})
