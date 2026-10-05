/** CSV 编解码：所有台账文件统一 UTF-8 BOM，Excel 直接打开不乱码。 */

export function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function csvLine(values: unknown[]): string {
  return values.map(csvEscape).join(',')
}

export function buildCsv(rows: unknown[][]): string {
  return '\uFEFF' + rows.map(csvLine).join('\r\n')
}


/** 宽松解析：支持引号、引号转义、CRLF/LF。返回的每行长度以该行实际单元格数为准。 */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
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
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      pushField()
    } else if (char === '\n') {
      pushRow()
    } else if (char === '\r') {
      // 引号内的换行是字段内容，必须原样保留；引号外的 CRLF 才折叠成行结束。
      if (!inQuotes && text[i + 1] === '\n') {
        i += 1
      }
      if (!inQuotes) {
        pushRow()
      } else {
        field += char
      }
    } else {
      field += char
    }
  }
  // 末行没有换行符也要收进来；纯空文件不产生行。
  if (field.length > 0 || row.length > 0) {
    pushRow()
  }
  return rows
}

/** 空白判定：空串、纯空白、以及导出占位符都算未填写。 */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }
  const text = String(value).trim()
  return text === '' || text === '—' || text === '-'
}
