import { mintObjectId } from '@agentmux/identity';
import * as ThemeBridge from './bridge.js';
import futureDesigns from './future-designs.json';
const $ = selector => document.querySelector(selector);
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const KEY = 'agentmux.icon-review.v1';
const STATUSES = {not_started:'未评审',in_progress:'调整中',passed:'保留当前设计',needs_review:'需要讨论',blocked:'信息不足',failed:'不适合此用途'};
const editable = ['glyph','feature','meaning','note','status'];
let data, roleById, draft, activeId = 'status.working', category = 'all', mode = 'gallery', query = '', modifiedOnly = false;
let storageAvailable = true, corruptRaw = null, toastTimer, lastTrigger = null;
let manifest, sessionExportTime, projectedTheme;
let motionGlyph, motionTrigger, motePreview;
const views = ['gallery','matrix','motion','mote','future'];
const initialView = window.location.hash.slice(1);
if(views.includes(initialView))mode=initialView;
if (import.meta.hot) import.meta.hot.on('icon-review:source-change', () => {
  if (!window.iconReview?.ready || storageAvailable) location.reload();
  else notice('源码已更新；当前草稿尚未保存，请先导出修改，再手动刷新。');
});
// Simulated instance parameters never enter the saved draft or a theme file.
const samplePresentation = { animation:'none', color:undefined };
const motionLabels = { loop:'循环动态', once:'单次反馈', still:'保持静止' };
const mobile = () => matchMedia('(max-width:950px)').matches;
const changed = id => Boolean(draft.edits[id]);
const effective = r => ({...r, note:'',status:'not_started',...draft.edits[r.id]});
const baseValue = (r,key) => {
  if(key==='glyph'){
    const base=draft.preview?.imported?.id===draft.preview?.themeId?draft.preview.imported:ThemeBridge.themes.find(theme=>theme.id===draft.preview?.themeId);
    const asset=base?.icons[r.id];
    return asset?.kind==='paths'?'主题 paths':asset?.glyph??r.glyph;
  }
  return key === 'note' ? '' : key === 'status' ? 'not_started' : r[key];
};

