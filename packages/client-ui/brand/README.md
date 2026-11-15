# Brand assets

This optional entry contains original app icons, hero art and illustrations. Access an asset through the package export `@agentmux/client-ui/brand/*`. The [brand manifest](brand-manifest.json) lists each asset's kind, origin, realm and whether it follows the selected icon.

| Directory | Contents |
| --- | --- |
| `app-icons/` | Icon source artwork and the Classic backplate used to derive platform icon sizes |
| `heroes/` | Full-width launch artwork and banners in AVIF |
| `illustrations/goals/` | Goal actions, clarification and header companions |
| `illustrations/concepts/` | Concept scenes and empty-state illustrations |
| `illustrations/mote-origin/` | The three-part Mote origin storyboard |

A realm identifies an icon family. The shared illustrations are marked `commons`. The manifest field `followsAppIcon` identifies art that accompanies a chosen icon. Heroes use `<realm>-launch.avif` and `<realm>-banner.avif`. The Origin paintings supply the default artwork. Host applications choose how to place these assets. The manifest's `external` entries identify related assets maintained by their respective owners. Provider and connector marks belong to their vendors.

When replacing artwork, preserve its subject, composition and legibility. Record native and enhanced dimensions separately. Compare at the intended display size on wide and narrow layouts and in light and dark themes. Keep illustrations in PNG until a replacement has passed that review. Check the rights of any asset intended for redistribution.

## App icon and hero projection

The shared [app icon catalog](../src/lib/app-icon-catalog.ts) owns stable choices, defaults and their realms. The [Desktop asset build](../../../apps/desktop/scripts/build-brand-assets.mjs) derives web bitmaps, native resources and the default package icon from the artwork registered in the manifest. The Dock and default `.icns` share the macOS contour and transparent inset, generated at build time. Source artwork and Web and iOS assets keep their own geometry. The build composites the original transparent Classic dragon with the shared SVG backplate. Consumers use the composite.

The shared [BrandIcon](../src/components/BrandIcon.tsx) receives an explicit selection. The [Desktop renderer](../../../apps/desktop/src/renderer/src/components/BrandIcon.tsx) reads the original configuration, [Main](../../../apps/desktop/src/main/app-brand-icon.ts) observes committed values from ConfigOwner, and Mobile uses the existing appearance stream. The welcome view and new bot avatars reuse this projection. An already frozen creation request retains its original avatar.

The [hero resolver](../../../apps/desktop/src/renderer/src/lib/brand-hero.ts) selects artwork for launch, Launcher and Settings from the saved choice. The launch surface reads that choice from its synchronous theme snapshot. Project resources, Space appearance and Provider or Mote identity remain with their respective owners. The [brand presentation contract](../../../docs/design/presentation/brand-identity.md) defines placement and selection rules.
