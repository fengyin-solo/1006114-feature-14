// 不依赖任何第三方库的 ZIP（store 模式，即不压缩）读写。
// 台账分卷导出要求一个离线可下载的“册子”（按管片型号+生产模具打包），
// store 模式对文本 CSV 已经够用，换来的是零依赖与可恢复的分卷生成。

export type ZipEntry = {
  name: string
  bytes: Uint8Array
}

const encoder = new TextEncoder()

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

class ByteWriter {
  private parts: number[] = []

  get length(): number {
    return this.parts.length
  }

  u16(value: number): void {
    this.parts.push(value & 0xff, (value >>> 8) & 0xff)
  }

  u32(value: number): void {
    this.parts.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
  }

  bytes(value: Uint8Array): void {
    for (const b of value) {
      this.parts.push(b)
    }
  }

  done(): Uint8Array {
    return new Uint8Array(this.parts)
  }
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const writer = new ByteWriter()
  const central: Uint8Array[] = []

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const data = entry.bytes
    const crc = crc32(data)
    const offset = writer.length

    // 本地文件头（签名 0x04034b50）
    writer.u32(0x04034b50)
    writer.u16(20) // 解压所需版本
    writer.u16(0x0800) // 标志位：文件名按 UTF-8 编码
    writer.u16(0) // store，不压缩
    writer.u16(0) // 修改时间（保持 0）
    writer.u16(0) // 修改日期（保持 0）
    writer.u32(crc)
    writer.u32(data.length)
    writer.u32(data.length)
    writer.u16(name.length)
    writer.u16(0) // 无扩展字段
    writer.bytes(name)
    writer.bytes(data)

    const centralWriter = new ByteWriter()
    centralWriter.u32(0x02014b50) // 中央目录头
    centralWriter.u16(20) // 制作版本
    centralWriter.u16(20)
    centralWriter.u16(0x0800)
    centralWriter.u16(0)
    centralWriter.u16(0)
    centralWriter.u16(0)
    centralWriter.u32(crc)
    centralWriter.u32(data.length)
    centralWriter.u32(data.length)
    centralWriter.u16(name.length)
    centralWriter.u16(0)
    centralWriter.u16(0)
    centralWriter.u16(0)
    centralWriter.u16(0)
    centralWriter.u32(0)
    centralWriter.u32(offset)
    centralWriter.bytes(name)
    central.push(centralWriter.done())
  }

  const centralStart = writer.length
  let centralSize = 0
  for (const part of central) {
    writer.bytes(part)
    centralSize += part.length
  }

  // EOCD（签名 0x06054b50）
  writer.u32(0x06054b50)
  writer.u16(0)
  writer.u16(0)
  writer.u16(entries.length)
  writer.u16(entries.length)
  writer.u32(centralSize)
  writer.u32(centralStart)
  writer.u16(0)

  return writer.done()
}

class ByteReader {
  offset = 0

  constructor(private readonly view: DataView) {}

  u16(): number {
    const value = this.view.getUint16(this.offset, true)
    this.offset += 2
    return value
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true)
    this.offset += 4
    return value
  }

  take(length: number): Uint8Array {
    const value = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length)
    this.offset += length
    return value
  }
}

// 只服务于自测：把 buildZip 写出来的包解回条目，校验名、内容与 CRC。
export function readZip(bytes: Uint8Array): ZipEntry[] {
  // 拷贝一份独立 ArrayBuffer，兼容传入视图带 byteOffset/底层是 SharedArrayBuffer 的情况
  const own = new Uint8Array(bytes.length)
  own.set(bytes)
  const view = new DataView(own.buffer)
  const reader = new ByteReader(view)
  const entries: ZipEntry[] = []

  while (reader.offset < own.length - 4) {
    const signature = reader.u32()
    if (signature !== 0x04034b50) {
      break
    }
    reader.u16()
    reader.u16()
    reader.u16()
    reader.u16()
    reader.u16()
    const crc = reader.u32()
    const size = reader.u32()
    reader.u32()
    const nameLength = reader.u16()
    const extraLength = reader.u16()
    const name = new TextDecoder().decode(reader.take(nameLength))
    reader.offset += extraLength
    const data = reader.take(size)
    if (crc32(data) !== crc) {
      throw new Error(`ZIP 条目 ${name} 的 CRC 校验不通过，包不完整`)
    }
    entries.push({ name, bytes: new Uint8Array(data) })
  }
  return entries
}
