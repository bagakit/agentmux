import AppKit
import Foundation
import Vision

/// Local image analysis. It neither captures the desktop nor asks for screen/AX permission.
enum NativeTextRecognition {
    static func recognize(_ params: [String: JSONValue]) throws -> [String: Any] {
        guard let encoded = params["data"]?.string,
              encoded.utf8.count <= 24 * 1024 * 1024,
              let data = Data(base64Encoded: encoded) else {
            throw ProviderError.coded("invalid_argument", "Text recognition requires a PNG image")
        }
        let image = try NativeDesktopOperations.validatedPNG(data)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        let supported = try request.supportedRecognitionLanguages()
        let wanted = Locale.preferredLanguages + ["zh-Hans", "zh-Hant", "en-US"]
        var languages: [String] = []
        for language in wanted {
            if let match = supported.first(where: { $0 == language || $0.hasPrefix(language + "-") }), !languages.contains(match) { languages.append(match) }
        }
        if !languages.isEmpty { request.recognitionLanguages = languages }
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        let width = Double(image.width), height = Double(image.height)
        let lines: [[String: Any]] = (request.results ?? []).compactMap { observation in
            guard let text = observation.topCandidates(1).first else { return nil }
            let box = observation.boundingBox
            return ["text": text.string, "confidence": Double(text.confidence),
                    "rect": ["x": box.minX * width, "y": (1 - box.maxY) * height,
                             "width": box.width * width, "height": box.height * height]]
        }.sorted { left, right in
            let a = left["rect"] as! [String: Double], b = right["rect"] as! [String: Double]
            return a["y"]! == b["y"]! ? a["x"]! < b["x"]! : a["y"]! < b["y"]!
        }
        return ["state": "recognized", "width": image.width, "height": image.height, "lines": lines]
    }
}
