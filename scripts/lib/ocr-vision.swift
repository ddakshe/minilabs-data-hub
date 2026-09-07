// macOS Vision OCR — 경기남부 집회 게시판이 표를 JPG 로만 올려서 필요하다.
//
// tesseract(kor) 는 이 표에서 못 쓴다: 시간이 "07:00~" → "955" 로 깨지고,
// psm 4 에서는 인원 30 을 64 로 **조용히** 오독했다. 규모 등급이 그 숫자
// 하나로 갈리므로 조용한 오독이 제일 위험하다. Vision 은 6행 전 필드가 맞았다.
//
// 출력: 인식 조각의 JSON 배열 [{t,x,y,w,h}], y 내림차순. 좌표를 살려 보내야
// 읽는 쪽이 헤더 기준으로 열을 배정하고 밀린 셀을 되돌릴 수 있다.
//
//   swiftc -O ocr-vision.swift -o ocr-vision
//   ./ocr-vision 표.jpg

import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: ocr-vision <image>\n".data(using: .utf8)!)
    exit(2)
}
let path = CommandLine.arguments[1]

guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("이미지를 열지 못했다: \(path)\n".data(using: .utf8)!)
    exit(1)
}

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["ko-KR", "en-US"]
// 표는 문장이 아니다. 언어 교정을 켜면 "9.5(토)" 같은 토막을 말이 되게 고치려 든다.
req.usesLanguageCorrection = false

do {
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
} catch {
    FileHandle.standardError.write("OCR 실패: \(error)\n".data(using: .utf8)!)
    exit(1)
}

struct Box: Encodable { let t: String; let x: Double; let y: Double; let w: Double; let h: Double }
var boxes: [Box] = []
for o in req.results ?? [] {
    guard let c = o.topCandidates(1).first else { continue }
    let b = o.boundingBox
    boxes.append(Box(t: c.string, x: Double(b.minX), y: Double(b.midY),
                     w: Double(b.width), h: Double(b.height)))
}

// 좌표를 그대로 넘긴다. 탭으로 이어붙이면 열 정보가 사라지고, 셀 하나가
// 위아래로 밀린 행(실제로 있었다)을 복구할 방법이 없어진다. 열 배정은
// 헤더 위치를 아는 읽는 쪽에서 한다.
let data = try JSONEncoder().encode(boxes.sorted { $0.y > $1.y })
print(String(data: data, encoding: .utf8)!)
