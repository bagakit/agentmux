import Testing
@testable import AgentMuxNativeMacOSCore

@Suite struct SnapshotRenderingTests {
    @Test func skipsUnsupportedAdvertisedAttributes() {
        let advertised: Set<String> = ["AXRole", "AXChildren"]

        #expect(SnapshotRenderHeuristics.supportsAttribute("AXRole", advertisedAttributes: advertised))
        #expect(!SnapshotRenderHeuristics.supportsAttribute("AXTitle", advertisedAttributes: advertised))
    }

    @Test func unknownAttributeAdvertisementsStayPermissive() {
        #expect(SnapshotRenderHeuristics.supportsAttribute("AXTitle", advertisedAttributes: nil))
    }

    @Test func secureTextMetadataOnlyProbesTextLikeRoles() {
        #expect(SnapshotRenderHeuristics.shouldProbeSecureTextMetadata(role: "AXTextField"))
        #expect(SnapshotRenderHeuristics.shouldProbeSecureTextMetadata(role: "AXSearchField"))
        #expect(!SnapshotRenderHeuristics.shouldProbeSecureTextMetadata(role: "AXGroup"))
        #expect(!SnapshotRenderHeuristics.shouldProbeSecureTextMetadata(role: "AXButton"))
    }

    @Test func elidesAnonymousWrappers() {
        let node = SnapshotRenderNode(role: "AXGroup", childCount: 1)

        #expect(SnapshotRenderHeuristics.shouldElide(node))
    }

    @Test func preservesWebAreaContainersWithMultipleChildren() {
        let node = SnapshotRenderNode(role: "AXGroup", childCount: 3, webAreaDepth: 1)

        #expect(!SnapshotRenderHeuristics.shouldElide(node))
    }

    @Test func rendersMarkdownLinksAndSuppressesTheirChildren() {
        let node = SnapshotRenderNode(role: "AXLink", linkText: "Skip [main]", url: "https://example.com/path")

        #expect(SnapshotRenderHeuristics.line(index: 7, node: node) == "7 link [Skip \\[main\\]](https://example.com/path)")
        #expect(SnapshotRenderHeuristics.shouldSuppressChildren(node))
    }

    @Test func suppressesChildrenForNamedCompactControls() {
        let button = SnapshotRenderNode(role: "AXButton", roleDescription: "button", label: "Install GitHub", childCount: 1)
        let heading = SnapshotRenderNode(role: "AXHeading", roleDescription: "heading", label: "Repository navigation", value: "2", childCount: 1)

        #expect(SnapshotRenderHeuristics.shouldSuppressChildren(button))
        #expect(SnapshotRenderHeuristics.shouldSuppressChildren(heading))
        #expect(SnapshotRenderHeuristics.line(index: 5, node: heading) == "5 heading Repository navigation")
    }

    @Test func keepsChildrenForRowsWithNestedControls() {
        let row = SnapshotRenderNode(role: "AXRow", roleDescription: "row", childCount: 3, rowSummary: "Liked Songs")

        #expect(!SnapshotRenderHeuristics.shouldSuppressChildren(row))
    }

    @Test func filtersNoisyActionsAndFormatsSecondaryActions() {
        let node = SnapshotRenderNode(
            role: "AXWindow",
            title: "Document",
            rawActions: ["AXPress", "AXShowMenu", "AXScrollToVisible", "AXZoomWindow"]
        )

        #expect(SnapshotRenderHeuristics.meaningfulActions(node.rawActions, role: node.role) == ["AXZoomWindow"])
        #expect(SnapshotRenderHeuristics.line(index: 1, node: node) == "1 window Document, Secondary Actions: zoom the window")
    }

    @Test func suppressesHorizontalScrollWhenVerticalScrollExists() {
        let node = SnapshotRenderNode(
            role: "AXScrollArea",
            rawActions: ["AXScrollUpByPage", "AXScrollDownByPage", "AXScrollLeftByPage", "AXScrollRightByPage"]
        )

        #expect(SnapshotRenderHeuristics.meaningfulActions(node.rawActions, role: node.role) == ["AXScrollUpByPage", "AXScrollDownByPage"])
    }

