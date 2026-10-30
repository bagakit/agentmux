import type { AgentInputSubmissionReceipt, AgentInputWaitReason } from '@agentmux/core'

/** Original typed input stages only; presentation grants no dispatch or rejoin authority. */
type Waiting = Pick<AgentInputWaitReason, 'phase' | 'reason' | 'wake'>
export function originalInputExplanation(status: AgentInputSubmissionReceipt['status'] | 'saved' | 'bytes-accepted' | 'hook-written' | 'acp-acknowledged' | null, waiting?: Waiting | null): { title: string; detail: string } {
  if (status === 'admitted') return { title: 'Agent accepted this input', detail: 'This receipt applies to this message only.' }
  if (status === 'saved') return { title: 'Saved input', detail: 'The input is saved. Delivery and Agent acceptance are not yet confirmed.' }
  if (status === 'hook-written') return { title: 'Input hook written', detail: 'The input reached its hook. Agent acceptance is not yet confirmed.' }
  if (status === 'acp-acknowledged') return { title: 'CLI acknowledgement received', detail: 'The CLI acknowledged this input. Agent acceptance is not yet confirmed.' }
  if (status === 'terminal-confirmed' || status === 'bytes-accepted') return { title: 'Input written to terminal', detail: 'Agent acceptance is not yet confirmed. This message is not sent again.' }
  if (status === 'launch-carried') return { title: 'Recovery startup carried the original message', detail: 'Agent acceptance is unconfirmed. This original message will not be sent again.' }
  if (status === 'waiting') {
    const title = waiting?.phase === 'runtime' ? 'Input waits for its Runtime' : waiting?.phase === 'session' ? 'Input waits for its session' :
      waiting?.phase === 'authorization' ? 'Input waits for permission review' : waiting?.phase === 'observer' ? 'Input observation ended' :
      waiting?.reason === 'original-target-changed' ? 'Saved input target changed' : waiting?.phase === 'native-environment' ? 'Agent environment check incomplete' :
      waiting?.phase === 'input-environment' ? 'Input environment check incomplete' : waiting?.phase === 'service' ? 'Input service check failed' : 'Saved input is waiting'
    return { title, detail: waiting?.wake === 'explicit-rejoin' ? 'This saved input needs an explicit resume to continue.' : waiting ? 'Its recovery condition is still pending. The same input is kept.' : 'No finer waiting reason was recorded.' }
  }
  if (status === 'stopped') return { title: 'Original input waiting stopped', detail: 'The saved input and its original receipt remain available.' }
  if (status === 'not-applied') return { title: 'Original input was not applied', detail: 'Check its exact original receipt and available actions.' }
  if (status === 'unknown') return { title: 'Input result is unknown', detail: 'Delivery and Agent acceptance are unconfirmed. Check this saved input.' }
  return { title: 'Input result unavailable', detail: 'Agent acceptance is not yet confirmed. Check this saved input.' }
}

