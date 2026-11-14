# AgentMux brand sources

Every brand bitmap the product draws has exactly one source here. Consumers import these files
through the package path `@agentmux/client-ui/brand/*`. Don't copy them into an app; derived
outputs come from the build.

| Directory | Holds | Consumers |
| --- | --- | --- |
| `app-icons/` | Source art for the five App icons, plus the Classic backplate | `apps/desktop/scripts/build-brand-assets.mjs` derives every App icon output from these files |
| `heroes/` | Hero art for the brand surfaces: launch, Launcher backdrop and the Settings Overview banner | The Desktop renderer's launch and Settings surfaces |
| `illustrations/goals/` | Goals common actions, the clarification dialogue and the Goals header companions | Goals surfaces |
| `illustrations/concepts/` | Concept scenes for Settings modules, Topics and the Goals empty state | Settings and Goals introductions |
| `illustrations/mote-origin/` | The three-act Mote origin storyboard | Mote settings and Topic promotion |

`brand-manifest.json` lists every file here with its kind, realm (an App icon id; shared workshop
art is `commons`), origin, and whether it follows the selected App icon (`followsAppIcon`: true for
the App icons, the Classic backplate and the hero art; false for the shared illustrations). Its
`external` list points at brand assets that stay with other owners: the Mote avatar series that Main
reads, the Mote default figure in the semantic icon catalog, Provider and connector marks, and the
WebP copies used by the README (`docs/assets/readme`). The [manifest test](../test/brand-manifest.test.ts)
keeps the manifest and this directory in step both ways.

Avatar series (`apps/desktop/resources/avatar-series`) stay with the Mote avatar owner, because
Main reads them at runtime from the packaged resources. Provider and connector marks belong to
their vendors and aren't brand assets.

Heroes are stored as AVIF and named after the realm they were painted for: `<realm>-launch.avif`
for the full-bleed app start and `<realm>-banner.avif` for the Launcher backdrop and the Settings
Overview. The Classic icon's realm is Origin, so today's files are `origin-launch` and
`origin-banner`; a realm without its own painting shows Origin's. Hero files are listed only in
`BRAND_HEROES` in `apps/desktop/src/renderer/src/lib/brand-hero.ts`. Illustrations stay as PNG until
each one has been reviewed at its real display size.

Hero art keeps its confirmed subject and composition when it is regenerated at higher resolution;
its size is not fixed at 4K. It may be upscaled with a local AI model, but the record states the
pixels actually generated and the size after enhancement separately, and an upscale is never
described as native high-resolution generation. Enhancement counts only if an independent visual
review, at the same display scale and on wide, narrow, light and dark Retina layouts, sees a real
gain in sharpness with composition, color, material and foreground legibility intact; more pixels
or interpolation are not new detail. Production steps (crops and AVIF encoding) are in the
[brand assets guide](../../../docs/guides/brand-assets.md).