    @Test func keepsHorizontalOnlyActionsInTheirOriginalOrder() {
        let actions = ["AXScrollRightByPage", "AXPress", "AXScrollLeftByPage", "AXScrollRightByPage"]
        let node = SnapshotRenderNode(role: "AXScrollArea", rawActions: actions)

        #expect(
            SnapshotRenderHeuristics.meaningfulActions(actions, role: node.role) ==
            ["AXScrollRightByPage", "AXScrollLeftByPage", "AXScrollRightByPage"]
        )
        #expect(
            SnapshotRenderHeuristics.line(index: 2, node: node) ==
            "2 scroll area, Secondary Actions: scroll right, scroll left, scroll right"
        )
    }

    @Test func keepsMixedScrollActionsOutsideScrollAreas() {
        let actions = ["AXScrollLeftByPage", "AXScrollDownByPage", "AXScrollRightByPage", "AXCancel"]
        let node = SnapshotRenderNode(role: "AXMenu", rawActions: actions)

        #expect(
            SnapshotRenderHeuristics.meaningfulActions(actions, role: node.role) ==
            ["AXScrollLeftByPage", "AXScrollDownByPage", "AXScrollRightByPage"]
        )
        #expect(
            SnapshotRenderHeuristics.line(index: 3, node: node) ==
            "3 menu, Secondary Actions: scroll left, scroll down, scroll right"
        )
    }

    @Test func textFieldsKeepDistinctValueAndPlaceholder() {
        let node = SnapshotRenderNode(
            role: "AXTextField",
            roleDescription: "text field",
            label: "Address",
            value: "https://example.com",
            placeholder: "Search"
        )

        #expect(
            SnapshotRenderHeuristics.line(index: 3, node: node) ==
            "3 text field Address, Value: https://example.com, Placeholder: Search"
        )
    }

    @Test func staticTextUsesCompactValueFormatting() {
        let node = SnapshotRenderNode(role: "AXStaticText", roleDescription: "text", value: "Home")

        #expect(SnapshotRenderHeuristics.line(index: 4, node: node) == "4 text Home")
    }

    @Test func rowSummaryBecomesName() {
        let node = SnapshotRenderNode(role: "AXRow", roleDescription: "row", rowSummary: "General Settings Enabled")

        #expect(SnapshotRenderHeuristics.line(index: 9, node: node) == "9 row General Settings Enabled")
    }

    @Test func compactsLargeBrowserTabStripsToSelectedTab() {
        let parent = SnapshotRenderNode(role: "AXScrollArea", roleDescription: "tab bar")
        let children = (0..<12).map { index in
            SnapshotRenderNode(
                role: "AXRadioButton",
                roleDescription: "tab",
                title: "Tab \(index)",
                traits: index == 7 ? ["selected"] : []
            )
        }

        let compaction = SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children)

        #expect(compaction == SnapshotTabStripCompaction(retainedIndexes: [7], omittedCount: 11))
    }

    @Test func infersLargeBrowserTabStripFromScrollAreaChildren() {
        let parent = SnapshotRenderNode(role: "AXScrollArea", roleDescription: "scroll area")
        let children = (0..<12).map { index in
            SnapshotRenderNode(
                role: "AXRadioButton",
                roleDescription: "tab",
                title: "Tab \(index)",
                traits: index == 11 ? ["selected"] : []
            )
        }

        let compaction = SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children)

        #expect(compaction == SnapshotTabStripCompaction(retainedIndexes: [11], omittedCount: 11))
    }

    @Test func usesOneValueAsSelectedBrowserTabFallback() {
        let parent = SnapshotRenderNode(role: "AXScrollArea", roleDescription: "scroll area")
        let children = (0..<12).map { index in
            SnapshotRenderNode(
                role: "AXRadioButton",
                roleDescription: "tab",
                title: "Tab \(index)",
                value: index == 4 ? "1" : "0"
            )
        }

        let compaction = SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children)

        #expect(compaction == SnapshotTabStripCompaction(retainedIndexes: [4], omittedCount: 11))
    }

    @Test func keepsLargeTabCollectionsWithoutActiveTabExpanded() {
        let parent = SnapshotRenderNode(role: "AXGroup")
        let children = (0..<12).map { index in
            SnapshotRenderNode(role: "AXTab", title: "Tab \(index)", value: "0")
        }

        #expect(SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children) == nil)
    }

    @Test func keepsLargeNonBrowserTabCollectionsExpanded() {
        let parent = SnapshotRenderNode(role: "AXGroup")
        let children = (0..<12).map { index in
            SnapshotRenderNode(
                role: "AXRadioButton",
                roleDescription: "tab",
                title: "Pane \(index)",
                traits: index == 2 ? ["selected"] : []
            )
        }

        #expect(SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children) == nil)
    }

    @Test func keepsSmallTabGroupsExpanded() {
        let parent = SnapshotRenderNode(role: "AXTabGroup", roleDescription: "tab group")
        let children = (0..<3).map { index in
            SnapshotRenderNode(
                role: "AXRadioButton",
                roleDescription: "tab",
                title: "Pane \(index)",
                traits: index == 1 ? ["selected"] : []
            )
        }

        #expect(SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children) == nil)
    }
}
