const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

module.exports = async function captureWorkingDirectory({ win, read, until, waitFor, settle, click, frame, owner, store, created, raw, home }) {
  const field = '[aria-label="Fixed working directory"]'
  const save = '.toolkit-editor__footer .primary-button'
  const value = selector => read(`document.querySelector(${JSON.stringify(selector)}).value`)
  await read(`window.directoryInputEvents=[];for(const type of ['focusin','focusout','beforeinput','input'])document.addEventListener(type,event=>{const target=event.target;window.directoryInputEvents.push({type:event.type,inputType:event.inputType,data:event.data,trusted:event.isTrusted,value:target.value,target:target.tagName+'.'+target.className,focused:document.activeElement===target,documentHasFocus:document.hasFocus()})},true)`)
  const fill = async (selector, text) => {
    const facts = async () => ({ ...await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),a=document.activeElement;return {value:n?.value,focused:a===n,active:a?.tagName+'.'+a?.className,selectionStart:n?.selectionStart,selectionEnd:n?.selectionEnd,documentHasFocus:document.hasFocus(),eventCount:window.directoryInputEvents.length}})()`), webContentsFocused: win.webContents.isFocused() })
    const observation = { selector, text }
    ;(raw.directoryInputs ??= []).push(observation)
    try {
      await click(selector)
      await until(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`)
      win.webContents.selectAll()
      await until(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n.selectionStart===0 && n.selectionEnd===n.value.length})()`)
      raw.actions.push({ type: 'native-select-all', selector })
      observation.before = await facts()
      await win.webContents.insertText(text)
      raw.actions.push({ type: 'native-insert-text', selector, text })
      await until(`document.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(text)}`)
      await settle()
    } finally {
      observation.after = await facts()
      observation.events = await read(`window.directoryInputEvents.slice(${observation.before?.eventCount ?? 0})`)
    }
    assert.ok(observation.events.some(event => event.type === 'input' && event.trusted && event.value === text), 'Native replacement reaches the actual input')
  }
  const revealField = async () => { await read(`document.querySelector(${JSON.stringify(field)}).scrollIntoView({block:'center'})`); await settle() }
  const saveAndRead = async (expected, kind) => {
    const id = await read('document.querySelector("[data-tool-editor]").dataset.toolEditor')
    await click(save)
    await waitFor(() => owner.current.toolkit?.tools?.some(tool => tool.id === id && tool.workspacePath === expected), 'Authoritative owner accepts the exact expanded directory')
    await until(`document.querySelector(${JSON.stringify(field)}).value === ${JSON.stringify(expected)}`)
    const saved = owner.current.toolkit.tools.find(tool => tool.id === id)
    if (kind.startsWith('inline-')) { assert.equal(saved.mode, 'tui'); assert.equal(saved.enabled, false) }
    const persisted = (await store.get()).toolkit.tools.find(tool => tool.id === id)
    assert.deepEqual(persisted, saved, 'The same absolute configuration is persisted')
    if (!created.includes(id)) created.push(id)
    raw.directorySaves.push({ kind, saved, persisted })
    return id
  }
  raw.directorySaves = []
  raw.folderDialog = { exercised: false, qualification: 'Native dialog target and cancellation are covered by the registered Main IPC test; this scene does not substitute a controlled dialog for OS visual evidence.' }
  const workspaces = structuredClone(owner.current.workspaces)
  await click('.surface-navigation [aria-label="Settings"]')
  await until('!!document.querySelector("nav [data-settings-target=toolkit]")')
  await click('nav [data-settings-target="toolkit"]')
  await click('.toolkit-workbench__toolbar .toolkit-workbench__create')
  await until('!!document.querySelector(".monaco-editor")')
  await fill('.toolkit-editor__name input', 'Workspace terminal')
  await click('.toolkit-editor__mode input[value="tui"]')
  await click('.toolkit-editor__fields > .toolkit-editor__toggle input')
  assert.equal(await value(field), '~/.agentmux')
  await until('!!document.querySelector(".toolkit-directory__preview code")')
  assert.equal(await read('document.querySelector(".toolkit-directory__preview code").textContent'), home + '/.agentmux')
  await revealField(); await frame('directory-default-wide')
  win.setSize(720, 940)
  await until('innerWidth <= 720'); await revealField(); await frame('directory-default-narrow')
  await saveAndRead(home + '/.agentmux', 'inline-default')

  await fill(field, 'projects/reports')
  assert.equal(await read(`document.querySelector(${JSON.stringify(field)}).getAttribute('aria-invalid')`), 'true')
  assert.equal(await read(`document.querySelector(${JSON.stringify(save)}).disabled`), true)
  assert.ok(await read('document.querySelector(".toolkit-editor__directory .settings-inline-error").textContent.includes("Relative paths have no fixed base")'))
  await revealField(); await frame('directory-invalid-narrow')
  await fill(field, '$HOME/Work spaces/../reports')
  assert.equal(await read('document.querySelector(".toolkit-directory__preview code").textContent'), home + '/Work spaces/../reports')
  await saveAndRead(home + '/Work spaces/../reports', 'inline-home-prefix')
  win.setSize(1440, 940)
  await until('innerWidth >= 1440'); await revealField(); await frame('directory-expanded-wide')

  const extension = path.join(home, 'Extensions', 'Workspace report')
  fs.mkdirSync(extension, { recursive: true })
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({ schema: 'agentmux.toolkit.package.v1', name: 'Workspace report', icon: 'terminal', entry: 'report.mjs' }))
  fs.writeFileSync(path.join(extension, 'report.mjs'), "console.log('Directory report ready')\n")
  await click('.toolkit-workbench__toolbar > .small-button')
  await fill('[aria-label="Package directory"]', extension)
  assert.equal(await value(field), '~/.agentmux')
  await revealField(); await frame('directory-package-wide')
  await saveAndRead(home + '/.agentmux', 'package-default')
  await until('document.querySelector(".toolkit-package__identity h3")?.textContent === "Workspace report"')
  win.setSize(720, 940)
  await until('innerWidth <= 720'); await revealField(); await frame('directory-package-narrow')
  assert.deepEqual(owner.current.workspaces, workspaces, 'Editing Toolkit directories does not register or change workspaces')
  raw.workspacesUnchanged = true
  assert.equal(raw.directoryInputs.length, 4, 'All directory scene text edits have native input receipts')
}
