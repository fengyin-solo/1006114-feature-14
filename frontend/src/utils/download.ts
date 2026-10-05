// 浏览器侧下载工具：只在最终包完整生成后才挂出 <a download> 触发保存，
// 因此中途取消/断网/存储失败都不会在磁盘上留下半包文件。

export function downloadText(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime })
  downloadBlob(filename, blob)
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    document.body.removeChild(anchor)
    // 释放放到下一个事件循环：个别浏览器在同一 tick revoke 会导致保存被取消。
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
