import { BROWSER_PROFILE_ENVIRONMENT_FIELDS, type BrowserProfileEnvironment } from '@agentmux/core/control'
import type { BrowserProfileSummary } from '../../../../shared/contracts'
import { browserProfiles } from '../../lib/browser-profiles'

const LABELS: Record<keyof BrowserProfileEnvironment, string> = {
  userAgent: 'User agent',
  acceptLanguages: 'Languages',
  timeZone: 'Time zone',
  locale: 'Formats',
  geolocation: 'Location',
  userAgentMetadata: 'Client hints',
  screen: 'Screen',
  hardwareConcurrency: 'CPU threads',
  fingerprint: 'Fingerprint'
}

function EnvironmentValue({
  field,
  environment
}: {
  field: keyof BrowserProfileEnvironment
  environment: BrowserProfileEnvironment | undefined
}) {
  const value = environment?.[field]
  if (value === undefined) return <span>Engine default</span>
  if (field === 'fingerprint') {
    const fingerprint = environment!.fingerprint!
    return <span>Seed {fingerprint.seed} · {fingerprint.surfaces.length} selected surfaces</span>
  }
  if (field === 'screen')
    return (
      <span>
        {environment!.screen!.width} × {environment!.screen!.height}
      </span>
    )
  if (field === 'geolocation') {
    const point = environment!.geolocation!
    return (
      <span>
        {point.latitude}°, {point.longitude}° · accuracy {point.accuracy} m
      </span>
    )
  }
  if (field === 'userAgentMetadata') {
    const hints = environment!.userAgentMetadata!
    const values = [
      ['Platform', hints.platform],
      ['Platform version', hints.platformVersion],
      ['Architecture', hints.architecture],
      ['Device model', hints.model],
      ['Mobile', String(hints.mobile)],
      ['Bitness', hints.bitness],
      ['WOW64', hints.wow64 === undefined ? undefined : String(hints.wow64)],
      [
        'Brands',
        hints.brands?.map((row) => `${JSON.stringify(row.brand)} ${JSON.stringify(row.version)}`).join(', ')
      ],
      [
        'Full versions',
        hints.fullVersionList
          ?.map((row) => `${JSON.stringify(row.brand)} ${JSON.stringify(row.version)}`)
          .join(', ')
      ]
    ] as const
    return (
      <>
        <span>
          {hints.platform || 'Empty platform'}
          {hints.platformVersion ? ' ' + hints.platformVersion : ''} ·{' '}
          {hints.architecture || 'Empty architecture'} · {hints.mobile ? 'Mobile' : 'Desktop'}
        </span>
        <details>
          <summary>Client hint details</summary>
          <dl>
            {values.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value === undefined ? 'Engine default' : value === '' ? 'Empty' : value}</dd>
              </div>
            ))}
          </dl>
        </details>
      </>
    )
  }
  return <span>{Array.isArray(value) ? value.join(', ') : String(value)}</span>
}

export function ProfileEnvironmentApplication({
  profile,
  busy,
  onReapply
}: {
  profile: BrowserProfileSummary
  busy: boolean
  onReapply(): void
}) {
  const application = profile.environmentApplication,
    pages = application?.pages ?? [],
    uncertain = application?.status === 'unknown',
    pending = pages.some((page) => page.status === 'pending')
  const summary = uncertain
    ? 'Application unconfirmed'
    : pending
      ? 'Waiting for native application'
      : pages.length
        ? `Applied to ${pages.length} ${pages.length === 1 ? 'Browser' : 'Browsers'}`
        : profile.environment
          ? 'No current page application'
          : 'Engine defaults'
  return (
    <details className="profile-environment__application">
      <summary>
        <span>{summary}</span>
        <small>Application scope</small>
      </summary>
      <p className="browser-profile-editor__quiet">
        Saved settings and native application are separate. First-script, subdocument and Worker coverage is
        unconfirmed.
      </p>
      {application?.reason ? <p className="browser-profile-editor__quiet">{application.reason}</p> : null}
      {pages.map((page) => (
        <div className="profile-environment__page" key={page.browserId}>
          <strong>{page.browserId}</strong>
          <span>
            {page.status === 'applied'
              ? 'Native settings applied'
              : page.status === 'pending'
                ? 'Pending'
                : 'Unconfirmed'}
          </span>
          <dl>
            {BROWSER_PROFILE_ENVIRONMENT_FIELDS.filter((key) => page.fields[key]).map((key) => (
              <div key={key}>
                <dt>{LABELS[key]}</dt>
                <dd>
                  <EnvironmentValue field={key} environment={profile.environment} />
                  <small>
                    {page.fields[key]!.status === 'applied' ? 'Applied' : 'Unconfirmed'}
                    {page.fields[key]!.reason ? ` · ${page.fields[key]!.reason}` : ''}
                  </small>
                </dd>
              </div>
            ))}
          </dl>
          <small>
            Current document: {page.scope.currentDocument} · Later navigation: {page.scope.futureNavigation}
          </small>
        </div>
      ))}
      <div className="profile-environment__status-actions">
        <button
          type="button"
          className="browser-profile-editor__link"
          onClick={() => void browserProfiles.refresh()}
        >
          Refresh status
        </button>
        {uncertain ? (
          <button type="button" className="browser-profile-editor__link" disabled={busy} onClick={onReapply}>
            Reapply saved settings
          </button>
        ) : null}
      </div>
    </details>
  )
}
