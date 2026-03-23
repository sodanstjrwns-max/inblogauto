import { Hono } from 'hono'
import type { Bindings } from '../index'

const publishRoutes = new Hono<{ Bindings: Bindings }>()

// ====================================================================
// Inblog API Client — JSON:API (OpenAPI 3.0.3 spec compliant)
// Base URL: https://inblog.ai/api/v1
// Auth: Bearer token
// Content-Type: application/vnd.api+json
// ====================================================================

const INBLOG_BASE = 'https://inblog.ai/api/v1'

interface InblogApiKeyInfo {
  subdomain: string
  blog_id: number
  scopes: string[]
}

interface InblogPostResult {
  id: string
  slug: string
  url: string
  subdomain: string
}

interface InblogTagResult {
  id: string
  name: string
  slug: string
}

// ===== GET /me — API 키 검증 및 블로그 정보 조회 =====
async function verifyInblogApiKey(apiKey: string): Promise<InblogApiKeyInfo> {
  const response = await fetch(`${INBLOG_BASE}/me`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/vnd.api+json'
    }
  })

  if (!response.ok) {
    const errText = await response.text()
    if (response.status === 401) {
      throw new Error('인블로그 API 키가 유효하지 않습니다. Settings에서 키를 확인하세요.')
    }
    throw new Error(`인블로그 API 키 검증 실패 (${response.status}): ${errText}`)
  }

  const data: any = await response.json()
  const attrs = data?.data?.attributes || {}

  return {
    subdomain: attrs.subdomain || '',
    blog_id: attrs.blog_id || 0,
    scopes: attrs.scopes || []
  }
}

// ===== GET /authors — 작성자 목록 조회 =====
async function listInblogAuthors(apiKey: string): Promise<{ id: string; name: string }[]> {
  const response = await fetch(`${INBLOG_BASE}/authors`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/vnd.api+json'
    }
  })

  if (!response.ok) return []

  const data: any = await response.json()
  const items = data?.data || []

  return items.map((item: any) => ({
    id: String(item.id),
    name: item.attributes?.author_name || ''
  }))
}

// ===== 작성자 ID 가져오기 ("대표원장 문석준" 우선, 없으면 첫번째 작성자) =====
async function getAuthorId(apiKey: string): Promise<string | null> {
  try {
    const authors = await listInblogAuthors(apiKey)
    if (!authors.length) return null
    
    // "대표원장 문석준" 또는 "문석준" 이름으로 매칭
    const target = authors.find(a => 
      a.name.includes('문석준') || a.name.includes('대표원장')
    )
    return target ? target.id : authors[0].id
  } catch {
    return null
  }
}

// ===== GET /tags — 기존 태그 목록 조회 =====
async function listInblogTags(apiKey: string): Promise<InblogTagResult[]> {
  const response = await fetch(`${INBLOG_BASE}/tags`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/vnd.api+json'
    }
  })

  if (!response.ok) return []

  const data: any = await response.json()
  const items = data?.data || []

  return items.map((item: any) => ({
    id: String(item.id),
    name: item.attributes?.name || '',
    slug: item.attributes?.slug || ''
  }))
}

// ===== POST /tags — 태그 생성 =====
async function createInblogTag(apiKey: string, name: string): Promise<InblogTagResult> {
  const slug = name
    .toLowerCase()
    .replace(/[가-힣]+/g, (match) => {
      // Simple Korean to slug — just use the original for now
      return encodeURIComponent(match)
    })
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9가-힣%-]/g, '')
    .substring(0, 50)

  const response = await fetch(`${INBLOG_BASE}/tags`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/vnd.api+json'
    },
    body: JSON.stringify({
      jsonapi: { version: '1.0' },
      data: {
        type: 'tags',
        attributes: {
          name: name,
          slug: slug
        }
      }
    })
  })

  if (!response.ok) {
    // 409 = slug already exists — try to find existing tag
    if (response.status === 409) {
      const existing = await listInblogTags(apiKey)
      const found = existing.find(t => t.name === name || t.slug === slug)
      if (found) return found
    }
    const errText = await response.text()
    throw new Error(`태그 생성 실패 (${response.status}): ${errText}`)
  }

  const data: any = await response.json()
  return {
    id: String(data.data?.id || ''),
    name: data.data?.attributes?.name || name,
    slug: data.data?.attributes?.slug || slug
  }
}

