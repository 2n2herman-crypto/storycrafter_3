import { Router, type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import * as docxNS from 'docx'

// docx 8.5 的 .d.ts 在 NodeNext 下 export * 链解析异常（运行时正常，已 node 验证成员齐全），
// 用类型断言兜底；升级 docx 或换 moduleResolution 后可移除断言
const docx = docxNS as unknown as {
  Document: new (opts: { sections: { children: unknown[] }[] }) => unknown
  Packer: { toBuffer(doc: unknown): Promise<Buffer> }
  Paragraph: new (opts: { text?: string; heading?: string; children?: unknown[] } | string) => unknown
  TextRun: new (text: string) => unknown
  HeadingLevel: {
    HEADING_1: string
    HEADING_2: string
    HEADING_3: string
    HEADING_4: string
    HEADING_5: string
    HEADING_6: string
  }
}

export const importExportRouter = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB 上限
})

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})

// POST /api/import/docx — multipart file(.docx) → {markdown, filename}
// mammoth: docx→HTML，turndown: HTML→markdown
importExportRouter.post('/import/docx', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: { kind: 'bad_request', message: '缺少 file 字段' } })
      return
    }
    if (!req.file.originalname.toLowerCase().endsWith('.docx')) {
      res.status(400).json({ error: { kind: 'bad_request', message: '仅支持 .docx 文件' } })
      return
    }
    // docx 即 zip，校验 zip 魔数（PK\x03\x04）避免 mammoth 解析抛 500
    const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
    if (req.file.buffer.length < 4 || !req.file.buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
      res.status(400).json({ error: { kind: 'bad_request', message: '不是有效的 .docx 文件' } })
      return
    }
    const result = await mammoth.convertToHtml({ buffer: req.file.buffer })
    const markdown = turndown.turndown(result.value)
    const filename = req.file.originalname.replace(/\.docx$/i, '')
    res.json({ markdown, filename })
  } catch (e) {
    res.status(500).json({
      error: {
        kind: 'internal',
        message: 'Word 导入失败',
        detail: e instanceof Error ? e.message : String(e),
      },
    })
  }
})

// POST /api/export/docx — JSON {markdown, filename} → binary docx
// MVP：标题(#→Heading1-6) + 普通段落 + 空行；表格/列表降级为纯文本行
importExportRouter.post('/export/docx', async (req, res) => {
  try {
    const { markdown, filename } = req.body as { markdown?: string; filename?: string }
    if (typeof markdown !== 'string') {
      res.status(400).json({ error: { kind: 'bad_request', message: '缺少 markdown 字段' } })
      return
    }
    const headingMap = [
      docx.HeadingLevel.HEADING_1,
      docx.HeadingLevel.HEADING_2,
      docx.HeadingLevel.HEADING_3,
      docx.HeadingLevel.HEADING_4,
      docx.HeadingLevel.HEADING_5,
      docx.HeadingLevel.HEADING_6,
    ]
    const paragraphs: unknown[] = markdown.split(/\r?\n/).map((line) => {
      const m = line.match(/^(#{1,6})\s+(.*)/)
      if (m) {
        const level = m[1].length
        return new docx.Paragraph({ text: m[2], heading: headingMap[level - 1] })
      }
      if (line.trim() === '') return new docx.Paragraph('')
      return new docx.Paragraph({ children: [new docx.TextRun(line)] })
    })
    const doc = new docx.Document({ sections: [{ children: paragraphs }] })
    const buffer = await docx.Packer.toBuffer(doc)
    const safeName = (filename || 'export').replace(/[^\w一-龥.-]/g, '_')
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}.docx"`)
    res.send(Buffer.from(buffer))
  } catch (e) {
    res.status(500).json({
      error: {
        kind: 'internal',
        message: 'Word 导出失败',
        detail: e instanceof Error ? e.message : String(e),
      },
    })
  }
})

// multer 错误处理（文件超限等）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
importExportRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件超过 10MB 上限' : err.message
    res.status(400).json({ error: { kind: 'bad_request', message: msg } })
    return
  }
  next(err)
})
