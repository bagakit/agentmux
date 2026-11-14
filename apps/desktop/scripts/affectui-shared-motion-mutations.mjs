const components = 'packages/client-ui/src/components/'
const interaction = `${components}AgentInteractionCard.tsx`
const disclosure = `${components}ConversationDisclosure.tsx`

export const sharedMotionMutations = {
  owningConfig: 'packages/client-ui/vitest.config.ts',
  tests: ['packages/client-ui/test/affectui-motion-consumers.test.tsx'],
  sources: [interaction, disclosure, `${components}Button.tsx`, `${components}ConversationToolTrace.tsx`,
    'packages/client-ui/src/styles/buttons.css', 'packages/client-ui/src/styles/conversation-tool-trace.css',
    'packages/client-ui/src/styles/interaction.css', 'packages/core/src/agent-interaction-state.ts',
    'apps/desktop/scripts/affectui-shared-motion-mutations.mjs', 'test/fixture-values.mjs'],
  mutations: [
    { label: 'native-disabled-button', file: `${components}Button.tsx`, before: 'return <button {...props} type={type}', after: 'return <button {...props} disabled={false} type={type}' },
    { label: 'first-open-is-lazy', file: disclosure, before: 'open || presented ? <div className={className}>', after: 'true ? <div className={className}>' },
    { label: 'closing-payload-is-inert', file: disclosure, before: 'inert={!open} aria-hidden={!open}', after: 'inert={false} aria-hidden={!open}' },
    { label: 'closing-restores-trigger-focus', file: disclosure, before: 'if (!open && panel?.contains(panel.ownerDocument.activeElement)) triggerRef.current?.focus()', after: 'if (false) triggerRef.current?.focus()' },
    { label: 'original-payload-copy', file: `${components}ConversationToolTrace.tsx`, before: 'const text = isCall ? part.input : part.output', after: 'const text = isCall ? part.input.trim() : part.output.trim()' },
    { label: 'delivery-is-not-native-completion', file: interaction, before: 'Boolean(receipt?.nativeCompleted)', after: 'Boolean(receipt)' },
    { label: 'saved-is-not-completed', file: interaction, before: "receipt!.delivery !== 'saved' && receipt!.delivery !== 'unknown'", after: 'true' },
    { label: 'receipt-target-must-match', file: interaction, before: 'originalResponse.current !== null && agentInteractionOperationReceiptMatches', after: 'originalResponse.current !== null || agentInteractionOperationReceiptMatches' },
    { label: 'old-response-cannot-touch-new-request', file: interaction, before: 'return operation.current === original && agentInteractionRequestsMatch(currentRequest.current, original.expectedRequest)', after: 'return true' },
    { label: 'new-request-resets-presentation', file: interaction, before: "setPhase('idle'); setObservation({ receipt: null, failure: null, receiptUnconfirmed: false }); setSelectedOption(null); setDetailsOpen(false)", after: 'setObservation({ receipt: null, failure: null, receiptUnconfirmed: false }); setSelectedOption(null); setDetailsOpen(false)' },
    { label: 'semantic-request-identity', file: interaction, before: 'if (agentInteractionRequestsMatch(requestIdentity.current, request)) return', after: 'if (false) return' },
    { label: 'uncommitted-render-cannot-revoke-request', file: interaction, before: 'const currentRequest = useRef(request)', after: 'const currentRequest = useRef(request)\n  currentRequest.current = request' },
    { label: 'recovered-inspection-clears-error', file: interaction, before: 'return { receipt: matched ? value : current.receipt, failure: null, receiptUnconfirmed: !matched }', after: 'return { receipt: matched ? value : current.receipt, failure: current.failure, receiptUnconfirmed: !matched }' },
    { label: 'old-inspection-error-cannot-veto-completion', file: interaction, before: 'setObservation(current => hasNativeCompletion(current.receipt) ? current : { ...current, failure: presentError(error) })', after: 'setObservation(current => ({ ...current, failure: presentError(error) }))' },
    { label: 'completion-is-not-downgraded', file: interaction, before: 'if (hasNativeCompletion(current.receipt)) return current', after: 'if (false) return current' },
    { label: 'foreign-receipt-is-explicitly-unknown', file: interaction, before: 'receiptUnconfirmed: !matched', after: 'receiptUnconfirmed: false' },
    { label: 'uncorrelated-is-not-sent', file: interaction, before: ": receiptUnconfirmed || receipt?.delivery === 'unknown' ? labels.unknown", after: ": receipt?.delivery === 'unknown' ? labels.unknown" },
    { label: 'uncorrelated-retains-inspection', file: interaction, before: "(receiptUnconfirmed || receipt?.delivery === 'unknown' || receipt?.delivery === 'saved')", after: "(receipt?.delivery === 'unknown' || receipt?.delivery === 'saved')" },
    { label: 'uncorrelated-retains-terminal', file: interaction, before: 'onOpenTerminal && !readOnly && !reason', after: 'false' },
    { label: 'missing-inspection-is-visible', file: interaction, before: '{labels.inspectionUnavailable ?? defaultRecoveryLabels.inspectionUnavailable}', after: "{''}" },
    { label: 'caller-status-cannot-hide-recovery', file: interaction, before: 'const requestStatus = <>', after: 'const requestStatus = responseStatus ?? <>' }
  ]
}
