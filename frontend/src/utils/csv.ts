// 最朴素的 CSV 读写：支持带引号字段、转义引号、CRLF 与 Excel 需要的 BOM。
// 不引第三方依赖，保证离线（纯前端、无后端）环境也能跑。

const BOM = '﻿'

export function escapeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function toCsv(rows: (string | number)[][], withBom = true): string {
  const body = rows
    .map((row) => row.map((cell) => escapeCsvCell(cell)).join(','))
    .join('\r\n')
  return `${withBom ? BOM : ''}${body}`
}

export function parseCsv(input: string): string[][] {
  const text = input.startsWith(BOM) ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      pushField()
    } else if (ch === '\n') {
      pushRow()
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i += 1
      }
      pushRow()
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    pushRow()
  }
  return rows
}

// 删掉内容全空的尾行（文件末尾常见的空行）。
export function dropBlankRows(rows: string[][]): string[][] {
  return rows.filter((row) => row.some((cell) => cell.trim() !== ''))
}
