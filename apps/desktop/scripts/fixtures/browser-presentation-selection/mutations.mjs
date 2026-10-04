export const mutations = {
  'drop-tab-sibling': ['selector', "scope?.kind === 'tab' ? scope.tabId === location.tabId", "scope?.kind === 'tab' ? scope.tabId === location.tabId && reference.regionId === location.regionId"],
  'drop-zone-sibling': ['selector', "scope?.kind === 'zone' ? true", "scope?.kind === 'zone' ? reference.regionId === location.regionId"],
  'admit-region-sibling': ['selector', "scope?.kind === 'region' && scope.regionId === location.regionId && reference.regionId === location.regionId", "scope?.kind === 'region'"],
  'guess-first-occurrence': ['selector', 'selected.length === 1', 'selected.length > 0'],
  'take-mote-preview': ['selector', '    const reference = target.reference, location = occurrence.location', "    if (target.surface === 'mote') return true\n    const reference = target.reference, location = occurrence.location"],
  'drop-independent-selection': ['stage', 'void geometryWriter.current?.(next.bounds, selectionIntent.current)', 'void Promise.resolve()'],
  'reclaim-on-ordinary-resize': ['stage', '(inputChosen.current === null || intentRevision === inputIntentRevision.current)', 'true'],
  'overwrite-newer-main-owner': ['stage', 'if (ownerRevision.current === selectedAt) inputChosen.current = lease.leaseId', 'inputChosen.current = lease.leaseId'],
  'retire-new-intent-on-own-pending-event': ['stage', 'if (event.leaseId !== inputSelectionLease.current || event.leaseId === null) inputIntentRevision.current += 1', 'inputIntentRevision.current += 1'],
  'keep-queued-intent-after-foreign-owner': ['stage', 'if (event.leaseId !== inputSelectionLease.current || event.leaseId === null) inputIntentRevision.current += 1', 'void 0'],
  'drop-owner-release-recovery': ['stage', '[inputSelected, media.ownerClearedRevision, geometry]', '[inputSelected, geometry]'],
  'drop-survey-explicit-priority': ['selector', 'return explicit.length === 1 ? explicit[0]!.occurrence.presentationId : selected.length === 1 ? selected[0]!.occurrence.presentationId : null', 'return selected.length === 1 ? selected[0]!.occurrence.presentationId : null'],
  'drop-survey-sole-fallback': ['selector', 'return explicit.length === 1 ? explicit[0]!.occurrence.presentationId : selected.length === 1 ? selected[0]!.occurrence.presentationId : null', "return explicit.length === 1 ? explicit[0]!.occurrence.presentationId : state.mainSurface === 'survey' ? null : selected.length === 1 ? selected[0]!.occurrence.presentationId : null"],
  'keep-entity-wide-owner': ['stage', 'inputChosen.current !== lease.leaseId', '!inputChosen.current'],
  'drop-queued-intent-guard': ['stage', 'lease.current === registered && latest.current.inputSelected && geometry().visible', 'lease.current === registered && geometry().visible'],
  'drop-current-intent-guard': ['stage', 'lease.current === registered && latest.current.inputSelected && geometry().visible', 'lease.current === registered && latest.current.inputSelected'],
  'steal-editor-focus': ['stage', "{ kind: 'select', focus: 'preserve' }", "{ kind: 'select' }"],
  'accept-unconfirmed-owner': ['stage', "if (receipt.outcome !== 'selected') throw new Error", 'if (false) throw new Error'],
  'repeat-system-capture': ['stage', 'if (captureFailed.current) return Promise.resolve()', 'void 0'],
  'skip-native-geometry': ['stage', 'await api.browser.updatePresentation(registered.leaseId, bounds ? { visible: true, bounds } : { visible: false })', 'void 0'],
  'revive-unmounted-writer': ['stage', 'if (bounds && !cancelled) {\n          void media.registered(registered, latest.current.inputSelected, true, () => !cancelled && inputCurrent(registered), intentRevision).then', 'if (bounds) {\n          void media.registered(registered, latest.current.inputSelected, true, () => true, intentRevision).then']
}
export const owners = {
  selector: 'apps/desktop/src/renderer/src/lib/browser-presentation-selection.ts',
  stage: 'apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx'
}
