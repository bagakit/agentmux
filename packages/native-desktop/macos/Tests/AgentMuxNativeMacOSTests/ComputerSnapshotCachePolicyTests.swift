import AgentMuxNativeMacOSCore
import Foundation
import Testing

@Suite struct ComputerSnapshotCachePolicyTests {
    @Test func doesNotExpireFreshSnapshotsAtTheAgeBoundary() {
        let createdAt = Date(timeIntervalSince1970: 100)
        let now = createdAt.addingTimeInterval(ComputerSnapshotCachePolicy.maxAge)

        #expect(!ComputerSnapshotCachePolicy.isExpired(createdAt: createdAt, now: now))
    }

    @Test func expiresSnapshotsOlderThanTheAgeLimit() {
        let createdAt = Date(timeIntervalSince1970: 100)
        let now = createdAt.addingTimeInterval(ComputerSnapshotCachePolicy.maxAge + 0.001)

        #expect(ComputerSnapshotCachePolicy.isExpired(createdAt: createdAt, now: now))
    }

    @Test func prunesWhenCacheExceedsEntryLimit() {
        #expect(
            ComputerSnapshotCachePolicy.shouldPrune(
                entryCount: ComputerSnapshotCachePolicy.maxEntries + 1,
                createdAt: Date(),
                now: Date()
            )
        )
    }
}
