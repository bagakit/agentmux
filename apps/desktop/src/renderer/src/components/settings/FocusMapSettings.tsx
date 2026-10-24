import { useState, type CSSProperties } from 'react'
import { FOCUS_MAP_FORMS, FOCUS_MAP_INFORMATION, FOCUS_MAP_LEVEL_COUNTS, focusMapInformationChoices, focusMapPreset, type FocusMapLodLevel, type FocusMapPreferences } from '../../../../shared/focus-map-preferences'
import { collaborationEnvelope, collaborationVisiblePath } from '../../lib/collaboration-map-geometry'
import { collaborationIdentityInk, collaborationMapContentInk, collaborationMapLod, collaborationMapTextBudget, collaborationOverviewScale, collaborationVisibleHull } from '../../lib/collaboration-map-lod'
import type { CollaborationLayoutBox, CollaborationPath } from '../../lib/collaboration-layout-engine'
import type { FocusContext } from '../../lib/focus-context'
import { AgentContextContent } from '../AgentContextContent'
import { ResolvedAgentAvatar } from '../AgentAvatar'
import { CollaborationCompactState, CollaborationEssentialState } from '../CollaborationCompactState'

const forms = { point: 'Point', compact: 'Compact identity', card: 'Card' }, information = { identity: 'Identity', status: 'Identity + status', summary: 'Identity + status + summary' }
const member = (id: string, x: number, y: number): CollaborationLayoutBox => ({ kind: 'agent', id, areaId: 'example', folded: false, x, y, width: 248, height: 94 })
const members = [member('a', 45, 75), { ...member('b', 330, 220), width: 14, height: 14 }]
const area: Extract<CollaborationLayoutBox, { kind: 'area' }> = { kind: 'area', id: 'example', areaId: 'example', folded: false, x: 0, y: 0, width: 400, height: 290, heading: { x: 28, y: 12, width: 170, height: 38 } }
const route: CollaborationPath = { id: 'example', sourceHandle: 'out', targetHandle: 'in', labelX: 315, labelY: 170, bounds: { x: 293, y: 122, width: 37, height: 105 }, points: [{ x: 293, y: 122 }, { x: 310, y: 122 }, { x: 312, y: 227 }, { x: 330, y: 227 }], path: 'M 293 122 C 310 122 312 227 330 227' }

export function FocusMapSettings({ value, onChange }: { value: FocusMapPreferences; onChange(value: FocusMapPreferences): void }) {
  function changeLevel(index: number, patch: Partial<FocusMapLodLevel>) {
    const levels = value.levels.map((level, at) => at === index ? { ...level, ...patch } : level)
    onChange({ ...value, levels })
  }
  return <div className="focus-map-settings">
    <fieldset className="focus-map-settings__boundaries" data-settings-field="map.boundary" data-settings-preview-label="Region boundary"><legend>Region boundary</legend>{(['bezier', 'polygon'] as const).map(boundary => <label key={boundary} data-selected={value.boundary === boundary}>
      <input type="radio" name="focus-map-boundary" checked={value.boundary === boundary} onChange={() => onChange({ ...value, boundary })} />
      <svg viewBox="0 0 400 290" aria-hidden="true"><path d={collaborationEnvelope(area, members, boundary)} />{members.map(box => <rect key={box.id} x={box.x} y={box.y} width={box.width} height={box.height} rx="8" />)}</svg><span>{boundary === 'bezier' ? 'Bezier curves' : 'Polygon'}</span>
    </label>)}</fieldset>
    <label className="focus-map-settings__field" data-settings-field="map.levelCount" data-settings-preview-label="LOD levels"><span>LOD levels</span><select aria-label="LOD levels" value={value.levels.length} onChange={event => onChange({ ...value, levels: focusMapPreset(Number(event.target.value) as 2 | 3 | 4) })}>{FOCUS_MAP_LEVEL_COUNTS.map(count => <option key={count} value={count}>{count} levels</option>)}</select></label>
    <p className="focus-settings-description">Changing the count starts a new preset. Adjust each level below, from farthest to closest.</p>
    <div className="focus-map-settings__levels">{value.levels.map((level, index) => <details key={index} open={index === value.levels.length - 1} data-settings-field={`map.levels.${index}`}>
      <summary><strong>Level {index + 1}</strong><span>{forms[level.form]} · {information[level.information]}</span></summary>
      <label className="focus-map-settings__field"><span>Form</span><select aria-label={`Level ${index + 1} form`} value={level.form} onChange={event => {
        const form = event.target.value as FocusMapLodLevel['form'], choices = focusMapInformationChoices(form)
        // This visible authored batch keeps the chosen form and its compatible
        // information together; no other level or saved setting is changed.
        changeLevel(index, { form, information: choices.includes(level.information) ? level.information : choices.at(-1)! })
      }}>{FOCUS_MAP_FORMS.map(form => <option key={form} value={form}>{forms[form]}</option>)}</select></label>
      <label className="focus-map-settings__field"><span>Information</span><select aria-label={`Level ${index + 1} information`} value={level.information} onChange={event => changeLevel(index, { information: event.target.value as FocusMapLodLevel['information'] })}>{FOCUS_MAP_INFORMATION.filter(info => focusMapInformationChoices(level.form).includes(info)).map(info => <option key={info} value={info}>{information[info]}</option>)}</select></label>
      {index === 0 ? <p className="focus-settings-description">Fixed starting view at 5%. Essential attention and unconfirmed state remain visible.</p> : <div className="focus-map-settings__range">{(['from', 'to'] as const).map(key => <label key={key}><span>{key === 'from' ? 'Starts at' : 'Complete at'}</span><span><input type="number" aria-label={`Level ${index + 1} ${key === 'from' ? 'start' : 'complete'} zoom`} min="5" max="140" step="1" value={Number.isFinite(level[key]) ? Math.round(level[key] * 10000) / 100 : ''} onChange={event => changeLevel(index, { [key]: event.target.value === '' ? NaN : Number(event.target.value) / 100 })} /><small>%</small></span></label>)}</div>}
    </details>)}</div>
  </div>
}

