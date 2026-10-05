// 极简自测框架：够用、零依赖，node 直接跑 bundle 后的文件。
let passed = 0
let failed = 0
const failures: string[] = []

export function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
  } catch (error) {
    failed += 1
    failures.push(`${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}（期望 ${String(expected)}，实际 ${String(actual)}）`)
  }
}

export function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    throw new Error(`${message}\n期望 ${e}\n实际 ${a}`)
  }
}

export function assertThrows(fn: () => unknown, fragment: string, message: string): void {
  try {
    fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (!text.includes(fragment)) {
      throw new Error(`${message}（错误信息不含「${fragment}」：${text}）`)
    }
    return
  }
  throw new Error(`${message}（应当抛出含「${fragment}」的错误）`)
}

export function finish(): void {
  if (failures.length) {
    console.error(failures.join('\n\n'))
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    process.exit(1)
  }
}
