import { BROWSER_PROFILE_FINGERPRINT_SURFACES, type BrowserProfileFingerprintSurface } from '@agentmux/core/control'
import { Button } from '@agentmux/client-ui/components/Button'
import { NativeSelect, Switch, TextInput } from '@agentmux/client-ui/input'
import type { EnvironmentBrand, ProfileEnvironmentFields } from '../../lib/browser-profile-environment-form'

type TextField = {
  [K in keyof ProfileEnvironmentFields]-?: ProfileEnvironmentFields[K] extends string ? K : never
}[keyof ProfileEnvironmentFields]

const fingerprintLabels: Record<BrowserProfileFingerprintSurface, string> = {
  fonts: 'Font metrics', audio: 'Offline audio', canvas: 'Canvas readback',
  clientRects: 'Element coordinates', webgl: 'WebGL vendor and renderer'
}

export function ProfileFingerprintFields({ value, onChange }: {
  value: ProfileEnvironmentFields['fingerprint']
  onChange(value: ProfileEnvironmentFields['fingerprint']): void
}) {
  return <details className="profile-environment__group profile-environment__fingerprint">
    <summary>Fingerprint{value?.surfaces.length ? <small>{value.surfaces.length} overrides</small> : null}</summary>
    <div className="profile-environment__grid profile-environment__fingerprint-seed">
      <label className="profile-environment__field"><span>Seed</span>
        <TextInput aria-label="Fingerprint seed" inputMode="numeric" value={value?.seed ?? ''} placeholder="Engine default"
          onChange={event => onChange(event.target.value ? { seed: event.target.value, surfaces: value?.surfaces ?? [] } : undefined)} />
      </label>
      <Button type="button" onClick={() => {
        const [seed] = crypto.getRandomValues(new Uint32Array(1))
        onChange({ seed: String(seed), surfaces: value?.surfaces ?? [] })
      }}>Generate seed</Button>
    </div>
    {value ? <div className="profile-environment__grid">
      {BROWSER_PROFILE_FINGERPRINT_SURFACES.map(surface => <label key={surface} className="profile-environment__choice">
        <Switch checked={value.surfaces.includes(surface)} onChange={event => onChange({ seed: value.seed,
          surfaces: event.target.checked ? [...value.surfaces, surface] : value.surfaces.filter(item => item !== surface) })} />
        {fingerprintLabels[surface]}
      </label>)}
    </div> : null}
    <small>Choose which document APIs use the seed. Saved selections carry through navigation.</small>
  </details>
}

