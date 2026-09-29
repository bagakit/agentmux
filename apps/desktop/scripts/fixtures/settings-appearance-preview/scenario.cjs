const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { nativeImage } = require('electron')

exports.run = async function run(p) {
  const { win, read, q, button, until, settle, click, scene, capture, section, owner, result, evidence, mode } = p
  const expected = await read('window.promptsProbe.palettes()')
  assert.ok(expected.length > 0, 'Actual palette catalog is nonempty')
  assert.equal(new Set(expected.map(item => item.id)).size, expected.length)
  result.catalog = expected
  result.glyphs = []
  result.paintFrames = []
  result.capturedPaint = []
  const group = label => `[...document.querySelectorAll('[data-settings-pane="appearance"] [role="radiogroup"]')].find(n=>n.getAttribute('aria-label')===${JSON.stringify(label)})`
  const radio = (label, id) => `(${group(label)}).querySelector('input[value="${id}"]')`
  const checked = label => `(${group(label)}).querySelector('input:checked')`
  const number = q('[data-settings-pane="appearance"] [aria-label="Terminal font size in pixels"]')

  async function glyphs(sceneName) {
    const actual = await read(`(()=>{const g=${group('Terminal palette')};return [...(g?.querySelectorAll('input[type=radio]')??[])].map(n=>({id:n.value,label:n.getAttribute('aria-label'),description:document.getElementById(n.getAttribute('aria-describedby'))?.textContent}))})()`)
    assert.ok(actual.length > 0, 'Actual palette radio collection is nonempty')
    assert.deepEqual(actual, expected, 'Actual radio identities and copy are the complete loaded palette catalog')
    for (const item of actual) {
      await read(`(${radio('Terminal palette', item.id)}).closest('label').scrollIntoView({block:'center',behavior:'instant'})`)
      await settle()
      const facts = await read(`(()=>{
        const label=(${radio('Terminal palette', item.id)}).closest('label'), preview=label.querySelector('.terminal-theme-preview');
        if(!preview)throw Error('Missing actual palette preview');
        const rect=n=>n.getBoundingClientRect().toJSON();
        const clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
        const ancestors=[];
        for(let n=preview;n;n=n.parentElement){
          const s=getComputedStyle(n),r=n.getBoundingClientRect(),x=/^(hidden|clip|auto|scroll)$/.test(s.overflowX),y=/^(hidden|clip|auto|scroll)$/.test(s.overflowY);
          if(x){clip.left=Math.max(clip.left,r.left+n.clientLeft);clip.right=Math.min(clip.right,r.left+n.clientLeft+n.clientWidth)}
          if(y){clip.top=Math.max(clip.top,r.top+n.clientTop);clip.bottom=Math.min(clip.bottom,r.top+n.clientTop+n.clientHeight)}
          if(x||y)ancestors.push({tag:n.tagName,className:n.className,x,y,rect:rect(n)});
        }
        const rows=[...preview.querySelectorAll('.terminal-theme-preview__line,.terminal-theme-preview__composer')].map(row=>{
          const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT),nodes=[];
          for(let node=walker.nextNode();node;node=walker.nextNode())if(!node.parentElement.closest('b'))nodes.push(node);
          const text=nodes.map(n=>n.data).join(''),glyphs=[];
          for(const node of nodes){let start=0;for(const char of node.data){const end=start+char.length;if(!/\\s/u.test(char)){
            const range=document.createRange();range.setStart(node,start);range.setEnd(node,end);
            const rs=[...range.getClientRects()].map(r=>r.toJSON());
            const positive=rs.length>0&&rs.every(r=>r.width>0&&r.height>0);
            const visible=positive&&rs.every(r=>r.left>=clip.left-.25&&r.top>=clip.top-.25&&r.right<=clip.right+.25&&r.bottom<=clip.bottom+.25&&label.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)));
            glyphs.push({char,rects:rs,positive,visible});
          }start=end}}
          const lineTops=[...new Set(glyphs.flatMap(g=>g.rects.map(r=>Math.round(r.top*2)/2)))];
          return{className:row.className,connected:row.isConnected,text,nodeCount:nodes.length,glyphs,lineTops,rect:rect(row)};
        });
        return{id:${JSON.stringify(item.id)},scene:${JSON.stringify(sceneName)},preview:rect(preview),clip,ancestors,rows};
      })()`)
      result.glyphs.push(facts)
      assert.equal(facts.rows.length, 2, 'Each actual preview has exactly one output and one input sample')
      assert.ok(facts.clip.right > facts.clip.left && facts.clip.bottom > facts.clip.top, 'Actual preview has a nonempty visible clip')
      assert.ok(facts.ancestors.length > 0, 'Visible glyph proof consumes real clipping ancestors')
      for (const row of facts.rows) {
        assert.ok(row.connected && row.text.trim() && row.nodeCount > 0 && row.glyphs.length > 0, 'Actual sample text and glyph collection are nonempty')
        assert.ok(row.glyphs.every(glyph => glyph.positive), 'Every actual nonwhitespace glyph has positive native Range geometry')
        assert.ok(row.glyphs.every(glyph => glyph.visible) && row.lineTops.length === 1, 'Appearance sample glyphs fit one fully visible line')
      }
      assert.equal(facts.rows[0].text.trim(), 'project/')
      assert.equal(facts.rows[1].text.trim(), 'Ask agent…')
    }
  }

  function pixels(image, geometry) {
    const facts = structuredClone(geometry), size = image.getSize(1), bytes = image.toBitmap({ scaleFactor: 1 })
    assert.equal(bytes.length, size.width * size.height * 4, 'Actual native bitmap has nonempty four-channel pixels')
    const scaleX = size.width / facts.width, scaleY = size.height / facts.height
    for (const preview of facts.previews) for (const sample of preview.samples) {
      const r = sample.rect, left = Math.max(0, Math.floor(r.left * scaleX)), right = Math.min(size.width, Math.ceil(r.right * scaleX))
      const top = Math.max(0, Math.floor(r.top * scaleY)), bottom = Math.min(size.height, Math.ceil(r.bottom * scaleY))
      const colors = new Set()
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) colors.add(bytes.readUInt32LE((y * size.width + x) * 4))
      sample.pixelColors = colors.size
    }
    const complete = facts.previews.length === expected.length && facts.previews.length > 0 && facts.previews.every(preview => preview.samples.length > 0 && preview.samples.every(sample => sample.pixelColors > 1))
    return { size, complete, ...facts }
  }

  // Native Range geometry can be valid before a layer is present in capturePage.
  // Observe the actual bitmap without interpreting platform pixel channel order.
  async function paint(sceneName) {
    for (let attempt = 0; attempt < 6; attempt++) {
      await settle()
      const facts = await read(`(()=>{const g=${group('Terminal palette')};return{width:innerWidth,height:innerHeight,previews:[...g.querySelectorAll('.terminal-theme-preview')].map(preview=>{
        const samples=[];
        for(const dot of preview.querySelectorAll('.terminal-theme-preview__chrome i'))samples.push({kind:'dot',rect:dot.getBoundingClientRect().toJSON()});
        const rows=[...preview.querySelectorAll('.terminal-theme-preview__line,.terminal-theme-preview__composer')].map(row=>{
          const s=getComputedStyle(row),walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);
          for(let node=walker.nextNode();node;node=walker.nextNode()){let start=0;for(const char of node.data){const end=start+char.length;if(!/\\s/u.test(char)){const r=document.createRange();r.setStart(node,start);r.setEnd(node,end);samples.push({kind:'glyph',char,rect:r.getBoundingClientRect().toJSON()})}start=end}}
          return{color:s.color,background:s.backgroundColor,opacity:s.opacity,visibility:s.visibility,display:s.display};
        });
        const s=getComputedStyle(preview);return{id:preview.closest('label').querySelector('input').value,color:s.color,background:s.backgroundColor,opacity:s.opacity,rows,samples};
      })}})()`)
      const observed = pixels(await win.webContents.capturePage(), facts)
      result.paintFrames.push({ scene: sceneName, attempt, visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized(), ...observed })
      if (observed.complete) return facts
    }
    assert.fail('Actual Appearance samples and chrome are painted in the native frame')
  }

  await section('appearance')
  await scene(940, 'light')
  await glyphs('940-light')
  if (mode === 'appearance-preview-glyphs') {
    await capture('940-light-appearance.png', 'Owning glyph control/restoration only; not a new visual qualification')
    return
  }

  win.showInactive()
  await read(`window.appearanceNodes={font:${number},radios:[...(${group('Terminal palette')}).querySelectorAll('input')]};window.appearanceKeys=[];window.appearanceKeyObserver=e=>window.appearanceKeys.push({key:e.key,trusted:e.isTrusted,target:e.target.getAttribute('aria-label'),value:e.target.value});document.addEventListener('keydown',window.appearanceKeyObserver,true)`)
  async function key(keyCode, modifiers = []) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await settle()
  }
  async function focused(expression, message) {
    assert.equal(await read(`(()=>{const n=${expression};return n===document.activeElement&&n.isConnected&&n.checkVisibility()&&!n.closest('[hidden],[inert]')})()`), true, message)
  }
  const original = structuredClone(owner.current)
  try {
    const appOriginal = await read(`(${checked('Application appearance')}).value`)
    await click(`(${checked('Application appearance')}).closest('label').querySelector('strong')`)
    await focused(checked('Application appearance'), 'Whole-card application click focuses its connected native radio')
    await key('Tab', ['shift'])
    await focused(q('[aria-label="Close settings"]'), 'Native Shift-Tab reaches the original connected visible Close settings button')
    await key('Tab')
    await focused(checked('Application appearance'), 'Native Tab enters the selected application radio')
    await key('Right')
    assert.notEqual(await read(`(${checked('Application appearance')}).value`), appOriginal, 'Native application arrow selects another original radio')
    await key('Left')
    await key('Space')
    assert.equal(await read(`(${checked('Application appearance')}).value`), appOriginal, 'Native application arrow/Space preserves the original selected value')
    assert.deepEqual(owner.current, original, 'Radio drafts never persist before explicit Save')

    assert.ok(expected.length > 1, 'Native palette positive control has a real alternative')
    const target = expected.find(item => item.id !== original.appearance.terminalTheme)
    assert.ok(target)
    await click(`(${radio('Terminal palette', target.id)}).closest('label').querySelector('.terminal-theme-choice__copy')`)
    await focused(radio('Terminal palette', target.id), 'Whole-card palette click focuses its connected native radio')
    assert.equal(await read(`(${radio('Terminal palette', target.id)}).checked`), true)
    assert.equal(await read(`(${radio('Terminal palette', target.id)}).closest('label').querySelector('svg.lucide-palette')!==null`), true, 'Palette selection has a noncolor identity mark')
    assert.equal(await read(`(${q('[data-settings-pane="appearance"] [data-settings-save-bar]')}).textContent.includes('Unsaved')`), true)
    assert.deepEqual(owner.current, original)
    await click(number)
    await key('Tab')
    await focused(radio('Terminal palette', target.id), 'Native Tab enters the selected palette radio')
    await key('Left')
    const arrowValue = await read(`(${checked('Terminal palette')}).value`)
    assert.notEqual(arrowValue, target.id, 'Native palette arrow changes the selected original radio')
    await key('Right')
    await key('Space')
    await focused(radio('Terminal palette', target.id), 'Native palette arrow/Space leaves actual focus on the selected radio')
    await key('Tab')
    await focused(button('Save appearance'), 'Native Tab exits the palette group to the enabled original Save')

    await scene(320, 'light')
    await scene(940, 'light')
    assert.equal(await read(`(()=>{const before=window.appearanceNodes,current=[...(${group('Terminal palette')}).querySelectorAll('input')];return before.font===${number}&&before.font.isConnected&&before.radios.length===current.length&&current.every((n,i)=>n===before.radios[i]&&n.isConnected)&&(${radio('Terminal palette', target.id)}).checked})()`), true, 'Resize keeps the original connected native fields and dirty palette')
    const expectedBeforeSave = structuredClone(owner.current)
    // The existing pane submits its shared default explicitly when old config omits font size.
    // Compare the original semantic expectation, without changing that Source contract.
    const expectedFields = { ...expectedBeforeSave, appearance: { ...expectedBeforeSave.appearance, terminalFontSize: expectedBeforeSave.appearance.terminalFontSize ?? await read('window.promptsProbe.appearanceFontDefault') } }
    const saveCount = result.saves.length
    await click(button('Save appearance'))
    await until(`(${q('[data-settings-pane="appearance"] [data-settings-save-bar] [role="status"]')}).textContent.trim()==='Changes saved'`)
    assert.equal(result.saves.length, saveCount + 1, 'One explicit Save reaches the actual private Main ConfigOwner')
    const submitted = result.saves.at(-1)
    assert.deepEqual(submitted.expected, expectedFields, 'Appearance Save sends the original field expectation to the real owner')
    assert.deepEqual(submitted.next, { ...expectedFields, appearance: { ...expectedFields.appearance, terminalTheme: target.id } }, 'Appearance Save changes only the selected palette scope')
    assert.deepEqual(owner.current, { ...expectedBeforeSave, appearance: { ...expectedBeforeSave.appearance, terminalTheme: target.id } }, 'The real ConfigOwner commits only the actual edit and preserves the original unedited config bytes')
    assert.deepEqual(owner.current.composerShortcuts, original.composerShortcuts)
    result.nativeKeys = await read('window.appearanceKeys')
    assert.ok(result.nativeKeys.length > 0 && result.nativeKeys.every(event => event.trusted), 'Actual native input events are nonempty and trusted')
    result.save = { expected: submitted.expected, next: submitted.next, nativeSelection: target.id }

    for (const [width, appearance] of [[940, 'light'], [940, 'dark'], [320, 'dark']]) {
      await scene(width, appearance)
      await glyphs(`${width}-${appearance}`)
      await click(number)
      await key('Tab')
      await focused(checked('Terminal palette'), 'Scene retains connected actual keyboard focus')
      if (width === 940) await read(`document.querySelector('[data-settings-pane="appearance"]').scrollTo({top:0,behavior:'instant'})`)
      await settle()
      const paintGeometry = await paint(`${width}-${appearance}`)
      const file = `${width}-${appearance}-appearance.png`
      await capture(file, 'Complete actual Appearance window; static sample, original selected/focused radio and Save')
      const saved = pixels(nativeImage.createFromBuffer(fs.readFileSync(path.join(evidence, file))), paintGeometry)
      result.capturedPaint.push({ file, ...saved })
      assert.equal(saved.complete, true, 'The actual saved PNG paints every sample glyph and chrome dot')
    }
    assert.equal(await read(`window.appearanceNodes.font===${number}&&window.appearanceNodes.font.isConnected`), true, 'Scrolled/resized Appearance keeps its original native field')
  } finally {
    await read("document.removeEventListener('keydown',window.appearanceKeyObserver,true)")
  }
  result.boundary = 'Actual App/Settings/Appearance, current catalog, native trusted radio input and private actual ConfigOwner/ConfigStore. No user App/Runtime/Run, OS preferences, terminal instance, installation or frame-cost claim.'
}
