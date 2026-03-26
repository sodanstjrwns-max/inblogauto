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
    },
    signal: AbortSignal.timeout(15000) // 15초 타임아웃
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
    },
    signal: AbortSignal.timeout(15000)
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
    },
    signal: AbortSignal.timeout(15000)
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
    }),
    signal: AbortSignal.timeout(15000)
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

  // Featured image는 CREATE 시 안 먹히므로 제외 (PATCH에서 별도 처리)
  // og_image만 문자열로 전달
  const imageUrl = (post.image && !post.image.startsWith('data:')) ? post.image : ''
  if (imageUrl) {
    requestBody.data.attributes.og_image = imageUrl
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
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(30000) // 포스트 생성은 30초
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
  
  // ★ 포스트 생성 후 PATCH로 커버 이미지(featured_image) 별도 설정
  // Inblog API는 POST 시 image 필드를 무시하고, PATCH로만 설정 가능
  if (imageUrl && postId) {
    try {
      const patchResp = await fetch(`${INBLOG_BASE}/posts/${postId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/vnd.api+json'
        },
        body: JSON.stringify({
          jsonapi: { version: '1.0' },
          data: {
            type: 'posts',
            id: postId,
            attributes: {
              image: imageUrl
            }
          }
        }),
        signal: AbortSignal.timeout(15000) // 이미지 PATCH는 15초
      })
      
      if (patchResp.ok) {
        const patchData: any = await patchResp.json()
        const savedImage = patchData?.data?.attributes?.image
        console.log(`[발행] ✅ 커버 이미지 설정 성공: ${savedImage?.url || 'unknown'}`)
      } else {
        console.warn(`[발행] ❌ 커버 이미지 PATCH 실패 (${patchResp.status}):`, await patchResp.text())
      }
    } catch (imgErr: any) {
      console.warn(`[발행] ❌ 커버 이미지 설정 에러:`, imgErr.message)
    }
  }

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
    }),
    signal: AbortSignal.timeout(20000) // 발행은 20초
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

// ====================================================================
// POST /api/publish/fix-realnames — 실명 일괄 익명화 (InBlog 포스트 직접 수정)
// ====================================================================

// 실명 치환 함수 — 정확도 우선 (오탐 최소화)
// 전략: 명시적 실명만 치환, 애매한 패턴은 건드리지 않음
function anonymizeContent(html: string): { result: string; replacements: string[] } {
  const replacements: string[] = []
  
  // ★ 패턴 1: 명시적 실명 목록 (직접 치환 — 가장 정확)
  // 원장님(문석준) 이름은 저자이므로 치환 대상이 아님!
  // 여기에는 환자 가상 실명만 추가
  const explicitNames: [string | RegExp, string][] = [
    // 예: [/김미영/g, '김모 씨'], [/박서현/g, '박모 씨'],
  ]
  
  for (const [pattern, replacement] of explicitNames) {
    const regex = typeof pattern === 'string' ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : pattern
    html = html.replace(regex, (match) => {
      replacements.push(`${match} → ${replacement}`)
      return replacement
    })
  }
  
  // ★ 패턴 2: "X모 씨" 패턴은 이미 익명화된 것이므로 건드리지 않음
  // ★ 패턴 3: "성+이름+호칭" (씨/님) — 실명+호칭 조합만 매칭
  //   주의: 일반 단어 오탐 방지를 위해 "성(1자)+이름(2자)+호칭" 만 매칭
  //   예: "김미영 씨", "박서현님" → "김모 씨", "박모님"
  //   단, 지명이나 일반 단어는 제외
  const surnames = '김이박최정강조윤장임한오서신권황안송전홍유문배류남심곽배허노하주우차방공민진어마라'
  const surnameClass = `[${surnames}]`
  
  // 성(1자) + 이름(정확히 2자) + 공백? + 호칭 — 3글자 이름 + 호칭만 매칭
  const nameHonorificPattern = new RegExp(
    `(${surnameClass})([가-힣]{2})(\\s*)(씨|님)(?![가-힣])`, 'g'
  )
  
  // 지명, 의학용어 등 오탐 방지 skipList (성+이름 부분)
  const skipFullNames = new Set([
    // 지명 (성씨+2글자)
    '서산', '홍성', '논산', '강릉', '김포', '김해', '안양', '안산', '안성',
    '정읍', '조치', '황간', '임실', '전주', '유성', '문경', '배방', '남원',
    '심곡', '곽산', '허남', '노원', '하남', '주안', '우정', '차탄', '방배',
    '공주', '민락', '진천', '진안', '어양', '마산', '마포',
    // 일반 단어 (성씨+2글자)  
    '안면', '안내', '안정', '안전', '안심', '안과',
    '전문', '전체', '전혀', '전후', '전달', '전날',
    '정상', '정확', '정도', '정보', '정기',
    '주의', '주변', '주치', '주기', '주요', '주모',
    '이식', '이상', '이후', '이전', '이물', '이보',
    '신경', '신거', '신장', '신체', '신질',
    '임상', '임시', '임플', '임라',
    '한번', '한편', '한쪽', '한국', '한약', '한치', '한마', '한밤',
    '최고', '최선', '최대', '최소', '최근', '최초', '최신', '최적',
    '강력', '강한', '강도', '강해', '강요',
    '황금', '황에',
    '조금', '조건', '조직', '조기',
    '유지', '유의', '유형', '유발', '유치',
    '문의', '문제', '문하',
    '배치', '배열',
    '남은', '남자', '남녀', '남부', '남성',
    '허용', '허리',
    '심한', '심각', '심리', '심미', '심화', '심해',
    '노출', '노력', '노화', '노인',
    '하지', '하루', '하나', '하여', '하시',
    '공간', '공급', '공포', '공유',
    '민감',
    '진행', '진단', '진료', '진통', '진정',
    '어금', '어디', '어르',
    '마취', '마감', '마찬', '마무',
    '방법', '방치', '방해', '방지',
    '차이', '차단', '차지',
    '권장', '권고',
    '장단', '장기', '장생', '장에',
    '오히', '오스', '오래',
    '송곳', '송진',
  ])
  
  html = html.replace(nameHonorificPattern, (match, surname, name, space, honorific) => {
    const fullName = surname + name
    if (skipFullNames.has(fullName)) return match
    // 이미 "X모" 형태면 건드리지 않음
    if (name === '모' || name.startsWith('모')) return match
    
    const replacement = `${surname}모${space}${honorific}`
    replacements.push(`${match} → ${replacement}`)
    return replacement
  })
  
  return { result: html, replacements }
}

publishRoutes.post('/fix-realnames', async (c) => {
  const apiKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
  const inblogApiKey = apiKeyRow?.value as string || c.env.INBLOG_API_KEY || ''
  
  if (!inblogApiKey) return c.json({ error: 'No InBlog API key configured' }, 400)
  
  // body에서 post_ids를 받거나, DB에서 전체 published 포스트 조회
  let postIds: number[] = []
  try {
    const body = await c.req.json() as any
    if (body?.post_ids && Array.isArray(body.post_ids)) {
      postIds = body.post_ids
    }
  } catch {}
  
  if (postIds.length === 0) {
    // DB에서 InBlog에 발행된 모든 포스트 조회
    const rows = await c.env.DB.prepare(`
      SELECT DISTINCT pl.inblog_post_id 
      FROM publish_logs pl 
      WHERE pl.inblog_post_id IS NOT NULL
      ORDER BY pl.inblog_post_id ASC
    `).all()
    postIds = (rows.results || []).map((r: any) => Number(r.inblog_post_id))
  }
  
  if (postIds.length === 0) {
    return c.json({ message: 'No published posts found', fixed: 0 })
  }
  
  const results: any[] = []
  let fixedCount = 0
  let errorCount = 0
  let skippedCount = 0
  
  for (const postId of postIds) {
    try {
      // 1. GET 포스트
      const getResp = await fetch(`${INBLOG_BASE}/posts/${postId}`, {
        headers: {
          'Authorization': `Bearer ${inblogApiKey}`,
          'Accept': 'application/vnd.api+json'
        }
      })
      
      if (!getResp.ok) {
        if (getResp.status === 404) {
          results.push({ post_id: postId, status: 'deleted', detail: '404 Not Found' })
          skippedCount++
          continue
        }
        results.push({ post_id: postId, status: 'error', detail: `GET ${getResp.status}` })
        errorCount++
        continue
      }
      
      const data: any = await getResp.json()
      const attrs = data?.data?.attributes || {}
      const contentHtml = attrs.content_html || ''
      const title = attrs.title || ''
      const description = attrs.description || ''
      
      // 2. 실명 탐지 + 치환
      const contentResult = anonymizeContent(contentHtml)
      const titleResult = anonymizeContent(title)
      const descResult = anonymizeContent(description)
      
      const totalReplacements = [
        ...contentResult.replacements, 
        ...titleResult.replacements,
        ...descResult.replacements
      ]
      
      if (totalReplacements.length === 0) {
        results.push({ post_id: postId, status: 'clean', title: title.slice(0, 60) })
        skippedCount++
        continue
      }
      
      // 3. PATCH로 업데이트
      const patchBody: any = {}
      if (contentResult.replacements.length > 0) patchBody.content_html = contentResult.result
      if (titleResult.replacements.length > 0) patchBody.title = titleResult.result
      if (descResult.replacements.length > 0) patchBody.description = descResult.result
      
      const patchResp = await fetch(`${INBLOG_BASE}/posts/${postId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          'Authorization': `Bearer ${inblogApiKey}`,
          'Accept': 'application/vnd.api+json'
        },
        body: JSON.stringify({
          jsonapi: { version: '1.0' },
          data: {
            type: 'posts',
            id: String(postId),
            attributes: patchBody
          }
        })
      })
      
      if (patchResp.ok) {
        fixedCount++
        results.push({ 
          post_id: postId, 
          status: 'fixed', 
          replacements_count: totalReplacements.length,
          replacements: totalReplacements.slice(0, 10),
          title: (titleResult.replacements.length > 0 ? titleResult.result : title).slice(0, 60)
        })
        console.log(`[실명수정] ✅ Post ${postId}: ${totalReplacements.length}건 치환`)
      } else {
        const errText = await patchResp.text()
        errorCount++
        results.push({ 
          post_id: postId, 
          status: 'patch_error', 
          http_status: patchResp.status,
          detail: errText.slice(0, 200)
        })
        console.log(`[실명수정] ❌ Post ${postId}: PATCH ${patchResp.status}`)
      }
      
      // DB의 content_html도 동기화
      if (contentResult.replacements.length > 0) {
        try {
          await c.env.DB.prepare(`
            UPDATE contents SET content_html = ? WHERE id IN (
              SELECT c.id FROM contents c 
              JOIN publish_logs pl ON pl.content_id = c.id 
              WHERE pl.inblog_post_id = ?
            )
          `).bind(contentResult.result, postId).run()
        } catch {}
      }
      
    } catch (e: any) {
      errorCount++
      results.push({ post_id: postId, status: 'exception', detail: e.message?.slice(0, 200) })
    }
  }
  
  return c.json({
    message: `${fixedCount}/${postIds.length}건 수정 완료 (건너뜀: ${skippedCount}, 에러: ${errorCount})`,
    total: postIds.length,
    fixed: fixedCount,
    skipped: skippedCount,
    errors: errorCount,
    results
  })
})

