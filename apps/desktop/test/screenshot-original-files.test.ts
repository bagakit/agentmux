import { mkdtemp, readFile, writeFile, rm, chmod, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScreenshotOriginalFiles } from '../src/main/screenshot-original-files'
import { createEditableAnnotationDocument, encodeEditableAnnotationDocument } from '../src/renderer/src/components/image-annotation/document'
import { ANNOTATION_DOCUMENT_LIMITS } from '../src/renderer/src/components/browser-screenshot/document-files'

const image = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
function original(text = 'Original\nsecond line') {
  return encodeEditableAnnotationDocument(createEditableAnnotationDocument({ image, shapes: [{ id: 'text', kind: 'text', color: '#123456',
    fontSize: .1, at: { x: .1, y: .1 }, text }], crop: null, source: null }, ANNOTATION_DOCUMENT_LIMITS), ANNOTATION_DOCUMENT_LIMITS)
}
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-screenshot-original-')); directories.push(directory)
  const path = join(directory, 'original.json'), chooseOpen = vi.fn(async () => path as string | null), chooseSave = vi.fn(async () => path as string | null)
  const worker = { helperPath: resolve('apps/desktop/resources/bin/agentmux-workspace-move') }
  return { directory, path, chooseOpen, chooseSave, worker, owner: new ScreenshotOriginalFiles({ chooseOpen, chooseSave, worker }) }
}

describe('system screenshot original native file grants', () => {
  it('writes and reopens only a native-chosen file through the actual revision-aware file owner', async () => {
    const { path, owner, chooseSave } = await setup(), content = original()
    const saved = await owner.save({ content })
    expect(saved.status, JSON.stringify(saved)).toBe('saved')
    if (saved.status !== 'saved') throw new Error('Native file was not saved')
    expect(chooseSave).toHaveBeenCalledExactlyOnceWith('Screenshot.agentmux-annotation.json')
    expect(await readFile(path, 'utf8')).toBe(content)
    const opened = await owner.open()
    expect(opened).toMatchObject({ status: 'read', content, file: { path, revision: saved.file.revision } })
    expect(opened.status === 'read' && opened.file.grantId).not.toBe(saved.file.grantId)
    const foreign = await owner.save({ content, file: { grantId: 'ungranted-renderer-path', expectedRevision: saved.file.revision } })
    expect(foreign.status).toBe('error')
    expect(await readFile(path, 'utf8')).toBe(content)
    owner.dispose()
    expect((await owner.inspect(saved.file.grantId)).status).toBe('error')
  })

  it('preserves an externally changed original instead of overwriting it with an earlier revision', async () => {
    const { path, owner } = await setup(), content = original()
    await writeFile(path, content)
    const opened = await owner.open(); expect(opened.status).toBe('read')
    if (opened.status !== 'read') throw new Error('Original file was not read')
    const external = original('External author retained'); await writeFile(path, external)
    const result = await owner.save({ content: original('New editor draft'), file: { grantId: opened.file.grantId, expectedRevision: opened.file.revision } })
    expect(result.status, 'actual native CAS must reject the stale original').toBe('conflict')
    expect(await readFile(path, 'utf8')).toBe(external)
    expect((await owner.save({ content: original('Forged newer revision'), file: { grantId: opened.file.grantId, expectedRevision: 'invented' } })).status).toBe('error')
  })

  it.each([false, true])('retains an unknown completed write and checks its exact original grant without another write (removed=%s)', async removed => {
    const { directory, path, worker, chooseOpen, chooseSave } = await setup()
    const wrapper = join(directory, 'original-worker.mjs'), marker = join(directory, 'dropped-receipt')
    // Delegate the real native operation and lose only its first successful write response.
    await writeFile(wrapper, `#!/usr/bin/env node\nimport {spawn} from 'node:child_process';import {existsSync,writeFileSync} from 'node:fs';\nconst child=spawn(${JSON.stringify(worker.helperPath)},process.argv.slice(2),{stdio:['pipe','pipe','inherit']});let output='';process.stdin.pipe(child.stdin);child.stdout.on('data',bytes=>output+=bytes);child.on('exit',code=>{if(code===0&&process.argv[3]==='write'&&!existsSync(${JSON.stringify(marker)})){writeFileSync(${JSON.stringify(marker)},'dropped');process.exit(1)}process.stdout.write(output);process.exitCode=code??1});\n`)
    await chmod(wrapper, 0o700)
    const owner = new ScreenshotOriginalFiles({ chooseOpen, chooseSave, worker: { helperPath: wrapper } }), content = original('Saved despite lost receipt')
    const result = await owner.save({ content })
    expect(result.status, 'actual write response loss must stay unknown').toBe('unknown')
    if (result.status !== 'unknown' || !result.file) throw new Error('The original unknown grant was not retained')
    expect(await readFile(path, 'utf8')).toBe(content)
    expect((await owner.save({ content: original('Must not retry'), file: { grantId: result.file.grantId, expectedRevision: result.file.revision } })).status).toBe('unknown')
    expect(await readFile(path, 'utf8')).toBe(content)
    if (removed) await unlink(path)
    const checked = await owner.inspect(result.file.grantId)
    expect(checked).toMatchObject(removed ? { status: 'absent', verification: 'unchanged', file: { revision: null } } : { status: 'read', content, verification: 'saved' })
    expect(chooseSave).toHaveBeenCalledOnce()
    if (checked.status !== 'read' && checked.status !== 'absent') throw new Error('The original write was not checked')
    expect((await owner.save({ content: original('Explicit newer save'), file: { grantId: checked.file.grantId, expectedRevision: checked.file.revision } })).status).toBe('saved')
  })

  it('cancels without a file operation and refuses malformed or oversized originals while preserving the chosen bytes', async () => {
    const { path, owner, chooseOpen, chooseSave } = await setup()
    chooseSave.mockResolvedValueOnce(null)
    expect(await owner.save({ content: original() })).toEqual({ status: 'cancelled' })
    expect((await owner.save({ content: '{"not":"an annotation"}' })).status).toBe('error')
    expect(chooseSave).toHaveBeenCalledOnce()
    await writeFile(path, 'x'.repeat(ANNOTATION_DOCUMENT_LIMITS.maxDocumentBytes + 1))
    expect((await owner.open()).status).toBe('error')
    expect((await readFile(path)).byteLength).toBe(ANNOTATION_DOCUMENT_LIMITS.maxDocumentBytes + 1)
    chooseOpen.mockResolvedValueOnce(null)
    expect(await owner.open()).toEqual({ status: 'cancelled' })
  })
})
