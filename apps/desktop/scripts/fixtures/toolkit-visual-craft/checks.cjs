const assert = require('node:assert/strict')

// All facts come from Chromium's connected product controls and resolved cascade.
module.exports = ({ read, click, button, text, settle, win, raw, until, hover }) => {
  const transparent = value => value === 'rgba(0, 0, 0, 0)' || value === 'transparent'
  async function facts(selector) {
    return read(`(() => {
      const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing actual style consumer');
      const c=getComputedStyle(n),b=n.getBoundingClientRect();
      const token=name=>{const ref=document.createElement('i');ref.style.color='var('+name+')';ref.hidden=true;document.body.append(ref);const value=getComputedStyle(ref).color;ref.remove();return value};
      return{selector:${JSON.stringify(selector)},connected:n.isConnected,visible:n.checkVisibility(),x:b.x,y:b.y,width:b.width,height:b.height,
        focused:document.activeElement===n,documentFocused:document.hasFocus(),focusPseudo:n.matches(':focus'),hoverPseudo:n.matches(':hover'),background:c.backgroundColor,image:c.backgroundImage,color:c.color,
        outlineColor:c.outlineColor,outlineWidth:c.outlineWidth,borderWidth:c.borderTopWidth,borderColor:c.borderTopColor,boxShadow:c.boxShadow,fontSize:c.fontSize,accent:c.accentColor,
        weight:c.fontWeight,checked:n.checked,green:token('--green'),focus:token('--focus-line'),neutral:token('--text-3')};
    })()`)
  }
  const record = (name, value) => { raw.styles ??= []; raw.styles.push({ name, ...value }) }
  const specific = (name, fn) => { raw.assertionName = name; fn() }
  async function hierarchy(kind) {
    await hover({ x: 1, y: 1 })
    await new Promise(resolve => setTimeout(resolve, 180)); await settle()
    const toolbar = await facts('.toolkit-workbench__toolbar > .toolkit-workbench__create')
    const starting = await facts('.toolkit-workbench__starting')
    record(kind + ':toolbar', toolbar); record(kind + ':starting', starting)
    specific('hierarchy', () => {
      assert.equal(starting.image, 'none', 'Starting points stays ghost without a competing fill')
      assert.ok(transparent(starting.background), 'Starting points has no competing surface')
      assert.equal(starting.boxShadow, 'none', 'Ghost does not keep a raised button shadow')
      if (kind === 'wide-empty' || kind === 'wide-starting') {
        assert.equal(toolbar.image, 'none', 'Wide empty or starting-point toolbar New is quiet')
        assert.ok(transparent(toolbar.background), 'Wide toolbar New cannot compete with the central primary')
        assert.equal(toolbar.boxShadow, 'none', 'Quiet toolbar New has no raised shadow')
        const leading = raw.styles.at(-3)
        assert.ok(leading.image.includes('gradient'), 'The one leading create/adopt control has an actual filled surface')
        assert.notEqual(leading.boxShadow, 'none', 'The leading filled action has an actual primary shadow')
        assert.ok(Number(leading.weight) > Number(toolbar.weight), 'Primary has stronger weight than quiet New')
      } else {
        assert.ok(toolbar.image.includes('gradient'), 'Narrow library or populated library has a filled primary New')
        assert.notEqual(toolbar.boxShadow, 'none', 'Primary New keeps an actual primary shadow')
        assert.ok(Number(toolbar.weight) > Number(starting.weight), 'Primary New has stronger weight than its ghost neighbor')
      }
    })
  }
  async function leading(selector, name) { const value = await facts(selector); record(name, value); assert.ok(value.visible && value.height >= 32) }
  async function nameFocus(theme) {
    await read(`window.identityScene.theme(${JSON.stringify(theme)})`); await settle()
    await click('.toolkit-editor__metadata')
    await hover({ x: 1, y: 1 })
    await new Promise(resolve => setTimeout(resolve, 180))
    const before = await facts('.toolkit-editor__name input'); record(theme + ':name-before', before)
    const point = await read('(()=>{const b=document.querySelector(".toolkit-editor__name input").getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()')
    assert.equal(await read(`document.elementFromPoint(${point.x},${point.y})===document.querySelector('.toolkit-editor__name input')`), true, 'Native hover targets the exact visible name input')
    await hover(point, '.toolkit-editor__name input')
    await new Promise(resolve => setTimeout(resolve, 180))
    const hovered = await facts('.toolkit-editor__name input'); record(theme + ':name-hover', hovered)
    await click('.toolkit-editor__name input')
    const value = await facts('.toolkit-editor__name input'); record(theme + ':name-focus', value)
    specific('nameFocus', () => {
      assert.ok(value.visible && value.focused, 'Native click focuses the connected name input')
      assert.ok(value.documentFocused && value.focusPseudo, 'The private window has genuine native focus while reading its focus style')
      assert.equal(value.outlineWidth, '2px', 'Actual name input has a distinct two-pixel focus boundary')
      assert.equal(value.outlineColor, value.focus, 'Actual name focus consumes the existing brand focus token')
      assert.equal(value.borderWidth, '1px', 'Editable name has a persistent subtle boundary')
      assert.ok(hovered.borderColor !== before.borderColor || hovered.background !== before.background, 'Trusted Renderer hover makes the editable name discoverable')
      assert.equal(value.fontSize, before.fontSize, 'Focus does not resize the name typography')
      assert.equal(value.width, before.width, 'Focus preserves the actual name width')
      assert.equal(value.height, before.height, 'Focus preserves the actual name height')
    })
  }
  async function palette(kind, theme) {
    await read(`window.identityScene.theme(${JSON.stringify(theme)})`); await settle()
    const selectors = kind === 'custom'
      ? ['.toolkit-editor__toggle input', '.toolkit-editor .toolkit-settings__choices input', '.toolkit-icon-picker__grid input']
      : ['.toolkit-settings__toggle input', '.toolkit-settings__choices input']
    for (const selector of selectors) {
      const value = await facts(selector); record(kind + ':' + theme + ':accent', value)
      specific('palette', () => assert.equal(value.accent, value.green, 'Actual ' + kind + ' checkbox/radio consumes the defined brand green'))
    }
    if (kind === 'custom') {
      const value = await facts('.toolkit-icon-picker > summary'); record(theme + ':custom-icon', value)
      specific('palette', () => assert.equal(value.color, value.green, 'Custom icon is brand green'))
    }
    const lock = await facts('.toolkit-library__official'); record(theme + ':official-lock', lock)
    specific('palette', () => assert.equal(lock.color, lock.neutral, 'Official lock remains neutral, distinct from selection'))
    if (await read('!!document.querySelector(".toolkit-library__selected")')) {
      const check = await facts('.toolkit-library__selected'); record(theme + ':selection-check', check)
      specific('palette', () => assert.equal(check.color, check.green, 'Selected Custom check is brand green'))
      assert.equal(await read('document.querySelector(".toolkit-library__selected").closest("button").getAttribute("aria-pressed")'), 'true', 'Selection has a non-color marker and pressed state')
    }
  }
  async function owning(target) {
    win.setContentSize(1480, 980); await settle()
    if (target === 'all' || target === 'hierarchy') {
      await leading('.toolkit-workbench__empty > .toolkit-workbench__create', 'wide-empty:leading'); await hierarchy('wide-empty')
      win.setContentSize(640, 980); await settle(); await hierarchy('narrow-empty')
      win.setContentSize(1480, 980); await settle(); await button('Starting points')
      await leading('.toolkit-template__adopt', 'wide-starting:leading'); await hierarchy('wide-starting')
    }
    await button('New custom tool'); await until('window.identityScene.models().then(models=>models.length===1)')
    for (const theme of ['light', 'dark']) {
      if (target === 'all' || target === 'nameFocus') await nameFocus(theme)
      if (target === 'all' || target === 'palette') await palette('custom', theme)
    }
    await text('.toolkit-editor__name input', 'Workspace summary')
    assert.equal(await read('document.querySelector(".toolkit-editor__status").textContent'), 'Unsaved')
    win.setContentSize(1480, 980); await settle()
    if (target === 'all' || target === 'hierarchy') await hierarchy('populated-library')
    await text('.toolkit-library__search input', 'Workspace summary')
    await click('.toolkit-library__search button')
    assert.equal(await read('document.activeElement===document.querySelector(".toolkit-library__search input") && document.activeElement.value===""'), true, 'Clear search is reachable and returns exact input focus')
    await read('window.identityScene.navigate("performance")'); await until('document.querySelector(".toolkit-settings__identity")?.checkVisibility()')
    assert.deepEqual(await read('window.identityScene.models()'), [])
    for (const theme of ['light', 'dark']) if (target === 'all' || target === 'palette') await palette('builtin', theme)
    if (target === 'all') {
      const before = await read('document.querySelector(".toolkit-settings__toggle input").checked')
      await click('.toolkit-settings__toggle input')
      assert.equal(await read('document.querySelector(".toolkit-settings__toggle input").checked'), !before, 'Native checkbox click still changes the original draft')
    }
    await read('window.identityScene.active(false)'); await settle()
    assert.deepEqual(await read('window.identityScene.models()'), []); assert.deepEqual(await read('window.identityScene.executionCalls'), [])
  }
  return { hierarchy, leading, nameFocus, palette, owning }
}
