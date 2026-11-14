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
