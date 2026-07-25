import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type { WorkspaceRecord } from '../src/shared/contracts.js'

// EditorPane opens with `import '../monaco'`, whose real module pulls Vite `?worker` graphs that a
// plain vitest run cannot resolve. Stub the side-effect import and the Monaco editor component so the
// failure-state assembly (the only path under test) renders without a browser editor context.
vi.mock('../src/renderer/src/monaco.js', () => ({}))
vi.mock('@monaco-editor/react', () => ({
  default: () => null
}))

const fixture = vi.hoisted(() => ({
  state: {
    documents: {} as Record<string, unknown>,
    dirtyDocuments: {} as Record<string, boolean>,
    documentIssues: {} as Record<string, unknown>,
    savingDocuments: {} as Record<string, boolean>,
    documentRevealTargets: {} as Record<string, unknown>,
    config: { workspaces: [] as WorkspaceRecord[] },
    updateDocument: vi.fn(),
    saveDocument: vi.fn(),
    reloadDocument: vi.fn(),
    overwriteDocument: vi.fn(),
    clearDocumentRevealTarget: vi.fn(),
    reportError: vi.fn()
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

const filesApi = vi.hoisted(() => ({
  reveal: vi.fn(async () => {})
}))

vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: { files: filesApi }
}))

import {
  EditorPane,
  EditorUnavailableState,
  revealFileInFileManager
} from '../src/renderer/src/components/EditorPane.js'
import { WorkspaceFiles, localExistingAncestorWithin } from '../src/main/workspace-files.js'

const localWorkspace: WorkspaceRecord = {
  id: 'workspace',
  name: 'Project',
  hostId: 'local',
  path: '/repo',
  kind: 'folder'
}

const remoteWorkspace: WorkspaceRecord = {
  id: 'remote',
  name: 'Server',
  hostId: 'server-ssh',
  path: '/srv/project',
  kind: 'folder'
}

function fileSurface(workspaceId: string, path: string) {
  return { regionId: 'region', kind: 'file' as const, workspaceId, path }
}

afterEach(() => {
  filesApi.reveal.mockReset()
  filesApi.reveal.mockResolvedValue(undefined)
  fixture.state.reportError.mockReset()
  fixture.state.config.workspaces = []
  fixture.state.documents = {}
})

describe('EditorUnavailableState', () => {
  it('offers a Reveal action for the unopenable file when reveal can land', () => {
    const markup = renderToStaticMarkup(
      createElement(EditorUnavailableState, { canReveal: true, onReveal: vi.fn() })
    )
    // The existing dead-end copy stays; the reveal action is what turns it into an exit.
    expect(markup).toContain('File is no longer available')
    expect(markup).toContain('Reveal in Finder')
    expect(markup).toContain('<button')
  })

  it('omits the action entirely — never a disabled shell — when reveal cannot work', () => {
    const markup = renderToStaticMarkup(
      createElement(EditorUnavailableState, { canReveal: false, onReveal: vi.fn() })
    )
    expect(markup).toContain('File is no longer available')
    expect(markup).not.toContain('Reveal in Finder')
    expect(markup).not.toContain('<button')
  })

  it('invokes onReveal when the action fires', () => {
    const onReveal = vi.fn()
    const element = EditorUnavailableState({ canReveal: true, onReveal }) as unknown as {
      props: { children: [unknown, unknown, { props: { onClick: () => void } }] }
    }
    element.props.children[2].props.onClick()
    expect(onReveal).toHaveBeenCalledTimes(1)
  })
})

describe('revealFileInFileManager', () => {
  it('routes through the existing api.files.reveal channel — no second path resolution', async () => {
    const reportError = vi.fn()
    await revealFileInFileManager('workspace', 'src/gone.ts', reportError)
    expect(filesApi.reveal).toHaveBeenCalledWith('workspace', 'src/gone.ts')
    expect(reportError).not.toHaveBeenCalled()
  })

  it('surfaces a reveal failure through reportError instead of throwing or a second error state', async () => {
    const boom = new Error('reveal blew up')
    filesApi.reveal.mockRejectedValueOnce(boom)
    const reportError = vi.fn()
    await expect(revealFileInFileManager('workspace', 'src/gone.ts', reportError)).resolves.toBeUndefined()
    expect(reportError).toHaveBeenCalledWith(boom)
  })
})

describe('EditorPane failure state wiring', () => {
  it('shows the Reveal action for a missing document in a local workspace', () => {
    fixture.state.config.workspaces = [localWorkspace]
    const markup = renderToStaticMarkup(
      createElement(EditorPane, { tabId: 'tab', surface: fileSurface('workspace', 'src/gone.ts') })
    )
    expect(markup).toContain('File is no longer available')
    expect(markup).toContain('Reveal in Finder')
  })

  it('withholds the Reveal action for a remote (non-local) workspace', () => {
    fixture.state.config.workspaces = [remoteWorkspace]
    const markup = renderToStaticMarkup(
      createElement(EditorPane, { tabId: 'tab', surface: fileSurface('remote', 'src/gone.ts') })
    )
    expect(markup).toContain('File is no longer available')
    expect(markup).not.toContain('Reveal in Finder')
  })
})

// The reveal channel this action shares (localPathForReveal) must survive a deleted target: a file
// being gone is the most common reason it "won't open", and the fallback below is exactly what keeps
// the action from turning into a second error. These exercise the real inline worker on a temp tree.
describe('WorkspaceFiles reveal fallback for the failure state', () => {
  const revealRoots: string[] = []

  function localHost(): ExecutionHost {
    return {
      id: 'local',
      kind: 'local',
      label: 'Local',
      run: vi.fn(),
      exposeLoopbackPort: async (port) => port,
      dispose: async () => {}
    }
  }

  async function revealWorkspace(label: string): Promise<{ root: string; workspace: WorkspaceRecord }> {
    const fixtureDir = await mkdtemp(join(tmpdir(), `agentmux-${label}-`))
    revealRoots.push(fixtureDir)
    const root = join(fixtureDir, 'workspace')
    await mkdir(root)
    return {
      root,
      workspace: { id: label, name: label, hostId: 'local', path: root, kind: 'folder' }
    }
  }

  afterEach(async () => {
    await Promise.all(revealRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('reveals a deleted file by falling back to its nearest existing ancestor directory', async () => {
    const { root, workspace } = await revealWorkspace('reveal-deleted')
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    const files = new WorkspaceFiles(() => localHost())

    // The file and its immediate parent never existed; reveal must climb to the folder that does.
    const revealed = await files.localPathForReveal(workspace, 'src/nested/gone/missing.ts')
    expect(revealed).toBe(await realpath(join(root, 'src', 'nested')))
  })

  it('falls all the way back to the workspace root when the whole subtree is gone', async () => {
    const { root, workspace } = await revealWorkspace('reveal-root')
    const files = new WorkspaceFiles(() => localHost())

    const revealed = await files.localPathForReveal(workspace, 'never/here/at/all.ts')
    expect(revealed).toBe(await realpath(root))
  })

  it('still reveals an existing file directly, unchanged by the fallback', async () => {
    const { root, workspace } = await revealWorkspace('reveal-existing')
    await writeFile(join(root, 'present.ts'), 'x')
    const files = new WorkspaceFiles(() => localHost())

    const revealed = await files.localPathForReveal(workspace, 'present.ts')
    expect(revealed).toBe(await realpath(join(root, 'present.ts')))
  })

  it('rejects when the ancestor climb resolves through a symlink that escapes the root', async () => {
    const { root } = await revealWorkspace('reveal-symlink-escape')
    // A directory inside the workspace symlinked to a real location OUTSIDE the root. The reveal
    // target below never exists, so the climb lands on this symlink — whose realpath is outside the
    // workspace. Confinement (assertRealPathWithin) must reject it, not surface a folder outside root.
    //
    // Asserted directly against localExistingAncestorWithin, the helper the confinement line lives in,
    // NOT through localPathForReveal: the local worker spawns with cwd = the resolved dir and applies
    // its OWN 'Path escapes the workspace root' guard, which would mask a removed confinement here and
    // let the mutation survive. This layered assertion is what actually goes red when line 298 is cut.
    const outside = join(root, '..', 'outside-secret')
    await mkdir(outside)
    await symlink(await realpath(outside), join(root, 'escape'), 'dir')

    await expect(localExistingAncestorWithin(root, 'escape/gone.ts')).rejects.toThrow(
      'Path escapes the workspace root'
    )
  })

  it('refuses to reveal on a non-local workspace rather than offer a doomed action', async () => {
    const remote: WorkspaceRecord = {
      id: 'remote',
      name: 'remote',
      hostId: 'remote-ssh',
      path: '/srv/project',
      kind: 'folder'
    }
    const remoteHost: ExecutionHost = { ...localHost(), id: 'remote-ssh', kind: 'ssh' }
    const files = new WorkspaceFiles(() => remoteHost)

    await expect(files.localPathForReveal(remote, 'anything.ts')).rejects.toThrow(
      'Reveal in file manager is available only for local paths'
    )
  })
})