function icon(name,size=24,css='') {
  const shapes = data.glyphs[name] ?? data.glyphs['circle-help'];
  return `<svg class="${css}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="stroke-width:var(--icon-stroke-width);stroke-linecap:var(--icon-linecap);stroke-linejoin:var(--icon-linejoin)" aria-hidden="true">${shapes.map(([tag,attrs])=>`<${tag} ${Object.entries(attrs).map(([key,value])=>`${key}="${escape(value)}"`).join(' ')} />`).join('')}</svg>`;
}
const semantic = (id,size=24) => ThemeBridge.semanticMarkup(id,size);
const drawingLabel = r => projectedTheme?.icons[r.id]?.kind==='paths' ? '主题 paths' : projectedTheme?.icons[r.id]?.glyph ?? r.glyph;
function currentTheme(preview=draft.preview,edits=draft.edits) {
  const icons=Object.fromEntries(Object.entries(edits).filter(([,patch])=>patch.glyph).map(([id,patch])=>[id,{kind:'glyph',glyph:patch.glyph}]));
  return ThemeBridge.buildTheme(preview?.themeId??'graphite',icons,preview?.imported);
}
function validatePreview(value) {
  if(!value)return {themeId:'graphite',mode:'light'};
  const imported=value.imported ? ThemeBridge.parseThemeFile(JSON.stringify(value.imported)) : undefined;
  if(!['light','dark'].includes(value.mode)||!ThemeBridge.themes.some(theme=>theme.id===value.themeId)&&imported?.id!==value.themeId)throw Error('主题预览字段无效，原草稿仍保留。');
  return {themeId:value.themeId,mode:value.mode,...(imported?{imported}:{})};
}
function applyPreview() {
  projectedTheme=currentTheme();ThemeBridge.projectTheme(projectedTheme,draft.preview.mode);
  $('#preview-theme').innerHTML=[...ThemeBridge.themes.filter(theme=>theme.id!==draft.preview.imported?.id),...(draft.preview.imported?[draft.preview.imported]:[])].map(theme=>`<option value="${escape(theme.id)}">${escape(theme.name)}${theme===draft.preview.imported?' · 导入':''}</option>`).join('');
  $('#preview-theme').value=draft.preview.themeId;$('#preview-mode').value=draft.preview.mode;
}
function renderSamples() {
  const items=[['status.working','工作产出'],['status.streaming','内容流入'],['status.browser-running','浏览器执行'],['object.activity','工作记录'],['status.waiting','操作等待']];
  const designedGlyph=samplePresentation.animation==='none'?undefined:Object.entries(ThemeBridge.authoredDesigns).find(([,design])=>design.motion.animation===samplePresentation.animation)?.[0];
  const designedRole=ThemeBridge.catalog.icons.find(role=>role.defaultGlyph===designedGlyph);
  if(designedRole&&!items.some(([id])=>id===designedRole.id))items.push([designedRole.id,designedRole.label]);
  $('#semantic-samples').innerHTML=items.map(([id,label])=>`<button type="button" data-sample="${id}" aria-label="编辑 ${id}"><span class="sample-icons">${ThemeBridge.semanticMarkup(id,12,'',samplePresentation)}${ThemeBridge.semanticMarkup(id,24,'',samplePresentation)}</span><strong>${label}</strong><small>${id}</small></button>`).join('');
}
function toast(message) {
  $('#toast').textContent=message;$('#toast').hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4000);
}
function notice(message) { $('#storage-notice').textContent=message;$('#storage-notice').hidden=!message; }
function saveDraft() {
  draft.updatedAt=new Date().toISOString();
  try {
    if(corruptRaw) { localStorage.setItem(KEY+'.recovery',corruptRaw);corruptRaw=null; }
    localStorage.setItem(KEY,JSON.stringify(draft));
    storageAvailable=true;
  } catch(error) {
    storageAvailable=false;
    notice('浏览器暂时无法保存草稿。当前修改仍可编辑，请用“导出修改”保留一份；关闭页面前不要丢掉导出文件。');
  }
  renderSaveState();
}
function renderSaveState() {
  const count=Object.keys(draft.edits).length;
  $('#save-state').textContent=storageAvailable ? count ? '草稿已保存 · 仅此浏览器' : '仅此浏览器保存草稿' : '未持久保存 · 请导出';
  $('#save-state').classList.toggle('error',!storageAvailable);
  $('#modified-count').textContent=count;$('#draft-count').textContent=`${count} 项修改`;
}
function patchRole(id,field,value) {
  const r=roleById.get(id), before={...(draft.edits[id]??{})}, after={...before};
  if(value===baseValue(r,field)) delete after[field]; else after[field]=value;
  if(field!=='status' && Object.keys(after).length && !after.status) after.status='in_progress';
  if(after.status==='in_progress' && !Object.keys(after).some(k=>k!=='status')) delete after.status;
  if(JSON.stringify(before)===JSON.stringify(after))return;
  if(field==='glyph'){
    try{currentTheme(draft.preview,{...draft.edits,[id]:after});}
    catch(error){toast(`图标修改无法预览：${error.message} 原草稿保留。`);return;}
  }
  if(Object.keys(after).length)draft.edits[id]=after;else delete draft.edits[id];
  draft.history.push({event_id:mintObjectId(),at:new Date().toISOString(),case_id:id,action:'edit',field,before:before[field]??baseValue(r,field),after:value,provenance:'user_entered'});
  saveDraft();if(field==='glyph')applyPreview();renderInventory();refreshInspectorSignals();
}
function restoreRole(id) {
  if(!changed(id))return;
  const edits={...draft.edits};delete edits[id];
  try{currentTheme(draft.preview,edits);}catch(error){toast(`撤回失败：${error.message} 原草稿保留。`);return;}
  draft.history.push({event_id:mintObjectId(),at:new Date().toISOString(),case_id:id,action:'restore',before:draft.edits[id],after:{},provenance:'user_entered'});
  delete draft.edits[id];saveDraft();applyPreview();renderInventory();renderInspector();toast('已恢复这一项的原始定义');
}
function rows() {
  const needle=query.trim().toLowerCase();
  return data.roles.filter(r=>{
    const e=effective(r);
    return (category==='all'||r.category===category)&&(!modifiedOnly||changed(r.id))&&(!needle||[r.id,r.glyph,r.label,e.glyph,drawingLabel(r),e.feature,e.meaning,e.note,...r.sources.map(s=>s.file)].join(' ').toLowerCase().includes(needle));
  });
}
function orderedGroups(items) {
  const groups=new Map();
  for(const r of items){if(!groups.has(r.glyph))groups.set(r.glyph,[]);groups.get(r.glyph).push(r);}
  const priority=['work-writing','content-stream','browser-executing','work-history','radio','loader-circle','circle-check','circle-help','plus','check','x','bot','terminal','earth','message-square'];
  return [...groups].sort(([a],[b])=>{
    const ai=priority.indexOf(a),bi=priority.indexOf(b);
    return (ai<0?100:ai)-(bi<0?100:bi)||a.localeCompare(b);
  });
}
function renderCategories() {
  $('#categories').innerHTML=data.categories.map(c=>{
    const count=c.id==='all'?data.roles.length:data.roles.filter(r=>r.category===c.id).length;
    return `<button class="category" data-category="${c.id}" aria-current="${category===c.id}"><span class="category-check" aria-hidden="true">✓</span>${escape(c.label)}<span class="category-count">${count}</span></button>`;
  }).join('');
  $('#mobile-category').innerHTML=data.categories.map(c=>`<option value="${c.id}">${escape(c.label)}</option>`).join('');
  $('#mobile-category').value=category;
}
function setCategory(value) {category=value;if(!['gallery','matrix'].includes(mode))mode='gallery';renderCategories();renderInventory();$('#inventory-content').scrollTop=0;}
function renderInventory() {
  for(const view of views)$('#view-'+view).setAttribute('aria-pressed',mode===view);
  $('.workspace').dataset.view=mode;
  motePreview?.dispose();motePreview=undefined;
  const directory=['gallery','matrix'].includes(mode);
  if(!directory&&$('#inspector').open)$('#inspector').close();
  if(directory&&!mobile()&&!$('#inspector').open)$('#inspector').show();
  $('.edited-filter').hidden=!directory;$('#mobile-category').hidden=!directory;
  $('#sample-lab').hidden=!directory;$('.inventory-tools').hidden=mode==='mote';
  if(!directory){samplePresentation.animation='none';$('#preview-animation').value='none';renderSamples();}
  window.history.replaceState(null,'','#'+mode);
  $('#search').placeholder=mode==='motion'?'搜索自绘名称、静止设计、动效或用途':mode==='future'?'搜索候选名称、用途或定义来源':'搜索图标、功能、含义或语义 ID';
  $('#search').setAttribute('aria-label',$('#search').placeholder);
  if(mode==='motion'){renderMotionInventory();return;}
  if(mode==='mote'){renderMote();return;}
  if(mode==='future'){renderFuture();return;}
  const found=rows(),groups=orderedGroups(found);
  $('#result-count').textContent=`${groups.length} 种图形 · ${found.length} 个用途${query?' · 搜索结果':''}`;
  const host=$('#inventory-content');
  if(!found.length){host.innerHTML='<div class="empty"><strong>没有匹配的图标</strong>试试其他关键词，或取消“只看已修改”。</div>';return;}
  if(mode==='gallery') {
    host.innerHTML=`<div class="glyph-grid">${groups.map(([glyph,rs])=>{
      const count=rs.filter(r=>changed(r.id)).length;
      return `<button class="glyph-card" data-glyph="${glyph}" aria-label="${glyph}，${rs.length} 个用途的默认分组" aria-pressed="${roleById.get(activeId)?.glyph===glyph}">${icon(glyph,31)}<span class="glyph-name">${glyph}</span><small class="${count?'changed-badge':''}">${count?`${count} 项已修改 · `:''}目录默认 · ${rs.length} 个用途${data.customGlyphs.includes(glyph)?' · 自绘':''}</small></button>`;
    }).join('')}</div>`;
  } else {
    host.innerHTML=`<table class="matrix"><thead><tr><th scope="col">图标</th><th scope="col">用途与语义 ID</th><th scope="col">功能位置</th><th scope="col"><span aria-label="已修改">✎</span></th></tr></thead><tbody>${found.map(r=>{
      const e=effective(r);
      return `<tr data-role="${r.id}" class="${r.id===activeId?'selected':''}"><td>${semantic(r.id,22)}</td><td><button class="role-name" aria-label="编辑 ${r.id}">${escape(e.meaning)}</button><small>${escape(r.id)}</small></td><td class="feature">${escape(e.feature)}<small>${escape(drawingLabel(r))}</small></td><td class="row-check">${changed(r.id)?'✎':''}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
}
function authoredRoles(glyph) {return data.roles.filter(role=>role.glyph===glyph);}
function renderMote() {
  const role=roleById.get('object.mote'), drawing=drawingLabel(role);
  $('#result-count').textContent='真实组件 · 靠近、悬停、聚焦与按压';
  $('#inventory-content').innerHTML=`<div class="mote-showcase">
    <section class="mote-stage" id="mote-stage" data-interactive="true">
      <p class="eyebrow">A QUIET COMPANION</p><h2>一个有回应的搭档</h2>
      <p>把指针移近，停留片刻，或轻轻按住。</p>
      <div class="mote-playground"><button type="button" class="mote-target" aria-label="试试 Mote 的悬停、聚焦与按压回应"><span id="mote-preview"></span></button></div>
      <label class="mote-toggle"><input type="checkbox" id="mote-interactive" checked>启用交互回应</label>
      <small>仅在这个区域演示，不执行 Mote 操作。</small>
    </section>
    <section class="mote-notes"><h3>从细节看性格</h3><dl>
      <div><dt>靠近</dt><dd>目光轻轻跟随指针，远离后回到原位。</dd></div>
      <div><dt>悬停 / 键盘聚焦</dt><dd>短暂眨眼，回应你的注意。</dd></div>
      <div><dt>按住 / 松开</dt><dd>身体轻压再回弹，鼠标与触控共用原交互。</dd></div>
      <div><dt>安静时</dt><dd>保持完整轮廓；系统减少动画时静止。</dd></div>
    </dl><p class="mote-theme-note">当前图形：<code>${escape(drawing)}</code>。主题自选图形与路径保留原样；默认搭档才启用这些局部回应。</p></section>
    <section class="mote-scale"><div><h3>回到实际尺寸</h3><p>类型、目录与历史标记保持静止。</p></div><div class="motion-rest-sizes">${[12,16,24,40].map(size=>`<span>${semantic('object.mote',size)}<small>${size} px</small></span>`).join('')}</div><button type="button" class="button" data-role="object.mote">编辑 Mote 图标 ↗</button></section>
  </div>`;
  motePreview=ThemeBridge.mountMotePreview($('#mote-preview'),{size:88,interactive:true});
}
function renderFuture() {
  const needle=query.trim().toLowerCase();
  const found=futureDesigns.filter(item=>[item.id,item.label,item.proposedSemantic,item.description,...item.definitions].join(' ').toLowerCase().includes(needle));
  $('#result-count').textContent=`${found.length} / ${futureDesigns.length} 个候选 · 尚未采用`;
  $('#inventory-content').innerHTML=`<p class="motion-inventory-note">为项目概念准备的静态草案。拟议用途与定义来源可供核对；这些候选未进入图标选择器或主题导出。</p><div class="future-grid">${found.map(item=>`<article class="future-card" data-future-glyph="${escape(item.id)}"><div class="future-title"><h2>${escape(item.label)}</h2><span class="design-kind">设计储备</span></div><div class="future-sizes">${[12,16,24,40].map(size=>`<span>${drawingMarkup(item.shapes,size)}<small>${size} px</small></span>`).join('')}</div><p>${escape(item.description)}</p><code>${escape(item.id)}</code><details><summary>拟议用途与定义来源</summary><p>拟议语义：<code>${escape(item.proposedSemantic)}</code></p>${item.definitions.map(path=>`<code class="definition-source">${escape(path)}</code>`).join('')}</details></article>`).join('')}</div>${found.length?'':'<div class="empty"><strong>没有匹配的候选</strong>试试对象名称或拟议用途。</div>'}`;
}
function drawingMarkup(shapes,size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="stroke-width:var(--icon-stroke-width);stroke-linecap:var(--icon-linecap);stroke-linejoin:var(--icon-linejoin)" aria-hidden="true">${shapes.map(([tag,attrs])=>`<${tag} ${Object.entries(attrs).map(([key,value])=>`${key}="${escape(value)}"`).join(' ')}/>`).join('')}</svg>`;
}
function renderMotionInventory() {
  const needle=query.trim().toLowerCase(), entries=Object.entries(ThemeBridge.authoredDesigns);
  const found=entries.filter(([glyph,design])=>[glyph,design.rest,design.motion.description,design.motion.trigger,motionLabels[design.motion.kind],...authoredRoles(glyph).flatMap(role=>[role.id,role.label,role.meaning,role.feature])].join(' ').toLowerCase().includes(needle));
  $('#result-count').textContent=`${found.length} / ${entries.length} 个自绘设计 · 全部用途${query?' · 搜索结果':''}`;
  $('#inventory-content').innerHTML=found.length?`<p class="motion-inventory-note">所有原图保持静止。选择一项查看设计与演示；用途分类可返回原目录。</p><div class="glyph-grid motion-grid">${found.map(([glyph,design])=>{
    const roles=authoredRoles(glyph);
    return `<button class="glyph-card design-card" data-motion-glyph="${escape(glyph)}" aria-label="查看 ${escape(glyph)} 的静止与动效设计"><span class="design-kind" data-kind="${design.motion.kind}">${motionLabels[design.motion.kind]}</span>${icon(glyph,29)}<span class="glyph-name">${escape(glyph)}</span><span class="design-rest">${escape(design.rest)}</span><small>${roles.length?`${roles.length} 个目录用途`:'尚未绑定语义用途'}</small></button>`;
  }).join('')}</div>`:'<div class="empty"><strong>没有匹配的自绘设计</strong>可搜索图形名称、用途或设计说明。</div>';
}
// Catalogue drawings retain the authored parts; the product stylesheet owns all motion.
// This does not replace a semantic symbol or alter a user-selected glyph/paths asset.
function authoredDemoMarkup(glyph,animation) {
  const role=authoredRoles(glyph)[0];
  if(role)return ThemeBridge.semanticMarkup(role.id,40,'',{animation});
  const drawing=icon(glyph,40,'semantic-icon');
  return animation==='none'?drawing:`<span class="semantic-icon-motion" data-icon-animation="${animation}">${drawing}</span>`;
}
function renderMotionDialog() {
  const design=ThemeBridge.authoredDesigns[motionGlyph];if(!design)return;
  const roles=authoredRoles(motionGlyph), motion=design.motion;
  $('#motion-title').textContent=motionGlyph;
  $('#motion-content').innerHTML=`
    <div class="motion-comparison">
      <section class="motion-panel"><h3>静止轮廓</h3><div class="motion-rest-sizes">${[12,16,24].map(size=>`<span>${icon(motionGlyph,size)}<small>${size} px</small></span>`).join('')}</div><p>${escape(design.rest)}</p></section>
      <section class="motion-panel motion-panel--demo"><h3>${roles.length?'当前主题演示':'未绑定 · 原图演示'}</h3><div id="authored-demo" class="authored-demo" data-authored-glyph="${escape(motionGlyph)}">${authoredDemoMarkup(motionGlyph,motion.animation)}</div><div class="motion-controls">${motion.kind==='loop'?'<button id="pause-motion" class="button" aria-pressed="false">暂停循环</button>':motion.kind==='once'?'<button id="replay-motion" class="button">重播一次</button>':'<span class="motion-still-label">此图形保持静止</span>'}</div><p>${escape(motion.description)}</p>${roles.length?`<small class="demo-asset">${escape(roles[0].id)} · ${escape(drawingLabel(roles[0]))}</small>`:''}</section>
    </div>
    <div class="motion-guidance"><h3>何时使用</h3><p>${escape(motion.trigger)}</p><small>此处仅演示设计，遵循系统的“减少动画”设置。</small></div>
    <section class="motion-roles"><h3>当前主题与草稿</h3><p>下方按真实语义用途显示当前图形，保持静止；自选图形与路径不会被目录演示替换。</p>${roles.length?`<div class="motion-role-list">${roles.map(role=>`<button class="motion-role" data-motion-role="${escape(role.id)}">${semantic(role.id,20)}<span><strong>${escape(role.label)}</strong><code>${escape(role.id)}</code><small>${escape(drawingLabel(role))}</small></span><span aria-hidden="true">↗</span></button>`).join('')}</div>`:'<p class="motion-unbound">尚未绑定语义用途，当前主题没有可对照的语义项。目录原图仍可完整查看。</p>'}</section>`;
}
function openMotion(glyph,trigger) {
  if(!Object.hasOwn(ThemeBridge.authoredDesigns,glyph))return;
  // Stop any older sample simulation so this view plays only the selected drawing.
  samplePresentation.animation='none';$('#preview-animation').value='none';renderSamples();
  motionGlyph=glyph;motionTrigger=trigger;renderMotionDialog();$('#motion-dialog').showModal();
}
function closeMotion() {
  const dialog=$('#motion-dialog'), trigger=motionTrigger;
  // Release immediately: hidden tabs can defer the native close event indefinitely.
  $('#motion-content').replaceChildren();motionGlyph=undefined;motionTrigger=undefined;
  if(dialog.open)dialog.close();
  trigger?.focus();
}
function selectRole(id,trigger) {
  activeId=id;lastTrigger=trigger??lastTrigger;renderInventory();renderInspector();
  const dialog=$('#inspector');
  if(mobile()){if(dialog.open)dialog.close();dialog.showModal();}
}
function renderInspector() {
  const r=roleById.get(activeId);if(!r)return;
  const e=effective(r),siblings=data.roles.filter(x=>x.glyph===r.glyph), diff=e.glyph!==r.glyph;
  $('#inspector-content').innerHTML=`
    <div class="inspector-top"><div class="inspector-heading"><h2>图标与用途</h2><span class="source-tag">${data.customGlyphs.includes(r.glyph)?'项目自绘':'共享目录'}</span><button class="icon-button close-inspector" aria-label="关闭用途编辑" data-close="inspector">×</button></div>
    <div class="icon-comparison"><div class="comparison-item"><div class="preview">${icon(r.glyph,39)}</div><small>目录默认</small><div class="inspector-sizes" aria-label="目录默认实际尺寸">${[12,16,24].map(size=>`<span>${icon(r.glyph,size)}<small>${size}px</small></span>`).join('')}</div></div><span class="comparison-arrow" aria-hidden="true">→</span><div class="comparison-item proposed"><div class="preview" id="proposed-preview">${semantic(r.id,39)}</div><small>当前主题与草稿</small><div class="inspector-sizes" aria-label="当前主题实际尺寸">${[12,16,24].map(size=>`<span>${semantic(r.id,size)}<small>${size}px</small></span>`).join('')}</div></div></div>
    <div class="active-glyph-name">${escape(r.glyph)}</div><p class="reuse-label">${siblings.length} 个用途复用此图形 · 选择要调整的一项</p><div class="reuse-list">${siblings.map(x=>`<button class="reuse-button" data-reuse="${x.id}" aria-pressed="${x.id===r.id}">${x.id===r.id?'✓ ':''}${escape(x.id)}</button>`).join('')}</div></div>
    <form class="inspector-form" id="role-form"><p class="semantic-id">${escape(r.id)}</p><p class="editing-label">修改只针对这一语义项。<span id="editing-state">${changed(r.id)?'已有人工修改。':'当前显示原始定义。'}</span></p>
    <label class="field"><span class="field-label">使用的图标 <em id="glyph-changed">${diff?'已修改':''}</em></span><button type="button" id="choose-glyph" class="glyph-control">${semantic(r.id,19)}<span>${escape(drawingLabel(r))}</span><span>更换 ↗</span></button></label>
    <label class="field"><span class="field-label">用于哪里</span><input id="edit-feature" name="feature" maxlength="500" value="${escape(e.feature)}" autocomplete="off"></label>
    <label class="field"><span class="field-label">表达什么</span><textarea id="edit-meaning" name="meaning" maxlength="500" rows="2">${escape(e.meaning)}</textarea></label>
    <label class="field"><span class="field-label">我的备注</span><textarea id="edit-note" name="note" maxlength="2000" rows="2" placeholder="例如：这个图标容易和“活动记录”混淆">${escape(e.note)}</textarea></label>
    <label class="field"><span class="field-label">评审状态</span><select id="edit-status" name="status">${Object.entries(STATUSES).map(([value,label])=>`<option value="${value}" ${e.status===value?'selected':''}>${label}</option>`).join('')}</select></label>
    <div class="inspector-bottom"><span>自动保存为浏览器草稿</span><button type="button" id="restore-role" ${changed(r.id)?'':'disabled'}>撤回此项草稿</button></div></form>
    <details class="evidence"><summary>原始定义与来源 <span>${r.sources.length} 处引用</span></summary><p class="source-explanation">图形和语义 ID 来自源码；中文含义与功能归纳可修订。引用包含静态命中、未解析具体目标的动态前缀候选及原生样式投影；候选不代表实际消费覆盖或 Runtime 状态。</p><div class="original-definition"><code>${escape(r.id)}</code><br>原图标：${escape(r.glyph)}<br>原含义：${escape(r.meaning)}<br>目录标签：${escape(r.label)}</div><div class="source-item"><span class="source-kind">定义</span><code>${escape(r.definition.file)}:${r.definition.line}</code></div>${r.sources.length?r.sources.map(s=>`<div class="source-item"><span class="source-kind">${{literal:'源码引用',dynamic:'动态前缀候选',native:'原生样式'}[s.kind]}</span><code>${escape(s.file)}:${s.line}</code><pre>${escape(s.excerpt)}</pre></div>`).join(''):'<p class="source-explanation">本次扫描没有发现具体业务消费；保留目录定义供核对。</p>'}</details>`;
  if(['gallery','matrix'].includes(mode)&&!mobile()&&!$('#inspector').open)$('#inspector').show();
}
function refreshInspectorSignals() {
  const e=effective(roleById.get(activeId));
  $('#editing-state').textContent=changed(activeId)?'已有人工修改。':'当前显示原始定义。';
  $('#restore-role').disabled=!changed(activeId);
  $('#edit-status').value=e.status;
}
function renderPicker() {
  const needle=$('#glyph-search').value.trim().toLowerCase();
  const names=Object.keys(data.glyphs).filter(n=>n.includes(needle)).sort();
  const asset=projectedTheme.icons[activeId],current=asset?.kind==='paths'?undefined:asset?.glyph??roleById.get(activeId).glyph;
  $('#picker-grid').innerHTML=names.length?names.map(n=>`<button class="picker-choice" data-pick="${n}" aria-label="选择 ${n}" aria-pressed="${n===current}">${icon(n,27)}<span>${escape(n)}</span></button>`).join(''):'<div class="empty">没有匹配的图标</div>';
  $('#picker-count').textContent=`${names.length} 个可选字形`;
}
function buildPacket() {
  return {
    schema:'agentmux.icon-review.v1',scene:manifest.scene,generated_at:draft.updatedAt??sessionExportTime,
    page_id:data.pageId,page_manifest_ref:'agentmux-icon-matrix/latest/review-manifest.json',projection_target_ref:'agentmux-icon-matrix',projection_version:manifest.projection_version,
    source_snapshot:data.snapshot,source_head:data.head,scan_scope:data.scanScope,operator_mode:'reviewer',review_mode:manifest.review_mode,reveal_policy:manifest.reveal_policy,
    status:Object.keys(draft.edits).length?'in_progress':'not_started',
    summary:{changed_roles:Object.keys(draft.edits).length,source_roles:data.roles.length,unresolved:draft.unresolved.length,scope:'proposed changes; not applied to AgentMux'},
    edits:Object.entries(draft.edits).map(([id,patch])=>{
      const r=roleById.get(id),e=effective(r);
      return {case_id:id,case_run_id:`${data.snapshot.slice(0,12)}:${id}`,evaluation_contract_id:manifest.evaluation_contract_id,evaluation_contract_version:1,
        before:{glyph:r.glyph,feature:r.feature,meaning:r.meaning,note:'',status:'not_started'},
        after:Object.fromEntries(editable.map(k=>[k,e[k]])),patch,
        evidence_sufficiency:e.status==='blocked'?'insufficient':'unassessed',provisional_human_judgment:null,agent_position:null,disagreement:null,
        final_human_judgment:{status:e.status,note:e.note,provenance:'user_entered'},evidence_refs:[r.definition,...r.sources.map(({file,line,kind})=>({file,line,kind}))]};
    }),
    themeIcons:currentTheme().icons,preview:draft.preview,themeFile:currentTheme(),
    history:draft.history,unresolved:draft.unresolved,evidence_refs:[{file:data.sourceFiles}],
    next_action:'Read the exact semantic-ID edits and retain source facts. Apply only within the user-authorized follow-up scope.'
  };
}
function packetText(){return JSON.stringify(buildPacket(),null,2);}
function exportPacket(){
  const blob=new Blob([packetText()],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='agentmux-icon-changes.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出修改与历史，可交给 Agent 继续处理');
}
function validatePacket(packet) {
  if(!packet||packet.schema!==KEY||packet.page_id!==data.pageId||!Array.isArray(packet.edits))throw Error('这不是此图标工作台的修改文件。');
  if(packet.edits.length>2000||!Array.isArray(packet.history)||packet.history.length>100000)throw Error('文件中的修改或历史超出合理范围。');
  const parsed={},unresolved=[...(Array.isArray(packet.unresolved)?packet.unresolved:[])];
  const seen=new Set();
  for(const entry of packet.edits){
    if(!entry||typeof entry.case_id!=='string'||seen.has(entry.case_id))throw Error('语义 ID 缺失或重复，未导入任何修改。');
    seen.add(entry.case_id);
    if(!roleById.has(entry.case_id)){unresolved.push(entry);continue;}
    if(!entry.patch||typeof entry.patch!=='object'||Array.isArray(entry.patch))throw Error(`修改结构无效：${entry.case_id}`);
    const patch={};
    for(const [key,value] of Object.entries(entry.patch)){
      if(!editable.includes(key)||typeof value!=='string')throw Error(`字段无效：${entry.case_id}.${key}`);
      if(key==='glyph'&&!Object.hasOwn(data.glyphs,value))throw Error(`不存在的字形：${value}`);
      if(key==='status'&&!Object.hasOwn(STATUSES,value))throw Error(`无法识别的评审状态：${value}`);
      if(value.length>(key==='note'?2000:500))throw Error(`字段过长：${entry.case_id}.${key}`);
      patch[key]=value;
    }
    parsed[entry.case_id]=patch;
  }
  return {parsed,unresolved};
}
async function importPacket(file) {
  try {
    if(file.size>8*1024*1024)throw Error('文件大于 8 MB，请选择此工作台导出的修改文件。');
    const text=await file.text(),packet=JSON.parse(text);
    if(packet.format==='agentmux.theme'){
      const imported=ThemeBridge.parseThemeFile(text);
      const preview={...draft.preview,themeId:imported.id,imported};currentTheme(preview);
      draft.preview=preview;
      draft.history.push({event_id:mintObjectId(),at:new Date().toISOString(),action:'import-theme',themeId:imported.id});
      saveDraft();applyPreview();renderInventory();renderInspector();toast('主题已导入此页预览，已有图标修改和备注保留');return;
    }
    const {parsed,unresolved}=validatePacket(packet),preview=packet.preview?validatePreview(packet.preview):draft.preview;
    const conflicts=Object.keys(parsed).filter(id=>changed(id)&&JSON.stringify(parsed[id])!==JSON.stringify(draft.edits[id]));
    if(conflicts.length)throw Error(`有 ${conflicts.length} 项与当前草稿冲突。请先导出并恢复当前草稿，再导入，避免覆盖你的修改。`);
    currentTheme(preview,{...draft.edits,...parsed});
    draft.edits={...draft.edits,...parsed};draft.unresolved=[...draft.unresolved,...unresolved];draft.preview=preview;
    const seen=new Set(draft.history.map(x=>x.event_id));
    for(const event of packet.history)if(event&&typeof event==='object'&&typeof event.event_id==='string'&&!seen.has(event.event_id)){draft.history.push(event);seen.add(event.event_id);}
    draft.history.push({event_id:mintObjectId(),at:new Date().toISOString(),action:'import',source_snapshot:packet.source_snapshot,roles:Object.keys(parsed)});
    saveDraft();applyPreview();renderInventory();renderInspector();
    if(packet.source_snapshot!==data.snapshot||unresolved.length)notice('导入文件来自不同源码快照。已保留可匹配语义项与未匹配记录，请核对后再交给 Agent。');
    toast(`已导入 ${Object.keys(parsed).length} 项修改${unresolved.length?`，${unresolved.length} 项待核对`:''}`);
  } catch(error){toast(`导入失败：${error.message}`);}
  finally{$('#import-file').value='';}
}
function renderDrafts() {
  const entries=Object.entries(draft.edits);
  $('#draft-list').innerHTML=entries.length?entries.map(([id,patch])=>{
    const r=roleById.get(id),e=effective(r);
    return `<article class="draft-entry"><header>${semantic(id,23)}<code>${escape(id)}</code></header><div class="draft-diff">${Object.entries(patch).map(([key,value])=>`<div>${{glyph:'图标',feature:'功能',meaning:'含义',note:'备注',status:'状态'}[key]}：<b>${escape(key==='status'?STATUSES[value]:value)}</b>${key==='glyph'?` <span>← ${escape(r.glyph)}</span>`:''}</div>`).join('')}</div></article>`;
  }).join(''):'<div class="empty"><strong>还没有修改</strong>选择一个图标，编辑它的用途或图形。</div>';
  $('#history-count').textContent=`${draft.history.length} 条操作历史${draft.unresolved.length?` · ${draft.unresolved.length} 项待核对`:''}`;
  $('#reset-all').disabled=!entries.length;
}
function attachEvents() {
  const animationLabels={none:'静态',work:'写写停停',stream:'光标推进',execute:'箭头前送',wait:'流沙等待',orbit:'短弧环行',feedback:'单次反馈',spin:'旋转加载'};
  $('#preview-animation').innerHTML=ThemeBridge.ICON_ANIMATIONS.map(value=>`<option value="${value}">${animationLabels[value]}</option>`).join('');
  $('#preview-animation').addEventListener('change',event=>{samplePresentation.animation=event.target.value;renderSamples();});
  $('#preview-color').addEventListener('input',event=>{samplePresentation.color=event.target.value;renderSamples();$('#inherit-color').disabled=false;});
  $('#inherit-color').disabled=true;
  $('#inherit-color').addEventListener('click',()=>{samplePresentation.color=undefined;renderSamples();$('#inherit-color').disabled=true;});
  $('#semantic-samples').addEventListener('click',event=>{const button=event.target.closest('[data-sample]');if(button)selectRole(button.dataset.sample,button);});
  for(const id of ['preview-theme','preview-mode'])$('#'+id).addEventListener('change',()=>{
    const preview={...draft.preview,themeId:$('#preview-theme').value,mode:$('#preview-mode').value};
    try{currentTheme(preview);draft.preview=preview;saveDraft();applyPreview();renderInventory();renderInspector();}
    catch(error){applyPreview();toast(`主题预览失败：${error.message} 原草稿保留。`);}
  });
  $('#export-theme').addEventListener('click',()=>{
    const text=ThemeBridge.serializeThemeFile(currentTheme()),url=URL.createObjectURL(new Blob([text],{type:'application/json'})),a=document.createElement('a');
    a.href=url;a.download='icon-workbench.agentmux-theme.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出完整主题，可在 AgentMux 外观设置中导入');
  });
  $('#categories').addEventListener('click',event=>{const b=event.target.closest('[data-category]');if(b)setCategory(b.dataset.category);});
  $('#mobile-category').addEventListener('change',event=>setCategory(event.target.value));
  $('#search').addEventListener('input',event=>{query=event.target.value;renderInventory();});
  $('#modified-only').addEventListener('change',event=>{modifiedOnly=event.target.checked;renderInventory();});
  for(const view of views)$('#view-'+view).addEventListener('click',()=>{
    mode=view;
    query='';$('#search').value='';
    renderInventory();$('#inventory-content').scrollTop=0;
  });
  $('#inventory-content').addEventListener('click',event=>{
    const card=event.target.closest('[data-glyph]'),row=event.target.closest('[data-role]'),design=event.target.closest('[data-motion-glyph]');
    if(design)openMotion(design.dataset.motionGlyph,design);
    if(card){const candidates=rows().filter(r=>r.glyph===card.dataset.glyph);selectRole(candidates.find(r=>r.id===activeId)?.id??candidates[0].id,card);}
    if(row){if(!['gallery','matrix'].includes(mode)){mode='matrix';category='all';query=row.dataset.role;modifiedOnly=false;$('#modified-only').checked=false;$('#search').value=query;renderCategories();}selectRole(row.dataset.role,row.querySelector('button')??row);}
  });
  $('#inventory-content').addEventListener('change',event=>{
    if(event.target.id==='mote-interactive'){
      motePreview?.dispose();motePreview=ThemeBridge.mountMotePreview($('#mote-preview'),{size:88,interactive:event.target.checked});
      $('#mote-stage').dataset.interactive=String(event.target.checked);
    }
  });
  $('#sample-lab').addEventListener('toggle',()=>{if(!$('#sample-lab').open){samplePresentation.animation='none';$('#preview-animation').value='none';renderSamples();}});
  window.addEventListener('hashchange',()=>{const next=window.location.hash.slice(1);if(views.includes(next)&&next!==mode){closeMotion();mode=next;query='';$('#search').value='';renderInventory();}});
  window.addEventListener('pagehide',()=>{motePreview?.dispose();motePreview=undefined;});
  window.addEventListener('pageshow',event=>{if(event.persisted&&mode==='mote')renderMote();});
  $('#motion-content').addEventListener('click',event=>{
    if(event.target.closest('#replay-motion')){
      $('#authored-demo').innerHTML=authoredDemoMarkup(motionGlyph,ThemeBridge.authoredDesigns[motionGlyph].motion.animation);
    }
    const pause=event.target.closest('#pause-motion');
    if(pause){
      const paused=pause.getAttribute('aria-pressed')!=='true';
      const carrier=$('#authored-demo .semantic-icon-motion');
      carrier.style.animationPlayState=paused?'paused':'running';
      carrier.style.setProperty('--icon-motion-play-state',paused?'paused':'running');
      pause.setAttribute('aria-pressed',paused);pause.textContent=paused?'继续循环':'暂停循环';
    }
    const role=event.target.closest('[data-motion-role]');
    if(role){
      const id=role.dataset.motionRole;
      closeMotion();mode='matrix';query=id;$('#search').value=id;category='all';modifiedOnly=false;$('#modified-only').checked=false;
      renderCategories();selectRole(id,$('#view-motion'));
    }
  });
  $('#motion-dialog').addEventListener('cancel',event=>{event.preventDefault();closeMotion();});
  $('#motion-dialog').addEventListener('close',()=>{
    // An older queued close must not clear a preview opened since that closure.
    if(!$('#motion-dialog').open)closeMotion();
  });
  $('#inspector-content').addEventListener('click',event=>{
    const reuse=event.target.closest('[data-reuse]');
    if(reuse){activeId=reuse.dataset.reuse;renderInventory();renderInspector();}
    if(event.target.closest('#choose-glyph')){$('#glyph-search').value='';renderPicker();$('#glyph-picker').showModal();$('#glyph-search').focus();}
    if(event.target.closest('#restore-role'))restoreRole(activeId);
  });
  $('#inspector-content').addEventListener('submit',event=>event.preventDefault());
  $('#inspector-content').addEventListener('input',event=>{
    if(['feature','meaning','note'].includes(event.target.name))patchRole(activeId,event.target.name,event.target.value);
  });
  $('#inspector-content').addEventListener('change',event=>{if(event.target.name==='status')patchRole(activeId,'status',event.target.value);});
  $('#glyph-search').addEventListener('input',renderPicker);
  $('#picker-grid').addEventListener('click',event=>{
    const choice=event.target.closest('[data-pick]');if(!choice)return;
    patchRole(activeId,'glyph',choice.dataset.pick);$('#glyph-picker').close();renderInspector();toast('已更换这一用途的图标');
  });
  document.addEventListener('click',event=>{const b=event.target.closest('[data-close]');if(b){if(b.dataset.close==='motion-dialog')closeMotion();else $('#'+b.dataset.close).close();}});
  $('#inspector').addEventListener('close',()=>{if(mobile())lastTrigger?.focus();});
  $('#import').addEventListener('click',()=>$('#import-file').click());
  $('#import-file').addEventListener('change',()=>{const file=$('#import-file').files[0];if(file)importPacket(file);});
  $('#copy').addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(packetText());toast('已复制修改包，可粘贴给 Agent');}
    catch{toast('浏览器未允许复制，请用“导出修改”下载同一份修改包。');}
  });
  $('#export').addEventListener('click',exportPacket);
  for(const id of ['draft-summary','mobile-drafts'])$('#'+id).addEventListener('click',()=>{renderDrafts();$('#draft-dialog').showModal();});
  $('#reset-all').addEventListener('click',()=>$('#confirm-dialog').showModal());
  $('#cancel-reset').addEventListener('click',()=>$('#confirm-dialog').close());
  $('#confirm-reset').addEventListener('click',()=>{
    try{currentTheme(draft.preview,{});}catch(error){toast(`撤回失败：${error.message} 原草稿保留。`);return;}
    draft.history.push({event_id:mintObjectId(),at:new Date().toISOString(),action:'restore-all',before:draft.edits,after:{},provenance:'user_entered'});
    draft.edits={};saveDraft();applyPreview();renderInventory();renderInspector();renderDrafts();$('#confirm-dialog').close();toast('已恢复全部原始定义，操作历史仍保留');
  });
  matchMedia('(max-width:950px)').addEventListener('change',()=>{
    const dialog=$('#inspector'),modal=dialog.matches(':modal');
    if(!['gallery','matrix'].includes(mode)){if(dialog.open)dialog.close();return;}
    if(mobile()){
      if(dialog.open&&!modal){dialog.close();dialog.showModal();}
    }else{
      if(modal)dialog.close();if(!dialog.open)dialog.show();
    }
  });
  document.addEventListener('keydown',event=>{
    if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)&&!document.querySelector('dialog:modal')){event.preventDefault();$('#search').focus();}
  });
}
async function init() {
  try {
    const [catalogResponse,manifestResponse]=await Promise.all([fetch('./catalog.json'),fetch('./review-manifest.json')]);
    if(!catalogResponse.ok||!manifestResponse.ok)throw Error('页面目录资源暂时无法读取，请刷新重试。');
    [data,manifest]=await Promise.all([catalogResponse.json(),manifestResponse.json()]);
    data.glyphs=ThemeBridge.glyphs;
    if(!data.roles?.length||data.roles.length!==ThemeBridge.catalog.icons.length||data.roles.some(role=>ThemeBridge.catalog.icons.find(icon=>icon.id===role.id)?.defaultGlyph!==role.glyph))throw Error('页面目录与共享图标版本不一致，请刷新重试。原草稿仍保留。');
    ThemeBridge.startThemeRuntime();
    roleById=new Map(data.roles.map(r=>[r.id,r]));sessionExportTime=new Date().toISOString();
    draft={schema:KEY,pageId:data.pageId,snapshot:data.snapshot,edits:{},history:[],unresolved:[],preview:{themeId:'graphite',mode:'light'}};
    try {
      const raw=localStorage.getItem(KEY);
      if(raw){
        const stored=JSON.parse(raw);
        const packet={schema:stored.schema,page_id:stored.pageId,history:stored.history,edits:Object.entries(stored.edits??{}).map(([case_id,patch])=>({case_id,patch})),unresolved:stored.unresolved};
        const checked=validatePacket(packet);
        draft={...draft,edits:checked.parsed,history:stored.history,unresolved:checked.unresolved,updatedAt:stored.updatedAt};
        try{draft.preview=validatePreview(stored.preview);}catch{notice('主题预览无法恢复，已保留图标草稿和历史。请重新选择预览主题。');}
        if(stored.snapshot!==data.snapshot){
          draft.history.push({event_id:mintObjectId(),at:new Date().toISOString(),action:'source-refresh',from:stored.snapshot,to:data.snapshot});
          notice('源码目录已更新，原有草稿与历史已保留。请核对修改；未匹配的记录会随导出保留。');
        }
      }
    } catch(error) {
      try{corruptRaw=localStorage.getItem(KEY);}catch{}
      storageAvailable=false;notice('旧草稿无法恢复或浏览器存储不可用。当前仍可编辑与导出；首次保存会尝试保留旧草稿备份。');
    }
    const count=new Set(data.roles.map(r=>r.glyph)).size;
    $('#totals').innerHTML=`<div><strong>${count}</strong><span>默认图形</span></div><div><strong>${data.roles.length}</strong><span>语义用途</span></div>`;
    $('#search-icon').innerHTML=icon('search',16);
    $('#snapshot-label').textContent=data.head.slice(0,8)+' · '+data.generatedAt.slice(0,10);
    $('#source-mode').textContent=data.sourceMode==='live'?'当前源码 · 自动刷新':'源码快照';
    $('#catalog-version').textContent=data.sourceMode==='live'?'当前源码 · 自动刷新':'发布快照';
    applyPreview();renderSamples();attachEvents();renderSaveState();renderCategories();renderInventory();renderInspector();
    window.iconReview={ready:true,buildPacket,sourceSnapshot:data.snapshot,exportTheme:()=>ThemeBridge.serializeThemeFile(currentTheme()),parseThemeFile:ThemeBridge.parseThemeFile};
  }catch(error){$('#inventory-content').textContent=error.message;$('#save-state').textContent='目录读取失败';$('#save-state').classList.add('error');}
}
init();
