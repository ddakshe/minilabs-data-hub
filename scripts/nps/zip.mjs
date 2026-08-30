/*
 * 최소 ZIP 리더 — 중앙 디렉터리를 직접 읽는다.
 *
 * 왜 직접 파싱하나: NPS 공표통계 ZIP 은 내부 파일명이 **CP949** 다.
 * macOS 의 `unzip` 은 APFS 가 UTF-8 파일명만 허용해서 "Illegal byte sequence" 로
 * 전부 실패한다(실측). 파일명을 디스크에 쓰지 않고 메모리에서 디코드하면 이 문제가 없고,
 * 러너(ubuntu)와 로컬(macOS)이 같은 코드로 돈다.
 */
import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50

/** @returns {{name: string, data: Buffer}[]} name 은 CP949 로 디코드된다 */
export function readZip(buf) {
  const dec = new TextDecoder('euc-kr')

  // EOCD 는 파일 끝에 있다. 주석이 붙을 수 있어 뒤에서부터 찾는다.
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('ZIP: EOCD 를 찾지 못했다 (ZIP 파일이 아니거나 잘렸다)')

  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = []

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) throw new Error(`ZIP: 중앙 디렉터리 ${i}번 시그니처 불일치`)
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const cmtLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen))

    // 로컬 헤더의 길이 필드는 중앙 디렉터리와 다를 수 있다. 반드시 로컬 것을 읽는다.
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const start = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(start, start + compSize)

    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw new Error(`ZIP: 지원하지 않는 압축 방식 ${method} (${name})`)

    out.push({ name, data })
    off += 46 + nameLen + extraLen + cmtLen
  }
  return out
}
