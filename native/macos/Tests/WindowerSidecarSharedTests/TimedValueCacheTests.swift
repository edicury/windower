import Foundation
import XCTest

import WindowerSidecarShared

/// Phase 21 — the short-TTL cache behind
/// `EnumerationService.fetchShareableContent`. A real `SCShareableContent`
/// can't be constructed in CI (CLAUDE.md's "TCC permissions gate CI"), which
/// is precisely why the cache is a generic, ScreenCaptureKit-free type in the
/// shared module: the hit/expiry logic that decides how often the sidecar
/// round-trips into `replayd` is fully testable here with an injected clock.
final class TimedValueCacheTests: XCTestCase {

    func testMissesBeforeAnythingIsStored() {
        let cache = TimedValueCache<String>(ttlMs: 250)
        XCTAssertNil(cache.value())
    }

    func testHitsImmediatelyAfterStore() {
        let cache = TimedValueCache<String>(ttlMs: 250)
        cache.store("content")
        XCTAssertEqual(cache.value(), "content")
    }

    /// The burst this exists to collapse: `list_targets` immediately followed
    /// by a resolve-target-for-capture call. Both must be served by ONE
    /// round-trip.
    func testRepeatedReadsWithinTheTtlAllHit() {
        var now: Double = 0
        let cache = TimedValueCache<String>(ttlMs: 250, clockMs: { now })
        cache.store("content")
        now = 1
        XCTAssertEqual(cache.value(), "content")
        now = 124
        XCTAssertEqual(cache.value(), "content")
        now = 250  // exactly at the TTL is still fresh (expiry is `age > ttl`)
        XCTAssertEqual(cache.value(), "content")
    }

    func testExpiresAfterTheTtl() {
        var now: Double = 0
        let cache = TimedValueCache<String>(ttlMs: 250, clockMs: { now })
        cache.store("content")
        now = 250.1
        XCTAssertNil(cache.value())
    }

    func testStoringAgainRestartsTheTtlWindow() {
        var now: Double = 0
        let cache = TimedValueCache<String>(ttlMs: 250, clockMs: { now })
        cache.store("first")
        now = 200
        cache.store("second")
        now = 400  // 200ms after the second store, still inside its window
        XCTAssertEqual(cache.value(), "second")
    }

    func testExpiryClearsTheSlotRatherThanKeepingAStaleValue() {
        var now: Double = 0
        let cache = TimedValueCache<String>(ttlMs: 10, clockMs: { now })
        cache.store("content")
        now = 100
        XCTAssertNil(cache.value())
        // Rewinding the clock must NOT resurrect the expired value.
        now = 0
        XCTAssertNil(cache.value())
    }

    func testInvalidateForcesTheNextReadToMiss() {
        let cache = TimedValueCache<String>(ttlMs: 10_000)
        cache.store("content")
        cache.invalidate()
        XCTAssertNil(cache.value())
    }

    /// `shareableContentCacheTtlMs = 0` is the documented way to turn the
    /// optimization off without branching at any call site.
    func testZeroTtlDisablesTheCacheEntirely() {
        let cache = TimedValueCache<String>(ttlMs: 0)
        cache.store("content")
        XCTAssertNil(cache.value())
    }

    func testNegativeTtlAlsoDisablesTheCache() {
        let cache = TimedValueCache<String>(ttlMs: -1)
        cache.store("content")
        XCTAssertNil(cache.value())
    }

    /// A clock that moves backwards must not be read as "expired long ago" —
    /// the worst acceptable outcome is one extra hit of an already-validated
    /// value, never a spuriously long-lived one.
    func testNegativeAgeIsTreatedAsFresh() {
        var now: Double = 1000
        let cache = TimedValueCache<String>(ttlMs: 250, clockMs: { now })
        cache.store("content")
        now = 900
        XCTAssertEqual(cache.value(), "content")
    }

    func testConcurrentReadsAndWritesDoNotCrash() {
        // The real cache is read from `rpcQueue`, a CONCURRENT dispatch queue,
        // while SCStream delegate callbacks run on their own queues — so the
        // lock is load-bearing, not decorative.
        let cache = TimedValueCache<Int>(ttlMs: 10_000)
        let iterations = 500
        let done = expectation(description: "concurrent access")
        done.expectedFulfillmentCount = 2
        let queue = DispatchQueue(label: "test.concurrent", attributes: .concurrent)
        queue.async {
            for i in 0..<iterations { cache.store(i) }
            done.fulfill()
        }
        queue.async {
            for _ in 0..<iterations { _ = cache.value() }
            done.fulfill()
        }
        wait(for: [done], timeout: 10)
    }
}
