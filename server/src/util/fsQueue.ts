/**
 * 按 projectId 串行的写入队列。
 *
 * 单用户单进程场景，并发主要来自同一轮里多个 Subagent 串行写不同资产。
 * 所有写操作（assets / metadata）过 enqueue(projectId, ...)，保证同一项目内串行；
 * 读操作不排队，允许脏读——每次操作后前端会 refresh。
 *
 * 来自 v6 后端专项 02_persistence.md。
 */
const queues = new Map<string, Promise<void>>()

export function enqueue<T>(projectId: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = queues.get(projectId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  // queues 链吞掉 reject（仅维持串行顺序）；错误通过 return next 传给调用方 catch
  queues.set(projectId, next.then(() => {}, () => {}))
  return next
}
