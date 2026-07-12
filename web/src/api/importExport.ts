import { ApiRequestError, type ApiError } from './client'

export interface ImportDocxResult {
  markdown: string
  filename: string
}

/** 解析错误响应体（非 JSON 时回退 HTTP 状态码） */
async function parseError(res: Response): Promise<never> {
  let body: { error?: ApiError } = {}
  try {
    body = (await res.json()) as { error?: ApiError }
  } catch {
    // 非 JSON 错误体
  }
  const err = body.error ?? { kind: 'network', message: `HTTP ${res.status}` }
  throw new ApiRequestError(err)
}

/**
 * 导入 .docx → markdown（multipart 上传）
 * 注意：不能用 apiFetch（它强制 JSON Content-Type），FormData 需让浏览器自带 boundary
 */
export async function importDocx(file: File): Promise<ImportDocxResult> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/import/docx', {
    method: 'POST',
    body: form,
  })
  if (!res.ok) return parseError(res)
  return res.json() as Promise<ImportDocxResult>
}

/** 导出 markdown → docx（返回 Blob 供前端触发下载） */
export async function exportDocx(markdown: string, filename: string): Promise<Blob> {
  const res = await fetch('/api/export/docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, filename }),
  })
  if (!res.ok) return parseError(res)
  return res.blob()
}