/** Held example facts use the production hull, endpoint, ink and content owners.
 * This preview has no Agent actions, source leases or synthetic activity. */
export function FocusMapPreview({ value, contexts, lastValid }: { value: FocusMapPreferences; contexts: readonly FocusContext[]; lastValid: boolean }) {
  const [zoom, setZoom] = useState(.82), lod = collaborationMapLod(zoom, value), ink = collaborationMapContentInk(lod.detail)
  return <div className="focus-map-preview">
    <label className="focus-map-preview__zoom"><span>Preview zoom</span><input type="range" aria-label="Map preview zoom" min="5" max="140" value={Math.round(zoom * 100)} onChange={event => setZoom(Number(event.target.value) / 100)} /><output>{Math.round(zoom * 100)}%</output></label>
    {lastValid ? <p role="status" className="settings-inline-error">Showing the last valid Map preview. Correct the draft before saving.</p> : null}
    <div className="focus-map-preview__canvas" aria-label="Example Map" data-boundary={value.boundary} data-levels={value.levels.length}>
      <div className="focus-map-preview__world" style={{ width: 400, height: 290, transform: `translate(-50%, -50%) scale(${zoom})` }}>
        <svg width="400" height="290" aria-hidden="true"><path className="focus-map-preview__contour" d={collaborationEnvelope(area, members, value.boundary)} /><path className="focus-map-preview__route" d={collaborationVisiblePath(route, members[0]!, members[1]!, zoom, 14, 6, 6, 6, value)} /><text x="28" y="35">Example project</text></svg>
        {members.map((box, index) => {
          const hull = collaborationVisibleHull(box, zoom, 14, 6, value), context = contexts[index]!, scale = collaborationOverviewScale(box, zoom), identityInk = collaborationIdentityInk(hull.width, zoom, lod.identity, scale, 11)
          return <div key={box.id} className="focus-map-preview__agent" style={{ left: hull.x, top: hull.y, width: hull.width, height: hull.height, borderRadius: hull.radius }}>
            {box.width <= 28 ? <span className="focus-map-preview__point" aria-hidden="true" /> : <div className="focus-map-preview__identity" style={{ opacity: ink.identity }}><span style={{ left: identityInk.avatarCenter, transform: `translate(-50%, -50%) scale(${scale + (1 - scale) * lod.identity})` }}><ResolvedAgentAvatar label="Example Executor" providerId="codex" size={22 - 2 * lod.identity} /><CollaborationEssentialState context={context} /></span><strong style={{ left: identityInk.nameLeft, opacity: identityInk.opacity, fontSize: identityInk.fontSize, marginTop: -7 * lod.status }}>{context.name}</strong>{lod.identity > 0 ? <CollaborationCompactState context={context} progress={lod.status} left={identityInk.nameLeft} opacity={identityInk.opacity} zoom={zoom} /> : null}</div>}
            {box.width > 28 && ink.detail > 0 ? <div className="focus-context focus-context--card focus-map-preview__detail" aria-hidden="true" style={{ opacity: ink.detail, ...collaborationMapTextBudget(zoom) } as CSSProperties}><AgentContextContent context={context} presentation="card" identity={<ResolvedAgentAvatar label="Example Executor" providerId="codex" size={18} />} disclosure={{ status: lod.status, summary: lod.summary }} /></div> : null}
          </div>
        })}
      </div>
    </div>
  </div>
}