// ===== 태그 동기화 — 태그 이름 배열 → Inblog 태그 ID 배열 =====
async function syncTags(apiKey: string, tagNames: string[]): Promise<InblogTagResult[]> {
  if (!tagNames.length) return []

  // 1. 기존 태그 목록 조회
  const existingTags = await listInblogTags(apiKey)
  const existingMap = new Map(existingTags.map(t => [t.name.toLowerCase(), t]))

  const results: InblogTagResult[] = []

  for (const name of tagNames) {
    const trimmed = name.trim()
    if (!trimmed) continue

    // 2. 이미 존재하는 태그인지 확인
    const existing = existingMap.get(trimmed.toLowerCase())
    if (existing) {
      results.push(existing)
      continue
    }

    // 3. 없으면 새로 생성
    try {
      const created = await createInblogTag(apiKey, trimmed)
      results.push(created)
    } catch (e: any) {
      console.error(`태그 "${trimmed}" 생성 실패:`, e.message)
      // 태그 하나 실패해도 계속 진행
    }
  }

  return results
}

// ===== POST /posts — JSON:API 포맷으로 포스트 생성 (draft) =====
async function createInblogPost(
  apiKey: string,
  post: {
    title: string
    slug: string
    description: string
    content_html: string
    meta_description: string
    image?: string
  },
  tagIds?: string[],
  authorId?: string | null
): Promise<InblogPostResult> {
  // Build relationships (tags + authors)
  const relationships: any = {}
  if (tagIds && tagIds.length) {
    relationships.tags = {
      data: tagIds.map(id => ({ type: 'tags', id: String(id) }))
    }
  }

  const requestBody: any = {
    jsonapi: { version: '1.0' },
    data: {
      type: 'posts',
      attributes: {
        title: post.title,
        slug: post.slug,
        description: post.description || post.meta_description,
        // ★ content_html에서 data URI 이미지 완전 제거 (Inblog 1MB 제한 대응)
        // 1) figure+img 태그 제거
        // 2) 단독 img 태그의 data URI도 제거
        // 3) 혹시 남아있는 모든 data:image 참조 제거
        content_html: post.content_html
          .replace(/<figure[^>]*>[\s\S]*?<img[^>]*src=["']data:image[^"']*["'][^>]*>[\s\S]*?<\/figure>/gi, '')
          .replace(/<img[^>]*src=["']data:image[^"']*["'][^>]*\/?>/gi, '')
          .replace(/src=["']data:image\/[^"']+["']/gi, 'src=""'),
        meta_description: post.meta_description,
        published: false, // 항상 draft로 먼저 생성
        // OG 태그 최적화 — SNS 공유 시 미리보기
        og_title: post.title,
        og_description: post.meta_description,
      }
    }
  }

  // Featured image (thumbnail) — OG image로도 사용
  // ★ data URI는 Inblog 1MB 제한 위반이므로 절대 전송 금지
  if (post.image && !post.image.startsWith('data:')) {
    requestBody.data.attributes.image = post.image
    requestBody.data.attributes.og_image = post.image
  }

  // Author relationship
  if (authorId) {
    relationships.authors = {
      data: [{ type: 'authors', id: String(authorId) }]
    }
  }

  // Relationships (tags + authors)
  if (Object.keys(relationships).length) {
    requestBody.data.relationships = relationships
  }

  const response = await fetch(`${INBLOG_BASE}/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/vnd.api+json'
    },
    body: JSON.stringify(requestBody)
  })

  if (!response.ok) {
    const errText = await response.text()
    if (response.status === 409) {
      throw new Error(`슬러그 "${post.slug}" 가 이미 존재합니다. 다른 슬러그를 사용하세요.`)
    }
    throw new Error(`인블로그 포스트 생성 실패 (${response.status}): ${errText}`)
  }

  const data: any = await response.json()
  const postData = data?.data || {}
  const postId = String(postData.id || '')

  // subdomain은 API 키 정보에서 가져와야 하므로 여기선 빈 값
  return {
    id: postId,
    slug: postData.attributes?.slug || post.slug,
    url: '', // publishPost에서 조합
    subdomain: ''
  }
}

// ===== PATCH /posts/{id}/publish — 즉시 발행 =====
async function publishInblogPost(
  apiKey: string,
  postId: string,
  action: 'publish' | 'unpublish' | 'schedule' = 'publish',
  scheduledAt?: string
): Promise<void> {
  const attributes: any = { action }
  if (action === 'schedule' && scheduledAt) {
    attributes.scheduled_at = scheduledAt
  }

  const response = await fetch(`${INBLOG_BASE}/posts/${postId}/publish`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/vnd.api+json'
    },
    body: JSON.stringify({
      jsonapi: { version: '1.0' },
      data: {
        type: 'publish_action',
        attributes
      }
    })
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`인블로그 발행 실패 (${response.status}): ${errText}`)
  }
}

// ====================================================================
// API Routes
// ====================================================================

// POST /api/publish/verify — API 키 검증 (Settings 화면에서 사용)
publishRoutes.post('/verify', async (c) => {
  const body = await c.req.json()
  const apiKey = body.api_key || ''

  if (!apiKey) {
    return c.json({ error: '인블로그 API 키를 입력하세요.' }, 400)
  }

  try {
    const info = await verifyInblogApiKey(apiKey)

    // 필수 권한 체크
    const requiredScopes = ['posts:write', 'tags:read', 'tags:write']
    const missingScopes = requiredScopes.filter(s => !info.scopes.includes(s))

    return c.json({
      success: true,
      subdomain: info.subdomain,
      blog_id: info.blog_id,
      scopes: info.scopes,
      missing_scopes: missingScopes,
      warning: missingScopes.length
        ? `다음 권한이 없습니다: ${missingScopes.join(', ')}. API 키 재생성 시 추가하세요.`
        : null
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

// POST /api/publish/:contentId — 콘텐츠를 인블로그에 발행
publishRoutes.post('/:contentId', async (c) => {
  const contentId = c.req.param('contentId')
  const body = await c.req.json().catch(() => ({}))
  const scheduleAt = (body as any).schedule_at || null // ISO 8601 string for scheduled publishing

  // 1. 콘텐츠 조회
  const content: any = await c.env.DB.prepare('SELECT * FROM contents WHERE id = ?').bind(contentId).first()
  if (!content) return c.json({ error: '콘텐츠를 찾을 수 없습니다' }, 404)

  // 2. 인블로그 설정 가져오기
  const apiKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
  const inblogApiKey = apiKeyRow?.value as string || c.env.INBLOG_API_KEY || ''

  if (!inblogApiKey) {
    return c.json({ error: '인블로그 API 키가 설정되지 않았습니다. Settings에서 입력하세요.' }, 400)
  }

  // 3. 발행 로그 생성
  const logResult = await c.env.DB.prepare(
    `INSERT INTO publish_logs (content_id, status, scheduled_at) VALUES (?, 'pending', datetime('now'))`
  ).bind(contentId).run()
  const logId = logResult.meta.last_row_id

  try {
    // 4. API 키 검증 + subdomain 가져오기
    const apiInfo = await verifyInblogApiKey(inblogApiKey)

    // 5. 태그 동기화 (content의 tags → Inblog 태그로)
    const contentTags: string[] = JSON.parse(content.tags || '[]')
    const syncedTags = await syncTags(inblogApiKey, contentTags)
    const tagIds = syncedTags.map(t => t.id)

    // 6. 작성자 ID 가져오기 ("대표원장 문석준")
    const authorId = await getAuthorId(inblogApiKey)

    // 7. 포스트 생성 (draft) — 작성자 포함
    const createResult = await createInblogPost(inblogApiKey, {
      title: content.title,
      slug: content.slug,
      description: content.meta_description,
      content_html: content.content_html,
      meta_description: content.meta_description,
      image: content.thumbnail_url || undefined
    }, tagIds, authorId)

    const inblogPostId = createResult.id
    const inblogUrl = `https://${apiInfo.subdomain}.inblog.ai/${content.slug}`

    // 8. 즉시 발행 or 예약 발행
    if (scheduleAt) {
      await publishInblogPost(inblogApiKey, inblogPostId, 'schedule', scheduleAt)
    } else {
      await publishInblogPost(inblogApiKey, inblogPostId, 'publish')
    }

    // 9. 성공 — DB 업데이트
    await c.env.DB.prepare(
      `UPDATE publish_logs SET status = 'published', inblog_post_id = ?, inblog_url = ?, published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).bind(inblogPostId, inblogUrl, logId).run()

    await c.env.DB.prepare(
      `UPDATE contents SET status = 'published', updated_at = datetime('now') WHERE id = ?`
    ).bind(contentId).run()

    return c.json({
      success: true,
      inblog_post_id: inblogPostId,
      inblog_url: inblogUrl,
      subdomain: apiInfo.subdomain,
      tags_synced: syncedTags.length,
      scheduled: !!scheduleAt,
      log_id: logId
    })

  } catch (e: any) {
    // 실패 — DB 업데이트
    await c.env.DB.prepare(
      `UPDATE publish_logs SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(e.message || 'Unknown error', logId).run()

    return c.json({ error: '발행 실패: ' + e.message }, 500)
  }
})

