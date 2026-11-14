const assert = require('node:assert/strict')

async function captureContainerOrder({ win, read, click, frame, until, settle, result }) {
  const project = "[...document.querySelectorAll('[data-project-group-key]')].find(e=>e.dataset.projectGroupKey===JSON.stringify(['local','alpha']))"
  const collection = "[...document.querySelectorAll('[data-focus-container-key]')].find(e=>e.dataset.focusContainerKey===window.appearanceProof.collectionKey)"
  await until('confirmed original two-Topic Collection', () => read(`Boolean(${collection}?.querySelector('[aria-label="Container preferences · Research"]'))`))
  assert.equal(await read(`${project}.dataset.focusZonePresentation`), 'cards', 'Unauthored Project uses Zone tags')
  assert.equal(await read(`${collection}.dataset.focusZonePresentation`), 'sections', 'Unauthored Collection uses Topic sections')
  assert.deepEqual(await read('window.appearanceProof.facts().organizationPreferences'), [], 'Defaults do not write authored container preferences')
  await read(`window.originalOrganizationCards=[...${project}.querySelectorAll('button.focus-context[data-session-id]'),...${collection}.querySelectorAll('button.focus-context[data-session-id]')]`)
  const retained = async label => {
    const value = await read(`(()=>{const current=[...${project}.querySelectorAll('button.focus-context[data-session-id]'),...${collection}.querySelectorAll('button.focus-context[data-session-id]')];return{count:current.length,same:current.length===window.originalOrganizationCards.length&&window.originalOrganizationCards.every(e=>current.includes(e)),preservation:window.appearanceProof.preservation()}})()`)
    assert.ok(value.count > 5 && value.same, 'Exact original task DOM retained: ' + label)
    for (const key of ['sameTabs', 'sameLayouts', 'sameDrafts', 'sameQueues', 'sameRuns']) assert.equal(value.preservation[key], true, key + ': ' + label)
    assert.ok(Object.values(value.preservation.controls).every(count => count === 0), 'Organization changes never control an Agent')
    result.scenarios.push({ label, ...value })
  }
  const change = async (container, label, mode) => {
    await click(`[aria-label="${label}"]`)
    await until('original organization editor', () => read('Boolean(document.querySelector("[data-focus-project-preferences]"))'))
    await click(`[data-focus-project-preferences] [data-focus-zone-presentation="${mode}"]`)
    await click(label.startsWith('Project') ? '[aria-label="Save project preferences"]' : '[aria-label="Save container preferences"]')
    await until('authored original organization saved', () => read(`!document.querySelector('[data-focus-project-preferences]') && ${container}.dataset.focusZonePresentation === ${JSON.stringify(mode)}`))
    const authored = await read(`(()=>{const e=${container},key=e.dataset.focusContainerKey??JSON.stringify(['project','local','alpha']);return window.appearanceProof.facts().organizationPreferences.find(p=>p.key===key)})()`)
    assert.equal(authored?.presentation, mode, 'Original ConfigOwner-backed preference is authored')
    await retained(label + ' → ' + mode)
  }
  const shot = async (kind, container, theme, width, file) => {
    win.setContentSize(width, 900)
    await read(`window.appearanceProof.theme(${JSON.stringify(theme)})`); await settle()
    await read(`${container}.scrollIntoView({block:'start'})`); await settle()
    const headings = await read(`(()=>{const root=${container};return [...root.querySelectorAll('.focus-topic-section')].map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{text:e.textContent,aria:e.getAttribute('aria-label'),width:r.width,height:r.height,weight:s.fontWeight,color:s.color,background:s.backgroundColor}})})()`)
    assert.ok(headings.length >= 2 && headings.every(h => h.text.trim() && h.aria && h.width > 0 && h.height > 0), 'Original named section headings are laid out: ' + kind)
    result.scenarios.push({ label: kind + ' section headings ' + theme + ' ' + width, headings })
    await retained('Before ' + file)
    await frame(file, `${theme} original ${kind} sections at ${width}`, kind === 'Topic' ? 'collection' : 'group')
  }
  await retained('New defaults retain original workface')
  await shot('Topic', collection, 'dark', 1440, 'dark-topic-default-sections-1440.png')
  await shot('Topic', collection, 'light', 420, 'light-topic-default-sections-420.png')
  win.setContentSize(1440, 900); await settle()
  await change(project, 'Project preferences · AgentMux', 'sections')
  await shot('worktree', project, 'dark', 1440, 'dark-worktree-authored-sections-1440.png')
  await shot('worktree', project, 'light', 420, 'light-worktree-authored-sections-420.png')
  await shot('worktree', project, 'dark', 420, 'dark-worktree-authored-sections-420.png')
  win.setContentSize(1440, 900); await settle()
  await change(collection, 'Container preferences · Research', 'cards')
  assert.ok(await read(`${collection}.querySelectorAll('[data-focus-zone-tags]').length >= 2`), 'Authored Collection tags override the section default')
  assert.equal(await read(`${collection}.querySelectorAll('.focus-topic-section').length`), 0)
  await change(collection, 'Container preferences · Research', 'sections')
  await shot('Topic', collection, 'light', 1440, 'light-topic-authored-sections-1440.png')
  await change(project, 'Project preferences · AgentMux', 'cards')
  assert.ok(await read(`${project}.querySelectorAll('[data-focus-zone-tags]').length > 0`), 'Explicit Project tags retain the original footer consumer')
}

