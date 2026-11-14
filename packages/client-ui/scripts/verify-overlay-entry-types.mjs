import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const entries = {
  modal: `import * as Modal from '@agentmux/client-ui/components/Modal'
    import { ClientUiOverlayProvider, type ClientUiOverlayHost } from '@agentmux/client-ui/overlay-host'
    const host: ClientUiOverlayHost = { ownerDocument: document, overlayContainer: () => document.body }
    export const example = <ClientUiOverlayProvider host={host}><Modal.Root>
      <Modal.Trigger>Open</Modal.Trigger><Modal.Portal>
        <Modal.Overlay /><Modal.Content onCloseAutoFocus={event => { if (document.hidden) event.preventDefault() }}>
          <Modal.Title>Edit title</Modal.Title><Modal.Close>Close</Modal.Close>
        </Modal.Content>
      </Modal.Portal>
    </Modal.Root></ClientUiOverlayProvider>`,
  dropdown: `import * as Menu from '@agentmux/client-ui/components/DropdownMenu'
    import { ClientUiOverlayProvider, type ClientUiOverlayHost } from '@agentmux/client-ui/overlay-host'
    const host: ClientUiOverlayHost = { ownerDocument: document, overlayContainer: () => document.body }
    export const example = <ClientUiOverlayProvider host={host}><Menu.Root modal={false}>
      <Menu.Trigger>File actions</Menu.Trigger><Menu.Portal><Menu.Content>
        <Menu.Item onSelect={() => document.body.dataset.saved = 'true'}>Save original</Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root></ClientUiOverlayProvider>`,
  menu: `import * as Menu from '@agentmux/client-ui/components/HoverDropdownMenu'
    import { ClientUiOverlayProvider, type ClientUiOverlayHost } from '@agentmux/client-ui/overlay-host'
    const host: ClientUiOverlayHost = { ownerDocument: document, overlayContainer: () => document.body }
    export const example = <ClientUiOverlayProvider host={host}><Menu.Root>
      <Menu.Trigger>Item actions</Menu.Trigger><Menu.Portal><Menu.Content>
        <Menu.Item onSelect={() => document.body.dataset.saved = 'true'}>Duplicate</Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root></ClientUiOverlayProvider>`
}

const forbidden = /\/(?:apps\/|packages\/(?:core|editor-extensions|host)\/|packages\/client-ui\/src\/(?:note|terminal)\/|node_modules\/(?:@tiptap\/|@xterm\/|@agentmux\/core\/))/
function compile(name, text, mutate = false) {
  const fixture = resolve(root, 'neutral-overlay-' + name + '.tsx')
  const overlay = resolve(root, 'src/overlay-host.tsx')
  const options = {
    noEmit: true, strict: true, skipLibCheck: true, types: [],
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
  }
  const host = ts.createCompilerHost(options)
  const read = host.readFile.bind(host)
  const exists = host.fileExists.bind(host)
  host.fileExists = path => path === fixture || exists(path)
  host.readFile = path => {
    if (path === fixture) return text
    const source = read(path)
    return mutate && path === overlay ? source + "\nexport type InjectedBusinessType = import('@agentmux/core').AgentProviderId\n" : source
  }
  const program = ts.createProgram([fixture], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  const sources = program.getSourceFiles().map(file => file.fileName)
  assert.ok(sources.includes(overlay), 'Compile the real public Overlay host')
  assert.ok(sources.some(file => file.endsWith('/components/' + ({ menu: 'HoverDropdownMenu', dropdown: 'DropdownMenu', modal: 'Modal' }[name]) + '.tsx')), 'Compile the actual published component entry')
  const domainSources = sources.filter(file => forbidden.test(file))
  if (mutate) {
    assert.ok(domainSources.length > 0 || diagnostics.some(diagnostic => String(diagnostic.messageText).includes('@agentmux/core')),
      'A business type injected at the public host boundary must be visible to the same compiler')
  } else {
    assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
      getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n'
    }))
    assert.deepEqual(domainSources, [], 'Neutral React and DOM consumers must compile without business dependencies')
  }
}
for (const [name, text] of Object.entries(entries)) compile(name, text)
compile('modal', entries.modal, true)
console.log('Public Overlay entries compile independently; a privately injected Core type was detected.')
