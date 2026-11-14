const assert = require('node:assert/strict')

module.exports = async function captureOrganization({ win, read, click, frame, until, settle, result }) {
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
  assert.equal(await read(`${collection}.dataset.focusZonePresentation`), 'cards', 'Topic default uses tags')
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
