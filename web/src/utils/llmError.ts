/**
 * LLM 错误分类与用户友好提示
 *
 * 把 OpenAI SDK 抛出的各种异常映射为普通用户能看懂的中文错误消息。
 */

// ===== 错误类型判断 =====

interface ClassifiedError {
  type: 'auth' | 'rate_limit' | 'network' | 'timeout' | 'server' | 'unknown'
  message: string
  detail: string
}

/**
 * 从 OpenAI SDK 的错误对象中提取用户友好的错误提示
 *
 * @param error - catch 到的 error 对象
 * @returns 分类后的错误信息
 */
export function classifyLLMError(error: unknown): ClassifiedError {
  const errMsg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '未知错误'

  // 401 / 403 — API Key 问题
  if (
    errMsg.includes('401') ||
    errMsg.includes('Unauthorized') ||
    errMsg.includes('403') ||
    errMsg.includes('Forbidden') ||
    errMsg.includes('Incorrect API key') ||
    errMsg.includes('API key') ||
    errMsg.includes('invalid_api_key')
  ) {
    return {
      type: 'auth',
      message: 'API 密钥无效或已过期',
      detail:
        '请检查 .env.local 文件中的 VITE_DEEPSEEK_API_KEY 是否正确，或重新生成 API Key。',
    }
  }

  // 429 — 频率限制 / 余额不足
  if (
    errMsg.includes('429') ||
    errMsg.includes('Rate limit') ||
    errMsg.includes('rate_limit') ||
    errMsg.includes('Insufficient balance') ||
    errMsg.includes('insufficient_quota')
  ) {
    return {
      type: 'rate_limit',
      message: '请求频率过高或余额不足',
      detail: '请稍后重试，或检查 DeepSeek 账户余额。',
    }
  }

  // 网络连接失败
  if (
    errMsg.includes('Network') ||
    errMsg.includes('network') ||
    errMsg.includes('ECONNREFUSED') ||
    errMsg.includes('ENOTFOUND') ||
    errMsg.includes('fetch failed') ||
    errMsg.includes('Failed to fetch')
  ) {
    return {
      type: 'network',
      message: '网络连接失败',
      detail: '请检查网络连接是否正常，或确认 api.deepseek.com 是否可以访问。',
    }
  }

  // 超时
  if (
    errMsg.includes('timeout') ||
    errMsg.includes('Timeout') ||
    errMsg.includes('timed out')
  ) {
    return {
      type: 'timeout',
      message: '请求超时',
      detail: '服务器响应过慢，请稍后重试。',
    }
  }

  // 5xx 服务器错误
  if (
    errMsg.includes('500') ||
    errMsg.includes('502') ||
    errMsg.includes('503') ||
    errMsg.includes('server error') ||
    errMsg.includes('Server Error')
  ) {
    return {
      type: 'server',
      message: 'DeepSeek 服务器暂时不可用',
      detail: '请稍后重试。',
    }
  }

  // LLM 返回内容为空
  if (
    errMsg.includes('返回内容为空') ||
    errMsg.includes('content is null') ||
    errMsg.includes('content is empty')
  ) {
    return {
      type: 'server',
      message: '模型返回内容为空',
      detail: '这可能是临时问题，请稍后重试。',
    }
  }

  // 其他未知错误
  return {
    type: 'unknown',
    message: '生成失败',
    detail: errMsg,
  }
}