// POST /api/publish/scan-realnames — 실명 스캔만 (수정 없이 확인용)
publishRoutes.post('/scan-realnames', async (c) => {
  const apiKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
  const inblogApiKey = apiKeyRow?.value as string || c.env.INBLOG_API_KEY || ''
  
  if (!inblogApiKey) return c.json({ error: 'No InBlog API key configured' }, 400)
  
  let postIds: number[] = []
  try {
    const body = await c.req.json() as any
    if (body?.post_ids && Array.isArray(body.post_ids)) {
      postIds = body.post_ids
    }
  } catch {}
  
  if (postIds.length === 0) {
    const rows = await c.env.DB.prepare(`
      SELECT DISTINCT pl.inblog_post_id 
      FROM publish_logs pl 
      WHERE pl.inblog_post_id IS NOT NULL
      ORDER BY pl.inblog_post_id ASC
    `).all()
    postIds = (rows.results || []).map((r: any) => Number(r.inblog_post_id))
  }
  
  const results: any[] = []
  let affectedCount = 0
  
  for (const postId of postIds) {
    try {
      const getResp = await fetch(`${INBLOG_BASE}/posts/${postId}`, {
        headers: {
          'Authorization': `Bearer ${inblogApiKey}`,
          'Accept': 'application/vnd.api+json'
        }
      })
      
      if (!getResp.ok) {
        results.push({ post_id: postId, status: getResp.status === 404 ? 'deleted' : 'error' })
        continue
      }
      
      const data: any = await getResp.json()
      const attrs = data?.data?.attributes || {}
      const contentResult = anonymizeContent(attrs.content_html || '')
      const titleResult = anonymizeContent(attrs.title || '')
      const descResult = anonymizeContent(attrs.description || '')
      
      const all = [...contentResult.replacements, ...titleResult.replacements, ...descResult.replacements]
      
      if (all.length > 0) {
        affectedCount++
        results.push({
          post_id: postId,
          title: (attrs.title || '').slice(0, 60),
          realname_count: all.length,
          samples: all.slice(0, 5)
        })
      }
    } catch {}
  }
  
  return c.json({
    message: `${affectedCount}/${postIds.length}건에 실명 발견`,
    affected: affectedCount,
    total_scanned: postIds.length,
    details: results
  })
})

