import CoreGraphics

public enum NativeCaptureGeometry {
    /// AppKit's origin is bottom-left. Quartz's primary-display origin is top-left.
    public static func quartzRect(appKitRect: CGRect, primaryDisplayTop: CGFloat) -> CGRect {
        CGRect(x: appKitRect.minX, y: primaryDisplayTop - appKitRect.maxY, width: appKitRect.width, height: appKitRect.height)
    }

    public static func isValid(_ rect: CGRect) -> Bool {
        rect.origin.x.isFinite && rect.origin.y.isFinite && rect.width.isFinite && rect.height.isFinite && rect.width > 0 && rect.height > 0
    }
}
