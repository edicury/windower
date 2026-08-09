import Foundation

/// Mirrors `Rect` in `data-model.md` — always **pixels**, global coordinate
/// space. Never points. See CLAUDE.md "units" convention and research.md §3.
public struct Rect: Codable, Equatable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// Mirrors `CaptureTarget` in `data-model.md`. Only the `display` and
/// `window` variants are ever produced by this sidecar (`region` has no
/// independent identity and is constructed by the daemon, never enumerated).
public enum CaptureTarget: Encodable {
    case display(id: String, name: String, bounds: Rect, isPrimary: Bool, scaleFactor: Double)
    case window(
        id: String, title: String, appName: String, appBundleId: String, bounds: Rect,
        isFocused: Bool, resizable: Bool)

    private enum CodingKeys: String, CodingKey {
        case kind, id, name, bounds, isPrimary, scaleFactor
        case title, appName, appBundleId, isFocused, resizable
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .display(let id, let name, let bounds, let isPrimary, let scaleFactor):
            try container.encode("display", forKey: .kind)
            try container.encode(id, forKey: .id)
            try container.encode(name, forKey: .name)
            try container.encode(bounds, forKey: .bounds)
            try container.encode(isPrimary, forKey: .isPrimary)
            try container.encode(scaleFactor, forKey: .scaleFactor)
        case .window(let id, let title, let appName, let appBundleId, let bounds, let isFocused, let resizable):
            try container.encode("window", forKey: .kind)
            try container.encode(id, forKey: .id)
            try container.encode(title, forKey: .title)
            try container.encode(appName, forKey: .appName)
            try container.encode(appBundleId, forKey: .appBundleId)
            try container.encode(bounds, forKey: .bounds)
            try container.encode(isFocused, forKey: .isFocused)
            try container.encode(resizable, forKey: .resizable)
        }
    }
}
