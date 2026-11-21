import Foundation
import ImageIO
import Vision

guard CommandLine.arguments.count == 2 else { exit(2) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
do {
    let request = VNDetectFaceRectanglesRequest()
    let source = CGImageSourceCreateWithURL(url as CFURL, nil)
    let properties = source.flatMap { CGImageSourceCopyPropertiesAtIndex($0, 0, nil) } as? [CFString: Any]
    let orientation = CGImagePropertyOrientation(rawValue: (properties?[kCGImagePropertyOrientation] as? UInt32) ?? 1) ?? .up
    try VNImageRequestHandler(url: url, orientation: orientation).perform([request])
    guard let results = request.results else { exit(3) }
    print("{\"engine\":\"apple-vision-face-rectangles\",\"faceCount\":\(results.count),\"revision\":\(request.revision)}")
} catch {
    FileHandle.standardError.write(Data("Local face analysis failed.\n".utf8))
    exit(3)
}
