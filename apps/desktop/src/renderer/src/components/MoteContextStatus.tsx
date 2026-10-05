import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import type { MoteWorkbenchProjectionResult } from '../lib/mote-workbench-projection'
import type { ServiceNoticeItem } from '../lib/use-service-notices'
import { pinPmoTeamsTopicFloating } from '../lib/pmo-teams-topic-floating'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import type { MoteContextFailure } from '../../../shared/mote-context-observation'

const steps = { 'ensure-mote': '准备 Mote 资料', 'read-discussion': '读取原讨论', 'open-space': '在 Space 中打开' }

/** A quiet projection of the original failure/address owners; collapse never resolves either fact. */
export function MoteContextStatus({ scope, visible, failures, pending, identityIssue, projection, locationName, onRetry, onSelect }: {
  scope: string
  visible: boolean
  failures: readonly MoteContextFailure[]
  pending(failure: MoteContextFailure): boolean
  identityIssue: string | null
  projection: MoteWorkbenchProjectionResult | null | undefined
  locationName(reference: WorkbenchProjectionSelection, index: number): string
  onRetry(failure: MoteContextFailure): void
  onSelect(reference: WorkbenchProjectionSelection): void
}) {
  const locationIssue = identityIssue ?? projection?.issue
  const locationKind = identityIssue ? 'identity' : projection?.issueKind
  const notices: ServiceNoticeItem[] = []
  for (const failure of failures) notices.push({ id: failure.step, cause: failure.cause, observedAt: failure.observedAt,
    notice: { kind: 'indeterminate', notice: {
      step: steps[failure.step] + '未完成', mode: '原对话和输入保留。', restore: '查看原始原因后，重试这一步。'
    } } })
  if (locationIssue) notices.push({ id: 'discussion-location', cause: locationIssue,
    notice: { kind: 'indeterminate', notice: {
      step: locationKind === 'identity' ? '原 Agent 待核实' : locationKind === 'choice' ? '选择讨论位置' : '原位置待核实',
      mode: locationKind === 'parent-available' ? '原讨论仍在；上次选中的 Region 已不在其中。' : '原讨论、成员和引用都已保留。',
      restore: projection?.choices.length ? '选择一个位置重新核对。' : '从原 Tab 查看；位置确认后此状态会更新。'
    } } })
  const title = notices.length > 1 ? '上下文待核实' : failures.length ? failures[0]?.step === 'open-space' ? 'Space 打开待重试' : '资料准备待恢复' : notices[0]?.notice.notice.step
  return <div className="mote-context-status" onPointerDownCapture={pinPmoTeamsTopicFloating}
    onClickCapture={pinPmoTeamsTopicFloating}>
    <ServiceNoticeDisclosure scope={scope} notices={notices} {...(title ? { title } : {})} detailsTitle="上下文详情" persistentTitle visible={visible}>
      {notices.map(item => { const failure = failures.find(value => value.step === item.id); return <section className="mote-context-status__item" key={item.id}>
        <ServiceWindowNotice notice={item.notice} />
        {item.id === 'discussion-location' ? <p className="mote-context-status__cause">{locationIssue}</p> : failure ? <>
          <p className="mote-context-status__cause">{failure.cause}</p>
          <details className="mote-context-status__target"><summary>原目标与记录时间</summary>
            <dl><dt>Mote</dt><dd>{failure.target.topicId}</dd><dt>Tab</dt><dd>{failure.target.tabId ?? '未选择讨论'}</dd>
              <dt>Host</dt><dd>{failure.target.hostId}</dd><dt>目录</dt><dd>{failure.target.directoryPath}</dd>
              <dt>记录时间</dt><dd>{new Date(failure.observedAt).toISOString()}</dd>
              {failure.target.reference ? <><dt>原位置</dt><dd>{JSON.stringify(failure.target.reference)}</dd></> : null}</dl>
          </details>
          <button type="button" className="small-button" aria-label={steps[failure.step] + '：重试'} data-mote-context-retry={failure.step} disabled={pending(failure)}
            onClick={() => onRetry(failure)}>{pending(failure) ? '正在重试…' : '重试这一步'}</button>
        </> : null}
        {item.id === 'discussion-location' ? <div className="mote-context-status__locations">
          {projection?.choices.map((reference, index) => <button type="button" className="small-button"
            key={JSON.stringify(reference)} onClick={() => onSelect(reference)}>{locationName(reference, index)}</button>)}
        </div> : null}
      </section> })}
    </ServiceNoticeDisclosure>
  </div>
}