// POST /api/publish/restore-author — "문 원장" → "문석준" 원복 (임시)
publishRoutes.post('/restore-author', async (c) => {
  const apiKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
  const inblogApiKey = apiKeyRow?.value as string || c.env.INBLOG_API_KEY || ''
  if (!inblogApiKey) return c.json({ error: 'No API key' }, 400)

  let postIds: number[] = []
  try {
    const body = await c.req.json() as any
    if (body?.post_ids) postIds = body.post_ids
  } catch {}

  if (postIds.length === 0) {
    const rows = await c.env.DB.prepare(`
      SELECT DISTINCT pl.inblog_post_id FROM publish_logs pl 
      WHERE pl.inblog_post_id IS NOT NULL ORDER BY pl.inblog_post_id ASC
    `).all()
    postIds = (rows.results || []).map((r: any) => Number(r.inblog_post_id))
  }

  const results: any[] = []
  let fixedCount = 0

  for (const postId of postIds) {
    try {
      const getResp = await fetch(`${INBLOG_BASE}/posts/${postId}`, {
        headers: { 'Authorization': `Bearer ${inblogApiKey}`, 'Accept': 'application/vnd.api+json' }
      })
      if (!getResp.ok) { results.push({ post_id: postId, status: getResp.status === 404 ? 'deleted' : 'error' }); continue }
      
      const data: any = await getResp.json()
      const attrs = data?.data?.attributes || {}
      const contentHtml = (attrs.content_html || '') as string
      
      if (!contentHtml.includes('문 원장')) {
        results.push({ post_id: postId, status: 'no_change' })
        continue
      }
      
      const newHtml = contentHtml.replace(/문 원장/g, '문석준')
      
      const patchResp = await fetch(`${INBLOG_BASE}/posts/${postId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          'Authorization': `Bearer ${inblogApiKey}`,
          'Accept': 'application/vnd.api+json'
        },
        body: JSON.stringify({
          jsonapi: { version: '1.0' },
          data: { type: 'posts', id: String(postId), attributes: { content_html: newHtml } }
        })
      })
      
      if (patchResp.ok) {
        fixedCount++
        results.push({ post_id: postId, status: 'restored' })
      } else {
        results.push({ post_id: postId, status: 'patch_error', detail: (await patchResp.text()).slice(0, 100) })
      }
    } catch (e: any) {
      results.push({ post_id: postId, status: 'exception', detail: e.message?.slice(0, 100) })
    }
  }

  return c.json({ message: `${fixedCount}/${postIds.length}건 원복 완료`, fixed: fixedCount, results })
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

// GET /api/publish/debug-image/:postId — Inblog 포스트 이미지 필드 디버그
publishRoutes.get('/debug-image/:postId', async (c) => {
  const postId = c.req.param('postId')
  const apiKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
  const inblogApiKey = apiKeyRow?.value as string || ''
  
  if (!inblogApiKey) return c.json({ error: 'No API key' }, 400)
  
  // GET 포스트 상세 
  const getResp = await fetch(`${INBLOG_BASE}/posts/${postId}`, {
    headers: {
      'Authorization': `Bearer ${inblogApiKey}`,
      'Accept': 'application/vnd.api+json'
    }
  })
  
  if (!getResp.ok) {
    return c.json({ error: `GET failed: ${getResp.status}`, body: await getResp.text() })
  }
  
  const data: any = await getResp.json()
  const attrs = data?.data?.attributes || {}
  
  return c.json({
    post_id: postId,
    image: attrs.image,
    image_type: typeof attrs.image,
    og_image: attrs.og_image,
    all_keys: Object.keys(attrs),
    title: attrs.title
  })
})

// POST /api/publish/test-image/:postId — 이미지 PATCH 테스트
publishRoutes.post('/test-image/:postId', async (c) => {
  const postId = c.req.param('postId')
  const { image_url } = await c.req.json()
  const apiKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
  const inblogApiKey = apiKeyRow?.value as string || ''
  
  if (!inblogApiKey) return c.json({ error: 'No API key' }, 400)
  
  // PATCH로 이미지 설정 시도 
  const patchResp = await fetch(`${INBLOG_BASE}/posts/${postId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${inblogApiKey}`,
      'Accept': 'application/vnd.api+json'
    },
    body: JSON.stringify({
      jsonapi: { version: '1.0' },
      data: {
        type: 'posts',
        id: String(postId),
        attributes: {
          image: image_url
        }
      }
    })
  })
  
  const respText = await patchResp.text()
  let respData: any
  try { respData = JSON.parse(respText) } catch { respData = respText }
  
  return c.json({
    status: patchResp.status,
    ok: patchResp.ok,
    response_image: respData?.data?.attributes?.image,
    response_keys: Object.keys(respData?.data?.attributes || {}),
    full_response: respData
  })
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