// POST /api/publish/retry/:logId — 재시도
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
  const inblogApiKey = apiKeyRow?.value as string || c.env.INBLOG_API_KEY || ''

  if (!inblogApiKey) {
    return c.json({ error: '인블로그 API 키가 설정되지 않았습니다.' }, 400)
  }

  try {
    const apiInfo = await verifyInblogApiKey(inblogApiKey)
    const contentTags: string[] = JSON.parse(content.tags || '[]')
    const syncedTags = await syncTags(inblogApiKey, contentTags)
    const tagIds = syncedTags.map(t => t.id)

    // 슬러그 중복 방지 — 재시도 시 타임스탬프 추가
    const retrySlug = content.slug + '-' + Date.now().toString(36)

    // 작성자 ID 가져오기
    const authorId = await getAuthorId(inblogApiKey)

    const createResult = await createInblogPost(inblogApiKey, {
      title: content.title,
      slug: retrySlug,
      description: content.meta_description,
      content_html: content.content_html,
      meta_description: content.meta_description,
      image: content.thumbnail_url || undefined
    }, tagIds, authorId)

    await publishInblogPost(inblogApiKey, createResult.id, 'publish')

    const inblogUrl = `https://${apiInfo.subdomain}.inblog.ai/${retrySlug}`

    await c.env.DB.prepare(
      `UPDATE publish_logs SET status = 'published', inblog_post_id = ?, inblog_url = ?, published_at = datetime('now'), retry_count = retry_count + 1, error_message = NULL, updated_at = datetime('now') WHERE id = ?`
    ).bind(createResult.id, inblogUrl, logId).run()

    await c.env.DB.prepare(
      `UPDATE contents SET status = 'published', updated_at = datetime('now') WHERE id = ?`
    ).bind(log.content_id).run()

    return c.json({ success: true, inblog_url: inblogUrl })

  } catch (e: any) {
    await c.env.DB.prepare(
      `UPDATE publish_logs SET retry_count = retry_count + 1, error_message = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(e.message || 'Unknown error', logId).run()

    return c.json({ error: '재시도 실패: ' + e.message }, 500)
  }
})

// GET /api/publish/tags — 인블로그 태그 목록 조회
publishRoutes.get('/tags', async (c) => {
  const apiKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
  const inblogApiKey = apiKeyRow?.value as string || c.env.INBLOG_API_KEY || ''

  if (!inblogApiKey) {
    return c.json({ error: '인블로그 API 키가 설정되지 않았습니다.' }, 400)
  }

  try {
    const tags = await listInblogTags(inblogApiKey)
    return c.json({ tags })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// Export for use in cron
export {
  publishRoutes,
  verifyInblogApiKey,
  syncTags,
  createInblogPost,
  publishInblogPost,
  getAuthorId
}