module.exports = async function captureOrganization(options) {
  if (options.containerOrder) return captureContainerOrder(options)
  const { win, read, click, frame, until, settle, result } = options
  win.setContentSize(1440, 900); await read("window.appearanceProof.theme('dark')"); await settle()
  const group = "[...document.querySelectorAll('[data-project-group-key]')].find(e=>e.dataset.projectGroupKey===JSON.stringify(['local','alpha']))"
  await read(`(()=>{window.organizationCards=new Map([...${group}.querySelectorAll('button.focus-context[data-session-id]')].map(e=>[e.dataset.sessionId,e]));return true})()`)
  const change = async (trigger, mode, save, container) => {
    await click(trigger)
    await until('original organization editor', () => read('Boolean(document.querySelector("[data-focus-project-preferences]"))'))
    await click(`[data-focus-project-preferences] [data-focus-zone-presentation="${mode}"]`)
    await click(save)
    await until('original organization saved', () => read(`!document.querySelector('[data-focus-project-preferences]') && ${container}.dataset.focusZonePresentation === ${JSON.stringify(mode)}`))
  }
  await change('[aria-label="Project preferences · AgentMux"]', 'cards', '[aria-label="Save project preferences"]', group)
  const stable = await read(`(()=>{const group=${group};return{cards:group.querySelectorAll('button.focus-context[data-session-id]').length,same:[...group.querySelectorAll('button.focus-context[data-session-id]')].every(e=>window.organizationCards.get(e.dataset.sessionId)===e),tags:group.querySelectorAll('[data-focus-zone-tags]').length,sections:group.querySelectorAll('[data-focus-zone-section]').length}})()`)
  assert.ok(stable.same && stable.cards > 3 && stable.tags > 0 && stable.sections === 0, 'Zone tags reuse the original exact card elements')
  result.scenarios.push({ label: 'Project Zone tags retain original cards', ...stable })
  const footerGeometry = async container => read(`(()=>{const root=${container};return [...root.querySelectorAll('[data-focus-zone-footer]')].map(footer=>{const slot=footer.closest('[data-focus-card-key]'),body=slot.querySelector('button.focus-context'),row=footer.querySelector('[data-focus-zone-tags]');const r=footer.getBoundingClientRect(),b=body.getBoundingClientRect();const labels=[...row.querySelectorAll('.focus-context__topic > span,.focus-project-lanes__label strong')];const rects=labels.flatMap(label=>{const range=document.createRange();range.selectNodeContents(label);return [...range.getClientRects()].map(r=>({top:r.top,bottom:r.bottom,height:r.height}))});return{bodyBottom:b.bottom,footerTop:r.top,labels:labels.length,rects,rowHeight:row.getBoundingClientRect().height}})})()`)
  const checkFooters = async (container, label) => {
    const boxes=await footerGeometry(container);assert.ok(boxes.length>0,'Actual Zone footers exist: '+label)
    for(const box of boxes){assert.ok(box.footerTop>=box.bodyBottom,'Zone tags follow original task content: '+label);assert.ok(box.labels>0&&box.rects.length>0,'Original names are actually laid out: '+label);assert.ok(Math.max(...box.rects.map(r=>r.bottom))-Math.min(...box.rects.map(r=>r.top))<=Math.max(...box.rects.map(r=>r.height))+2,'Zone label text occupies one line: '+label)}
    result.scenarios.push({label:'Original footer geometry '+label,boxes})
  }
  await checkFooters(group,'worktrees')
  await frame('dark-project-tags.png', 'Project worktrees as original Zone tags after task content')
  const collection = "[...document.querySelectorAll('[data-focus-container-key]')].find(e=>e.dataset.focusContainerKey===window.appearanceProof.collectionKey)"
  await until('confirmed original two-Topic Collection', () => read(`Boolean(${collection}?.querySelector('[aria-label="Container preferences · Research"]'))`))
  await change('[aria-label="Container preferences · Research"]', 'cards', '[aria-label="Save container preferences"]', collection)
  assert.equal(await read(`${collection}.dataset.focusZonePresentation`), 'cards', 'Explicit Topic tags override the section default')
  await read(`${collection}.scrollIntoView({block:'start'})`); await settle()
  await checkFooters(collection,'Topics')
  win.setContentSize(420,900); await settle(); await read(`${collection}.scrollIntoView({block:'start'})`); await settle(); await checkFooters(collection,'narrow long Topics'); await frame('dark-topic-footer-420.png','Narrow original long Topic footer in one line','collection')
  win.setContentSize(1440,900); await settle(); await read(`${collection}.scrollIntoView({block:'start'})`); await settle()
  await frame('dark-collection-tags.png', 'Collection Topic tags under their original container', 'collection')
  await change('[aria-label="Container preferences · Research"]', 'sections', '[aria-label="Save container preferences"]', collection)
  await read("window.appearanceProof.theme('light')"); await settle()
  assert.ok(await read(`${collection}.querySelectorAll('[data-focus-topic-section]').length >= 2`), 'Original two Topics are visibly sectioned')
  await frame('light-collection-sections.png', 'Collection Topic sections using the same organization choice', 'collection')
}
