/// The host PNG boundary permits these per-image resources. These are allocation
/// and wire-frame limits, never a budget for cumulative captures or Agent state.
public enum NativeImageLimits {
    public static let maxDimension = 16_384
    public static let maxPixels = 32 * 1024 * 1024
    public static let maxPNGBytes = 18 * 1024 * 1024
    // A 16-bit RGBA raster at the permitted pixel count can occupy eight bytes
    // per pixel before conversion. PNG's encoded/wire bound remains independent.
    public static let maxRasterSourceBytes = maxPixels * 8

    public static func permits(width: Double, height: Double) -> Bool {
        width.isFinite && height.isFinite && width >= 1 && height >= 1 &&
        width <= Double(maxDimension) && height <= Double(maxDimension) &&
        width * height <= Double(maxPixels)
    }
}