function BrandRows({
  label,
  value,
  onChange
}: {
  label: string
  value: EnvironmentBrand[] | null
  onChange(value: EnvironmentBrand[] | null): void
}) {
  return (
    <div className="profile-environment__brands">
      <div className="profile-environment__group-heading">
        <strong>{label}</strong>
        {value === null ? (
          <button type="button" className="browser-profile-editor__link" onClick={() => onChange([])}>
            Customize
          </button>
        ) : (
          <button type="button" className="browser-profile-editor__link" onClick={() => onChange(null)}>
            Use default
          </button>
        )}
      </div>
      {value === null ? (
        <small>Engine default</small>
      ) : (
        <>
          {value.map((row, index) => (
            <div className="profile-environment__brand" key={index}>
              <TextInput
                aria-label={`${label} brand ${index + 1}`}
                placeholder="Brand"
                value={row.brand}
                onChange={(event) =>
                  onChange(
                    value.map((item, i) => (i === index ? { ...item, brand: event.target.value } : item))
                  )
                }
              />
              <TextInput
                aria-label={`${label} version ${index + 1}`}
                placeholder="Version"
                value={row.version}
                onChange={(event) =>
                  onChange(
                    value.map((item, i) => (i === index ? { ...item, version: event.target.value } : item))
                  )
                }
              />
              <button
                type="button"
                className="browser-profile-editor__link"
                aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="browser-profile-editor__link"
            onClick={() => onChange([...value, { brand: '', version: '' }])}
          >
            Add brand
          </button>
        </>
      )}
    </div>
  )
}

export function ProfileEnvironmentFieldsEditor({
  fields,
  change
}: {
  fields: ProfileEnvironmentFields
  change(patch: Partial<ProfileEnvironmentFields>): void
}) {
  const field = (
    name: TextField,
    label: string,
    options: { placeholder?: string; type?: 'text' | 'number'; step?: string } = {}
  ) => (
    <label className="profile-environment__field">
      <span>{label}</span>
      <TextInput
        value={fields[name]}
        aria-label={label}
        placeholder={options.placeholder ?? 'Engine default'}
        type={options.type ?? 'text'}
        step={options.step}
        spellCheck={false}
        onChange={(event) => change({ [name]: event.target.value })}
      />
    </label>
  )
  return (
    <>
      <div className="profile-environment__grid">
        {field('languages', 'Languages', { placeholder: 'Engine default · fr-FR, en' })}
        {field('timeZone', 'Time zone', { placeholder: 'Engine default · Europe/Paris' })}
        {field('locale', 'Formats (locale)', { placeholder: 'Engine default · fr-FR' })}
      </div>
      <details className="profile-environment__group" open={fields.location || undefined}>
        <summary>Location{fields.location ? <small>Custom</small> : null}</summary>
        <label className="profile-environment__choice">
          <Switch
            checked={fields.location}
            onChange={(event) => change({ location: event.target.checked })}
          />
          Set a location
        </label>
        {fields.location ? (
          <div className="profile-environment__grid">
            {field('latitude', 'Latitude', { type: 'number', step: 'any', placeholder: '−90 to 90' })}
            {field('longitude', 'Longitude', { type: 'number', step: 'any', placeholder: '−180 to 180' })}
            {field('accuracy', 'Accuracy (meters)', {
              type: 'number',
              step: 'any',
              placeholder: '0 or greater'
            })}
          </div>
        ) : null}
        <small>Websites still need your permission to use location.</small>
      </details>
      <details className="profile-environment__group">
        <summary>Browser identity{fields.userAgent || fields.hints ? <small>Custom</small> : null}</summary>
        {field('userAgent', 'User agent')}
        <details className="profile-environment__hints">
          <summary>Client hints</summary>
          <label className="profile-environment__choice">
            <Switch
              checked={fields.hints}
              onChange={(event) => change({ hints: event.target.checked })}
            />
            Use custom client hints
          </label>
          {fields.hints ? (
            <>
              <div className="profile-environment__grid">
                {field('platform', 'Platform', { placeholder: 'Platform' })}
                {field('platformVersion', 'Platform version', { placeholder: 'Version' })}
                {field('architecture', 'Architecture', { placeholder: 'Architecture' })}
                {field('model', 'Device model', { placeholder: 'Empty when unspecified' })}
              </div>
              <label className="profile-environment__choice">
                <Switch
                  checked={fields.mobile}
                  onChange={(event) => change({ mobile: event.target.checked })}
                />
                Mobile client hint
              </label>
              <label className="profile-environment__choice">
                <Switch
                  checked={fields.bitnessEnabled}
                  onChange={(event) => change({ bitnessEnabled: event.target.checked })}
                />
                Set bitness
              </label>
              {fields.bitnessEnabled ? field('bitness', 'Bitness', { placeholder: 'Bitness' }) : null}
              <label className="profile-environment__field">
                <span>WOW64 hint</span>
                <NativeSelect
                  aria-label="WOW64 hint"
                  value={fields.wow64}
                  onChange={(event) =>
                    change({ wow64: event.target.value as ProfileEnvironmentFields['wow64'] })
                  }
                >
                  <option value="default">Engine default</option>
                  <option value="true">True</option>
                  <option value="false">False</option>
                </NativeSelect>
              </label>
              <BrandRows label="Brands" value={fields.brands} onChange={(brands) => change({ brands })} />
              <BrandRows
                label="Full versions"
                value={fields.fullVersionList}
                onChange={(fullVersionList) => change({ fullVersionList })}
              />
              <small>Client hints do not change touch support or the Browser Viewport.</small>
            </>
          ) : null}
        </details>
      </details>
      <details className="profile-environment__group">
        <summary>
          Display & hardware
          {fields.screenWidth || fields.hardwareConcurrency ? <small>Custom</small> : null}
        </summary>
        <div className="profile-environment__grid">
          {field('screenWidth', 'Screen width', { type: 'number', step: '1' })}
          {field('screenHeight', 'Screen height', { type: 'number', step: '1' })}
          {field('hardwareConcurrency', 'CPU threads', { type: 'number', step: '1' })}
        </div>
        <small>Screen size preserves your chosen Browser Viewport.</small>
      </details>
    </>
  )
}
