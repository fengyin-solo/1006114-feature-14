import { crc32 } from './segment-ledger'

/**
 * 零依赖 ZIP 打包：仅用 STORED（不压缩）方式打包，纯前端不引入第三方依赖。
 * 输入在打包前已分卷写进 IndexedDB 并逐卷校验通过，所以这里永远输出完整包，
 * 中途异常直接抛错，调用方删除半成品对象，不留下半包文件。
 */

export type ZipEntry = {
  path: string
  bytes: Uint8Array
}

const DOS_EPOCH_ANNUM = 1980

function dosDateTime(date: Date): { time: number; dateWord: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2))
  const dateWord =
    ((date.getFullYear() - DOS_EPOCH_ANNUM) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, dateWord }
}

export function buildZip(entries: ZipEntry[], now: Date = new Date()): Blob {
  const encoder = new TextEncoder()
  const { time, dateWord } = dosDateTime(now)
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path)
    const data = entry.bytes
    const crc = crc32(data)
    const flag = 0x0800 // UTF-8 文件名

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true) // 解压版本
    local.setUint16(6, flag, true)
    local.setUint16(8, 0, true) // STORED
    local.setUint16(10, time, true)
    local.setUint16(12, dateWord, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true)
    parts.push(new Uint8Array(local.buffer), nameBytes, data)
    const centralHeader = new DataView(new ArrayBuffer(46))
    centralHeader.setUint32(0, 0x02014b50, true)
    centralHeader.setUint16(4, 20, true) // 制作版本
    centralHeader.setUint16(6, 20, true) // 解压版本
    centralHeader.setUint16(8, flag, true)
    centralHeader.setUint16(10, 0, true)
    centralHeader.setUint16(12, time, true)
    centralHeader.setUint16(14, dateWord, true)
    centralHeader.setUint32(16, crc, true)
    centralHeader.setUint32(20, data.length, true)
    centralHeader.setUint32(24, data.length, true)
    centralHeader.setUint16(28, nameBytes.length, true)
    centralHeader.setUint16(30, 0, true)
    centralHeader.setUint16(32, 0, true)
    centralHeader.setUint16(34, 0, true)
    centralHeader.setUint16(36, 0, true)
    centralHeader.setUint32(38, 0, true)
    centralHeader.setUint32(42, offset, true)
    central.push(new Uint8Array(centralHeader.buffer), nameBytes)

    offset += 30 + nameBytes.length + data.length
  }

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0)
  const centralOffset = offset

  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(4, 0, true)
  eocd.setUint16(6, 0, true)
  eocd.setUint16(8, entries.length, true)
  eocd.setUint16(10, entries.length, true)
  eocd.setUint32(12, centralSize, true)
  eocd.setUint32(16, centralOffset, true)
  eocd.setUint16(20, 0, true)

  return new Blob(
    [...parts, ...central, new Uint8Array(eocd.buffer)] as BlobPart[],
    { type: 'application/zip' },
  )
}
