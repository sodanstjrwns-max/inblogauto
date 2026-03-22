import { Hono } from 'hono'
import type { Bindings } from '../index'

const publishRoutes = new Hono<{ Bindings: Bindings }>()

// POST /api/publish/:contentId - 콘텐츠 발행
publishRoutes.post('/:contentId', async (c) => {
  const contentId = c.req.param('contentId')

  // 콘텐츠 조회
  const content: any = await c.env.DB.prepare('SELECT * FROM contents WHERE id = ?').bind(contentId).first()
  if (!content) return c.json({ error: '콘텐츠를 찾을 수 없습니다' }, 404)

  // 인블로그 설정 가져오기
  const apiKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
  const siteIdRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_site_id'").first()

  const inblogApiKey = apiKeyRow?.value as string || c.env.INBLOG_API_KEY || ''
  const siteId = siteIdRow?.value as string || c.env.INBLOG_SITE_ID || ''

  if (!inblogApiKey || !siteId) {
    return c.json({ error: '인블로그 API 키 또는 Site ID가 설정되지 않았습니다.' }, 400)
  }

  // 발행 로그 생성
  const logResult = await c.env.DB.prepare(
    `INSERT INTO publish_logs (content_id, status, scheduled_at) VALUES (?, 'pending', datetime('now'))`
  ).bind(contentId).run()
  const logId = logResult.meta.last_row_id

  // 인블로그 API 호출
  try {
    const tags = JSON.parse(content.tags || '[]')
    const publishResult = await publishToInblog(inblogApiKey, siteId, {
      title: content.title,
      slug: content.slug,
      content: content.content_html,
      meta_description: content.meta_description,
      tags: tags,
      status: 'published'
    })

    // 성공
    await c.env.DB.prepare(
      `UPDATE publish_logs SET status = 'published', inblog_post_id = ?, inblog_url = ?, published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).bind(publishResult.id || '', publishResult.url || '', logId).run()

    await c.env.DB.prepare(
      `UPDATE contents SET status = 'published', updated_at = datetime('now') WHERE id = ?`
    ).bind(contentId).run()

    return c.json({ success: true, inblog_url: publishResult.url, log_id: logId })

  } catch (e: any) {
    // 실패
    await c.env.DB.prepare(
      `UPDATE publish_logs SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(e.message || 'Unknown error', logId).run()

    return c.json({ error: '발행 실패: ' + e.message }, 500)
  }
})

// POST /api/publish/retry/:logId - 재시도
publishRoutes.post('/retry/:logId', async (c) => {
  const logId = c.req.param('logId')

  const log: any = await c.env.DB.prepare('SELECT * FROM publish_logs WHERE id = ?').bind(logId).first()
  if (!log) return c.json({ error: '발행 로그를 찾을 수 없습니다' }, 404)

  if (log.retry_count >= 3) {
    return c.json({ error: '최대 재시도 횟수(3회)를 초과했습니다.' }, 400)
  }

  const content: any = await c.env.DB.prepare('SELECT * FROM contents WHERE id = ?').bind(log.content_id).first()
  if (!content) return c.json({ error: '콘텐츠를 찾을 수 없습니다' }, 404)

  const apiKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
  const siteIdRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_site_id'").first()

  const inblogApiKey = apiKeyRow?.value as string || c.env.INBLOG_API_KEY || ''
  const siteId = siteIdRow?.value as string || c.env.INBLOG_SITE_ID || ''

  try {
    const tags = JSON.parse(content.tags || '[]')
    const publishResult = await publishToInblog(inblogApiKey, siteId, {
      title: content.title,
      slug: content.slug,
      content: content.content_html,
      meta_description: content.meta_description,
      tags: tags,
      status: 'published'
    })

    await c.env.DB.prepare(
      `UPDATE publish_logs SET status = 'published', inblog_post_id = ?, inblog_url = ?, published_at = datetime('now'), retry_count = retry_count + 1, error_message = NULL, updated_at = datetime('now') WHERE id = ?`
    ).bind(publishResult.id || '', publishResult.url || '', logId).run()

    await c.env.DB.prepare(
      `UPDATE contents SET status = 'published', updated_at = datetime('now') WHERE id = ?`
    ).bind(log.content_id).run()

    return c.json({ success: true, inblog_url: publishResult.url })

  } catch (e: any) {
    await c.env.DB.prepare(
      `UPDATE publish_logs SET retry_count = retry_count + 1, error_message = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(e.message || 'Unknown error', logId).run()

    return c.json({ error: '재시도 실패: ' + e.message }, 500)
  }
})

// ===== 인블로그 API 호출 =====
async function publishToInblog(
  apiKey: string,
  siteId: string,
  post: {
    title: string
    slug: string
    content: string
    meta_description: string
    tags: string[]
    status: string
  }
): Promise<{ id: string; url: string }> {
  const response = await fetch('https://api.inblog.ai/v1/posts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      title: post.title,
      slug: post.slug,
      content: post.content,
      meta_description: post.meta_description,
      tags: post.tags,
      status: post.status,
      site_id: siteId
    })
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`인블로그 API 오류 (${response.status}): ${errText}`)
  }

  const data: any = await response.json()
  return {
    id: data.id || data.data?.id || '',
    url: data.url || data.data?.url || `https://${siteId}.inblog.ai/${post.slug}`
  }
}

export { publishRoutes }
