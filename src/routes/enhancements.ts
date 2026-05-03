import { Hono } from 'hono'
import type { Bindings } from '../index'

const enhancementRoutes = new Hono<{ Bindings: Bindings }>()

// ======================================================================
// 1. FAQ Schema (JSON-LD FAQPage) + Article Schema 자동 생성
// ======================================================================

/**
 * FAQ JSON 배열 → FAQPage JSON-LD 스키마 생성
 */
function generateFaqSchema(faqJson: { q: string; a: string }[]): string {
  if (!faqJson || faqJson.length === 0) return ''
  
  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqJson.map(item => ({
      "@type": "Question",
      "name": item.q,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": item.a
      }
    }))
  }
  
  return `<script type="application/ld+json">${JSON.stringify(schema)}</script>`
}

/**
 * MedicalWebPage Article Schema 생성
 */
function generateArticleSchema(content: {
  title: string
  meta_description: string
  slug: string
  keyword_text: string
  created_at: string
  updated_at: string
  word_count: number
  thumbnail_url?: string
}): string {
  const schema: any = {
    "@context": "https://schema.org",
    "@type": "MedicalWebPage",
    "headline": content.title,
    "description": content.meta_description,
    "url": `https://bdbddc.inblog.ai/${content.slug}`,
    "datePublished": content.created_at,
    "dateModified": content.updated_at || content.created_at,
    "author": {
      "@type": "Person",
      "name": "문석준",
      "jobTitle": "치과의사",
      "description": "서울비디치과 대표원장, 서울대학교 치의학대학원 석사, 통합치의학과 전문의",
      "url": "https://bdbddc.inblog.ai"
    },
    "publisher": {
      "@type": "Organization",
      "name": "서울비디치과",
      "url": "https://bdbddc.inblog.ai"
    },
    "about": {
      "@type": "MedicalCondition",
      "name": content.keyword_text
    },
    "wordCount": content.word_count,
    "inLanguage": "ko-KR"
  }
  
  if (content.thumbnail_url && !content.thumbnail_url.includes('placehold.co')) {
    schema.image = content.thumbnail_url
  }
  
  return `<script type="application/ld+json">${JSON.stringify(schema)}</script>`
}

/**
 * HTML에 Schema 삽입 (맨 마지막에 추가)
 */
function injectSchemaToHtml(html: string, faqJson: string, content: any): string {
  // 이미 스키마가 있으면 제거 후 재삽입 (중복 방지)
  let cleanHtml = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '').trim()
  
  let faqItems: { q: string; a: string }[] = []
  try { faqItems = JSON.parse(faqJson || '[]') } catch {}
  
  const faqSchema = generateFaqSchema(faqItems)
  const articleSchema = generateArticleSchema(content)
  
  return cleanHtml + '\n' + faqSchema + '\n' + articleSchema
}


// ======================================================================
// 2. 내부 링크 소급 적용 (Backfill) — 개선 버전
// ======================================================================

/**
 * 키워드 간 관련성 점수 계산 (개선: 시맨틱 카테고리 맵핑 강화)
 */
function calculateRelevance(keyword1: string, keyword2: string, cat1: string, cat2: string): number {
  if (keyword1 === keyword2) return 0
  
  let score = 0
  
  // 같은 카테고리 = 강한 관련성
  if (cat1 === cat2) score += 4
  
  // 키워드 단어 겹침 (부분 매칭 포함)
  const words1 = keyword1.split(/\s+/)
  const words2 = keyword2.split(/\s+/)
  const overlap = words1.filter(w => w.length >= 2 && words2.some(w2 => w2.includes(w) || w.includes(w2)))
  score += overlap.length * 2
  
  // 치과 진료 관련성 맵 (연관 치료끼리 연결)
  const semanticPairs: [string, string][] = [
    ['임플란트', '발치'], ['임플란트', '뼈이식'], ['임플란트', '잇몸'],
    ['교정', '치아'], ['교정', '라미네이트'], ['미백', '라미네이트'],
    ['신경치료', '크라운'], ['충치', '신경치료'], ['스케일링', '잇몸'],
    ['사랑니', '발치'], ['사랑니', '통증'], ['임플란트', '틀니'],
  ]
  for (const [a, b] of semanticPairs) {
    if ((keyword1.includes(a) && keyword2.includes(b)) || (keyword1.includes(b) && keyword2.includes(a))) {
      score += 3
      break
    }
  }
  
  // 관련 카테고리 맵핑
  const relatedCats: Record<string, string[]> = {
    'implant': ['general', 'prevention'],
    'general': ['implant', 'prevention', 'orthodontics'],
    'orthodontics': ['general'],
    'prevention': ['general', 'implant'],
    'local': ['implant', 'orthodontics', 'general']
  }
  if (relatedCats[cat1]?.includes(cat2)) score += 1
  
  return score
}

/**
 * 기존 콘텐츠에 내부 링크를 자동 삽입 (개선: 문맥 기반)
 */
function insertInternalLinks(
  html: string, 
  currentKeyword: string,
  allPosts: { id: number; title: string; slug: string; keyword: string; category: string }[],
  currentCategory: string,
  maxLinks: number = 3
): { html: string; insertedLinks: string[] } {
  // 관련성 점수로 정렬
  const scored = allPosts
    .filter(p => p.keyword !== currentKeyword)
    .map(p => ({
      ...p,
      relevance: calculateRelevance(currentKeyword, p.keyword, currentCategory, p.category)
    }))
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxLinks)
  
  if (scored.length === 0) return { html, insertedLinks: [] }
  
  const insertedLinks: string[] = []
  let modifiedHtml = html
  
  // 기존 내부 링크 제거 (중복 방지)
  modifiedHtml = modifiedHtml.replace(/<p[^>]*>📎 관련 글:[\s\S]*?<\/p>/g, '')
  
  // H2 섹션 위치 찾기
  const h2Positions: number[] = []
  let searchIdx = 0
  while (true) {
    const idx = modifiedHtml.indexOf('<h2', searchIdx)
    if (idx === -1) break
    h2Positions.push(idx)
    searchIdx = idx + 1
  }
  
  // 2번째~4번째 H2 앞에 관련 글 삽입
  for (let i = 0; i < scored.length && i < maxLinks; i++) {
    const post = scored[i]
    const linkHtml = `<p style="background:#f0f9ff;padding:12px 16px;border-radius:8px;border-left:3px solid #3b82f6;margin:16px 0;font-size:14px">📎 관련 글: <a href="https://bdbddc.inblog.ai/${post.slug}" style="color:#2563eb;font-weight:500;text-decoration:none" target="_blank">${post.title}</a></p>`
    
    const targetH2Idx = Math.min(i + 2, h2Positions.length - 1)
    if (h2Positions[targetH2Idx]) {
      const insertPos = h2Positions[targetH2Idx]
      modifiedHtml = modifiedHtml.slice(0, insertPos) + linkHtml + modifiedHtml.slice(insertPos)
      const offset = linkHtml.length
      for (let j = targetH2Idx; j < h2Positions.length; j++) {
        h2Positions[j] += offset
      }
      insertedLinks.push(`https://bdbddc.inblog.ai/${post.slug}`)
    }
  }
  
  return { html: modifiedHtml, insertedLinks }
}

// POST /api/enhancements/backfill-links — 기존 콘텐츠에 내부 링크 소급 적용
enhancementRoutes.post('/backfill-links', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const contentIds: number[] = (body as any).content_ids || []
  const dryRun = (body as any).dry_run || false
  const updateInblog = (body as any).update_inblog || false
  
  // 전체 발행글 목록
  const allPosts = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.slug, c.keyword_text as keyword, k.category
     FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
     WHERE c.status = 'published'
     ORDER BY c.id`
  ).all()
  
  const postList = (allPosts.results || []).map((r: any) => ({
    id: r.id, title: r.title, slug: r.slug, keyword: r.keyword, category: r.category || 'general'
  }))
  
  // ★ v7.1: SQL injection 방지 — contentIds 파라미터화
  let targets: any
  if (contentIds.length > 0) {
    const safeIds = contentIds.filter((id: number) => Number.isInteger(id) && id > 0)
    if (safeIds.length === 0) {
      return c.json({ error: 'Invalid content_ids', results: [] }, 400)
    }
    const ph = safeIds.map(() => '?').join(',')
    targets = await c.env.DB.prepare(
      `SELECT c.id, c.title, c.slug, c.keyword_text, c.meta_description,
       c.content_html, c.faq_json, c.created_at, c.updated_at, c.word_count,
       c.thumbnail_url, k.category
       FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
       WHERE c.status = 'published' AND c.id IN (${ph})
       ORDER BY c.id`
    ).bind(...safeIds).all()
  } else {
    targets = await c.env.DB.prepare(
      `SELECT c.id, c.title, c.slug, c.keyword_text, c.meta_description,
       c.content_html, c.faq_json, c.created_at, c.updated_at, c.word_count,
       c.thumbnail_url, k.category
       FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
       WHERE c.status = 'published'
       ORDER BY c.id`
    ).all()
  }
  
  const results: any[] = []
  
  for (const target of (targets.results || []) as any[]) {
    const otherPosts = postList.filter(p => p.id !== target.id)
    
    const { html: newHtml, insertedLinks } = insertInternalLinks(
      target.content_html,
      target.keyword_text,
      otherPosts,
      target.category || 'general',
      3
    )
    
    // FAQ Schema도 함께 삽입
    const htmlWithSchema = injectSchemaToHtml(newHtml, target.faq_json, target)
    
    if (!dryRun) {
      await c.env.DB.prepare(
        `UPDATE contents SET content_html = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(htmlWithSchema, target.id).run()
    }
    
    results.push({
      id: target.id,
      keyword: target.keyword_text,
      links: insertedLinks.length,
      inserted_urls: insertedLinks,
      has_schema: true,
      status: dryRun ? 'dry_run' : 'updated'
    })
  }
  
  // Inblog 자동 업데이트 (옵션)
  let inblogUpdated = 0
  if (updateInblog && !dryRun) {
    const inblogKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
    const inblogApiKey = inblogKeyRow?.value as string || c.env.INBLOG_API_KEY || ''
    
    if (inblogApiKey) {
      for (const r of results.filter(r => r.status === 'updated')) {
        try {
          const content = await c.env.DB.prepare('SELECT content_html FROM contents WHERE id = ?').bind(r.id).first() as any
          const pubLog = await c.env.DB.prepare(
            `SELECT inblog_post_id FROM publish_logs WHERE content_id = ? AND status = 'published' AND inblog_post_id IS NOT NULL ORDER BY id DESC LIMIT 1`
          ).bind(r.id).first() as any
          
          if (pubLog?.inblog_post_id && content?.content_html) {
            const response = await fetch(`https://inblog.ai/api/v1/posts/${pubLog.inblog_post_id}`, {
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
                  id: pubLog.inblog_post_id,
                  attributes: { content_html: content.content_html }
                }
              })
            })
            if (response.ok) {
              inblogUpdated++
              r.inblog_updated = true
            } else {
              r.inblog_error = `${response.status}`
            }
          }
        } catch (e: any) {
          r.inblog_error = e.message
        }
      }
    }
  }
  
  // 알림 전송
  if (!dryRun) {
    const updatedCount = results.filter(r => r.status === 'updated').length
    await sendNotification(c.env.DB, {
      type: 'backfill',
      title: '내부 링크 + Schema 소급 적용 완료',
      message: `${updatedCount}건 업데이트${inblogUpdated > 0 ? `, Inblog ${inblogUpdated}건 동기화` : ''}`,
      details: results
    })
  }
  
  return c.json({
    message: `${results.filter(r => r.status !== 'skipped').length}/${results.length}건 내부 링크 + Schema 삽입 완료`,
    dry_run: dryRun,
    inblog_updated: inblogUpdated,
    results
  })
})

// POST /api/enhancements/backfill-schema — 기존 콘텐츠에 Schema 소급 적용
enhancementRoutes.post('/backfill-schema', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dryRun = (body as any).dry_run || false
  
  const targets = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.slug, c.keyword_text, c.meta_description, 
            c.content_html, c.faq_json, c.created_at, c.updated_at, c.word_count,
            c.thumbnail_url, k.category
     FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
     WHERE c.status = 'published'`
  ).all()
  
  let updated = 0
  
  for (const target of (targets.results || []) as any[]) {
    const htmlWithSchema = injectSchemaToHtml(target.content_html, target.faq_json, target)
    
    if (!dryRun) {
      await c.env.DB.prepare(
        `UPDATE contents SET content_html = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(htmlWithSchema, target.id).run()
    }
    updated++
  }
  
  return c.json({
    message: `${updated}건 Schema 삽입 완료`,
    dry_run: dryRun,
    total: (targets.results || []).length,
    updated
  })
})

// POST /api/enhancements/update-inblog — Inblog에 업데이트된 콘텐츠 반영
enhancementRoutes.post('/update-inblog', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const contentIds: number[] = (body as any).content_ids || []
  
  const inblogKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
  const inblogApiKey = inblogKeyRow?.value as string || c.env.INBLOG_API_KEY || ''
  
  if (!inblogApiKey) return c.json({ error: 'Inblog API 키가 없습니다' }, 400)
  
  // ★ v7.1: SQL injection 방지 — contentIds 파라미터화
  let targets: any
  if (contentIds.length > 0) {
    const safeIds = contentIds.filter((id: number) => Number.isInteger(id) && id > 0)
    if (safeIds.length === 0) return c.json({ error: 'Invalid content_ids' }, 400)
    const ph = safeIds.map(() => '?').join(',')
    targets = await c.env.DB.prepare(
      `SELECT c.id, c.content_html, c.title, c.meta_description, pl.inblog_post_id
       FROM contents c JOIN publish_logs pl ON c.id = pl.content_id AND pl.status = 'published'
       WHERE c.status = 'published' AND pl.inblog_post_id IS NOT NULL AND c.id IN (${ph})`
    ).bind(...safeIds).all()
  } else {
    targets = await c.env.DB.prepare(
      `SELECT c.id, c.content_html, c.title, c.meta_description, pl.inblog_post_id
       FROM contents c JOIN publish_logs pl ON c.id = pl.content_id AND pl.status = 'published'
       WHERE c.status = 'published' AND pl.inblog_post_id IS NOT NULL`
    ).all()
  }
  
  let updated = 0
  let failed = 0
  const results: any[] = []
  
  for (const target of (targets.results || []) as any[]) {
    try {
      const response = await fetch(`https://inblog.ai/api/v1/posts/${target.inblog_post_id}`, {
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
            id: target.inblog_post_id,
            attributes: { content_html: target.content_html }
          }
        })
      })
      
      if (response.ok) {
        updated++
        results.push({ id: target.id, inblog_id: target.inblog_post_id, status: 'updated' })
      } else {
        const errText = await response.text()
        failed++
        results.push({ id: target.id, inblog_id: target.inblog_post_id, status: 'failed', error: `${response.status}: ${errText.substring(0, 200)}` })
      }
    } catch (e: any) {
      failed++
      results.push({ id: target.id, status: 'failed', error: e.message })
    }
  }
  
  return c.json({ message: `${updated}건 업데이트, ${failed}건 실패`, updated, failed, results })
})


// ======================================================================
// 3. Sitemap.xml 자동 생성 (개선: lastmod 정확화 + news sitemap)
// ======================================================================

enhancementRoutes.get('/sitemap.xml', async (c) => {
  const posts = await c.env.DB.prepare(
    `SELECT slug, title, updated_at, created_at, keyword_text FROM contents WHERE status = 'published' ORDER BY created_at DESC`
  ).all()
  
  const baseUrl = 'https://bdbddc.inblog.ai'
  
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
  <url>
    <loc>${baseUrl}</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
`
  
  for (const post of (posts.results || []) as any[]) {
    const lastmod = (post.updated_at || post.created_at || '').split(' ')[0] || new Date().toISOString().split('T')[0]
    const createdDate = (post.created_at || '').split(' ')[0]
    
    // 최근 2일 이내 글은 News sitemap 포함
    const daysSinceCreation = (Date.now() - new Date(post.created_at).getTime()) / (1000 * 60 * 60 * 24)
    const isRecent = daysSinceCreation <= 2
    
    xml += `  <url>
    <loc>${baseUrl}/${post.slug}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${isRecent ? 'daily' : 'monthly'}</changefreq>
    <priority>${isRecent ? '0.9' : '0.8'}</priority>`
    
    if (isRecent) {
      xml += `
    <news:news>
      <news:publication>
        <news:name>서울비디치과 건강정보</news:name>
        <news:language>ko</news:language>
      </news:publication>
      <news:publication_date>${createdDate}</news:publication_date>
      <news:title>${escapeXml(post.title)}</news:title>
    </news:news>`
    }
    
    xml += `
  </url>
`
  }
  
  xml += `</urlset>`
  
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=UTF-8',
      'Cache-Control': 'public, max-age=3600'
    }
  })
})

// robots.txt 엔드포인트
enhancementRoutes.get('/robots.txt', async (c) => {
  const robotsTxt = `User-agent: *
Allow: /

Sitemap: https://inblogauto.pages.dev/api/enhancements/sitemap.xml
`
  return new Response(robotsTxt, {
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
  })
})


// ======================================================================
// 4. 카니발라이제이션 감지
// ======================================================================

function keywordSimilarity(kw1: string, kw2: string): number {
  const words1 = new Set(kw1.split(/\s+/))
  const words2 = new Set(kw2.split(/\s+/))
  if (kw1 === kw2) return 1.0
  const intersection = new Set([...words1].filter(w => words2.has(w)))
  const union = new Set([...words1, ...words2])
  const jaccard = intersection.size / union.size
  const contains = kw1.includes(kw2) || kw2.includes(kw1) ? 0.3 : 0
  return Math.min(1.0, jaccard + contains)
}

function slugSimilarity(slug1: string, slug2: string): number {
  const parts1 = new Set(slug1.split('-'))
  const parts2 = new Set(slug2.split('-'))
  const intersection = new Set([...parts1].filter(w => parts2.has(w)))
  const union = new Set([...parts1, ...parts2])
  return intersection.size / union.size
}

enhancementRoutes.get('/cannibalization', async (c) => {
  const contents = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.slug, c.keyword_text, c.seo_score, k.category
     FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
     WHERE c.status = 'published' ORDER BY c.id`
  ).all()
  
  const items = (contents.results || []) as any[]
  const duplicates: any[] = []
  
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const kwSim = keywordSimilarity(items[i].keyword_text, items[j].keyword_text)
      const slugSim = slugSimilarity(items[i].slug, items[j].slug)
      const combinedScore = kwSim * 0.7 + slugSim * 0.3
      
      if (combinedScore >= 0.5) {
        duplicates.push({
          content_a: { id: items[i].id, title: items[i].title, keyword: items[i].keyword_text, slug: items[i].slug, seo: items[i].seo_score },
          content_b: { id: items[j].id, title: items[j].title, keyword: items[j].keyword_text, slug: items[j].slug, seo: items[j].seo_score },
          keyword_similarity: Math.round(kwSim * 100),
          slug_similarity: Math.round(slugSim * 100),
          risk_score: Math.round(combinedScore * 100),
          recommendation: combinedScore >= 0.8 
            ? '🔴 높은 카니발라이제이션 위험' : combinedScore >= 0.6 ? '🟡 중간 위험' : '🟢 낮은 위험'
        })
      }
    }
  }
  
  duplicates.sort((a, b) => b.risk_score - a.risk_score)
  return c.json({ total_published: items.length, cannibalization_pairs: duplicates.length, pairs: duplicates })
})

enhancementRoutes.post('/check-duplicate', async (c) => {
  const body = await c.req.json()
  const keyword = (body as any).keyword || ''
  const slug = (body as any).slug || ''
  if (!keyword) return c.json({ error: 'keyword 필요' }, 400)
  
  const existing = await c.env.DB.prepare(
    `SELECT id, title, slug, keyword_text, seo_score FROM contents WHERE status = 'published'`
  ).all()
  
  const conflicts: any[] = []
  for (const item of (existing.results || []) as any[]) {
    const kwSim = keywordSimilarity(keyword, item.keyword_text)
    const slugSim = slug ? slugSimilarity(slug, item.slug) : 0
    const combined = kwSim * 0.7 + slugSim * 0.3
    if (combined >= 0.5) {
      conflicts.push({
        existing_id: item.id, existing_keyword: item.keyword_text, existing_slug: item.slug,
        similarity: Math.round(combined * 100),
        recommendation: combined >= 0.7 ? 'BLOCK' : 'WARN'
      })
    }
  }
  
  return c.json({ keyword, is_duplicate: conflicts.some(c => c.recommendation === 'BLOCK'), has_warning: conflicts.length > 0, conflicts })
})


// ======================================================================
// 8. 알림 시스템 (슬랙 Webhook + 이메일 + 텔레그램)
// ======================================================================

// Telegram MarkdownV2 이스케이프 헬퍼
function escapeMarkdown(text: string): string {
  return text.replace(/([_\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

interface NotificationPayload {
  type: 'publish_success' | 'publish_failed' | 'cron_complete' | 'backfill' | 'error' | 'daily_report'
  title: string
  message: string
  details?: any
  url?: string
}

/**
 * 알림 전송 (슬랙 Webhook + 이메일 Webhook)
 */
async function sendNotification(db: D1Database, payload: NotificationPayload): Promise<void> {
  try {
    // 슬랙 Webhook URL 가져오기
    const slackRow = await db.prepare("SELECT value FROM settings WHERE key = 'slack_webhook_url'").first()
    const slackWebhookUrl = slackRow?.value as string || ''
    
    // 이메일 Webhook URL (Zapier/Make/IFTTT 등)
    const emailRow = await db.prepare("SELECT value FROM settings WHERE key = 'email_webhook_url'").first()
    const emailWebhookUrl = emailRow?.value as string || ''

    // 텔레그램 봇 설정
    const tgBotRow = await db.prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'").first()
    const tgChatRow = await db.prepare("SELECT value FROM settings WHERE key = 'telegram_chat_id'").first()
    const telegramBotToken = tgBotRow?.value as string || ''
    const telegramChatId = tgChatRow?.value as string || ''
    
    // 알림 활성화 여부
    const notifRow = await db.prepare("SELECT value FROM settings WHERE key = 'notifications_enabled'").first()
    const enabled = (notifRow?.value || 'true') !== 'false'
    
    if (!enabled) return
    
    const promises: Promise<any>[] = []

    // 텔레그램 알림
    if (telegramBotToken && telegramChatId) {
      const emoji = payload.type === 'publish_success' ? '✅' : 
                     payload.type === 'publish_failed' ? '❌' : 
                     payload.type === 'cron_complete' ? '🤖' :
                     payload.type === 'backfill' ? '🔗' :
                     payload.type === 'daily_report' ? '📊' : '⚠️'

      let text = `${emoji} *${escapeMarkdown(payload.title)}*\n\n${escapeMarkdown(payload.message)}`
      
      // 상세 정보 추가
      if (payload.details && Array.isArray(payload.details)) {
        const detailLines = payload.details.slice(0, 5).map((d: any) => {
          if (d.keyword && d.seo_score) return `• ${d.keyword} \\(SEO: ${d.seo_score}\\) ${d.status === 'published' ? '✅' : d.status === 'failed' ? '❌' : '📝'}`
          return `• ${escapeMarkdown(JSON.stringify(d).substring(0, 60))}`
        }).join('\n')
        text += `\n\n${detailLines}`
      }

      if (payload.url) {
        text += `\n\n[🔗 자세히 보기](${payload.url})`
      }

      // KST 시간 추가
      const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
      const timeStr = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth()+1).padStart(2,'0')}-${String(kst.getUTCDate()).padStart(2,'0')} ${String(kst.getUTCHours()).padStart(2,'0')}:${String(kst.getUTCMinutes()).padStart(2,'0')}`
      text += `\n\n_${escapeMarkdown(timeStr)} KST_`

      promises.push(
        fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text,
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: false
          })
        }).then(async (r) => {
          if (!r.ok) {
            const err = await r.text()
            console.error('텔레그램 알림 실패:', r.status, err)
          }
        }).catch(e => console.error('텔레그램 알림 오류:', e.message))
      )
    }
    
    // 슬랙 알림
    if (slackWebhookUrl && slackWebhookUrl.startsWith('https://')) {
      const emoji = payload.type === 'publish_success' ? '✅' : 
                     payload.type === 'publish_failed' ? '❌' : 
                     payload.type === 'cron_complete' ? '🤖' :
                     payload.type === 'backfill' ? '🔗' :
                     payload.type === 'daily_report' ? '📊' : '⚠️'
      
      const slackPayload = {
        text: `${emoji} *${payload.title}*`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${emoji} *${payload.title}*\n${payload.message}`
            }
          }
        ]
      }
      
      // 상세 정보 추가
      if (payload.details && Array.isArray(payload.details)) {
        const detailLines = payload.details.slice(0, 5).map((d: any) => {
          if (d.keyword && d.seo_score) return `• ${d.keyword} (SEO: ${d.seo_score}) ${d.status === 'published' ? '✅' : d.status === 'failed' ? '❌' : '📝'}`
          if (d.keyword && d.links !== undefined) return `• ${d.keyword}: 링크 ${d.links}개 ${d.inblog_updated ? '(Inblog ✅)' : ''}`
          return `• ${JSON.stringify(d).substring(0, 80)}`
        }).join('\n')
        
        slackPayload.blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: detailLines }
        })
      }
      
      if (payload.url) {
        slackPayload.blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `<${payload.url}|🔗 자세히 보기>` }
        } as any)
      }
      
      promises.push(
        fetch(slackWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slackPayload)
        }).catch(e => console.error('슬랙 알림 실패:', e.message))
      )
    }
    
    // 이메일 Webhook (범용 JSON Webhook)
    if (emailWebhookUrl && emailWebhookUrl.startsWith('https://')) {
      const emailPayload = {
        event: payload.type,
        title: payload.title,
        message: payload.message,
        timestamp: new Date().toISOString(),
        details: payload.details,
        url: payload.url
      }
      
      promises.push(
        fetch(emailWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(emailPayload)
        }).catch(e => console.error('이메일 Webhook 실패:', e.message))
      )
    }
    
    if (promises.length > 0) {
      await Promise.allSettled(promises)
    }
  } catch (e: any) {
    console.error('알림 전송 오류:', e.message)
  }
}

// POST /api/enhancements/test-notification — 알림 테스트
enhancementRoutes.post('/test-notification', async (c) => {
  await sendNotification(c.env.DB, {
    type: 'daily_report',
    title: '🧪 알림 테스트',
    message: `알림 시스템이 정상 작동합니다! (${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })})`,
    url: 'https://inblogauto.pages.dev'
  })
  return c.json({ success: true, message: '테스트 알림이 전송되었습니다' })
})

// GET /api/enhancements/notification-status — 알림 설정 상태
enhancementRoutes.get('/notification-status', async (c) => {
  const slack = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'slack_webhook_url'").first()
  const email = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'email_webhook_url'").first()
  const tgBot = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'").first()
  const tgChat = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'telegram_chat_id'").first()
  const enabled = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'notifications_enabled'").first()
  
  return c.json({
    notifications_enabled: (enabled?.value || 'true') !== 'false',
    slack_configured: !!(slack?.value),
    email_configured: !!(email?.value),
    telegram_configured: !!(tgBot?.value && tgChat?.value)
  })
})

// POST /api/enhancements/telegram/setup — 텔레그램 봇 설정
enhancementRoutes.post('/telegram/setup', async (c) => {
  const { bot_token, chat_id } = await c.req.json()
  
  if (!bot_token || !chat_id) {
    return c.json({ error: 'bot_token과 chat_id가 필요합니다.' }, 400)
  }

  // 텔레그램 봇 유효성 검증
  try {
    const verifyRes = await fetch(`https://api.telegram.org/bot${bot_token}/getMe`)
    const verifyData: any = await verifyRes.json()
    if (!verifyData.ok) {
      return c.json({ error: '유효하지 않은 봇 토큰입니다.', detail: verifyData.description }, 400)
    }

    // 설정 저장
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, description) VALUES ('telegram_bot_token', ?, '텔레그램 봇 토큰')"
    ).bind(bot_token).run()
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, description) VALUES ('telegram_chat_id', ?, '텔레그램 채팅 ID')"
    ).bind(String(chat_id)).run()

    // 테스트 메시지 발송
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
    const timeStr = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth()+1).padStart(2,'0')}-${String(kst.getUTCDate()).padStart(2,'0')} ${String(kst.getUTCHours()).padStart(2,'0')}:${String(kst.getUTCMinutes()).padStart(2,'0')}`
    
    await fetch(`https://api.telegram.org/bot${bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id,
        text: `✅ *InBlog Auto\\-Publish 알림 연결 완료\\!*\n\n이제부터 콘텐츠 발행 결과를 실시간으로 받아보실 수 있습니다\\.\n\n📊 발행 성공/실패 알림\n📋 일일 요약 리포트\n⚠️ 시스템 오류 알림\n\n_${escapeMarkdown(timeStr)} KST_`,
        parse_mode: 'MarkdownV2'
      })
    })

    return c.json({ 
      success: true, 
      bot_name: verifyData.result.first_name,
      bot_username: verifyData.result.username,
      message: `텔레그램 봇 @${verifyData.result.username} 연결 완료!`
    })
  } catch (e: any) {
    return c.json({ error: '텔레그램 API 연결 실패', detail: e.message }, 500)
  }
})

// POST /api/enhancements/daily-report — 일일 리포트 발송 (Cron에서 호출)
enhancementRoutes.post('/daily-report', async (c) => {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const today = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth()+1).padStart(2,'0')}-${String(kst.getUTCDate()).padStart(2,'0')}`

  // 오늘 발행 통계
  const todayStats: any = await c.env.DB.prepare(
    `SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) as published,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      ROUND(AVG(seo_score), 1) as avg_seo,
      ROUND(AVG(word_count), 0) as avg_words
    FROM contents 
    WHERE DATE(created_at) = ?`
  ).bind(today).first()

  // 전체 통계
  const totalStats: any = await c.env.DB.prepare(
    `SELECT COUNT(*) as total_published FROM contents WHERE status = 'published'`
  ).first()

  // 키워드 잔여량
  const kwStats: any = await c.env.DB.prepare(
    `SELECT COUNT(*) as active FROM keywords WHERE is_active = 1`
  ).first()

  // 오늘 발행된 글 목록
  const todayPosts = await c.env.DB.prepare(
    `SELECT c.title, c.seo_score, c.word_count, c.status, k.keyword, k.category
     FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
     WHERE DATE(c.created_at) = ?
     ORDER BY c.created_at DESC`
  ).bind(today).all()

  const postsPerDay = 5
  const kwDaysLeft = Math.floor((kwStats?.active || 0) / postsPerDay)

  const message = [
    `📅 ${today} 발행 리포트`,
    ``,
    `📝 오늘: ${todayStats?.published || 0}건 성공 / ${todayStats?.failed || 0}건 실패`,
    `📊 평균 SEO: ${todayStats?.avg_seo || '-'}점 | 평균 글자수: ${todayStats?.avg_words || '-'}자`,
    `📚 누적 발행: ${totalStats?.total_published || 0}건`,
    `🔑 잔여 키워드: ${kwStats?.active || 0}개 (${kwDaysLeft}일분)`,
  ].join('\n')

  const details = ((todayPosts.results || []) as any[]).map((p: any) => ({
    keyword: p.keyword || p.title,
    seo_score: p.seo_score,
    status: p.status,
    category: p.category
  }))

  await sendNotification(c.env.DB, {
    type: 'daily_report',
    title: `📊 일일 발행 리포트 (${today})`,
    message,
    details,
    url: 'https://inblogauto.pages.dev'
  })

  return c.json({ success: true, report: { today: todayStats, total: totalStats, keywords: kwStats } })
})


// ======================================================================
// Evergreen 콘텐츠 관리
// ======================================================================

enhancementRoutes.get('/evergreen', async (c) => {
  const daysThreshold = parseInt(c.req.query('days') || '90')
  
  const stale = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.slug, c.keyword_text, c.seo_score, c.word_count,
            c.created_at, c.updated_at,
            julianday('now') - julianday(c.created_at) as age_days,
            COALESCE(SUM(p.impressions), 0) as total_impressions,
            COALESCE(SUM(p.clicks), 0) as total_clicks,
            k.category
     FROM contents c
     LEFT JOIN keywords k ON c.keyword_id = k.id
     LEFT JOIN content_performance p ON c.id = p.content_id
     WHERE c.status = 'published'
       AND julianday('now') - julianday(c.created_at) >= ?
     GROUP BY c.id
     ORDER BY c.seo_score ASC, age_days DESC`
  ).bind(daysThreshold).all()
  
  const results = ((stale.results || []) as any[]).map((item: any) => {
    let priority = 0
    if (item.seo_score < 85) priority += 3
    else if (item.seo_score < 90) priority += 2
    else priority += 1
    if (item.total_impressions > 0 && item.total_clicks / item.total_impressions < 0.02) priority += 2
    if (item.age_days > 180) priority += 2
    else if (item.age_days > 90) priority += 1
    if (item.word_count < 2500) priority += 2
    
    return { ...item, age_days: Math.round(item.age_days), update_priority: priority }
  }).sort((a: any, b: any) => b.update_priority - a.update_priority)
  
  return c.json({ threshold_days: daysThreshold, total_stale: results.length, items: results })
})

enhancementRoutes.post('/refresh-content', async (c) => {
  const body = await c.req.json()
  const contentId = (body as any).content_id
  if (!contentId) return c.json({ error: 'content_id 필요' }, 400)
  
  const content: any = await c.env.DB.prepare(
    `SELECT c.*, k.category, k.search_intent FROM contents c 
     LEFT JOIN keywords k ON c.keyword_id = k.id WHERE c.id = ?`
  ).bind(contentId).first()
  if (!content) return c.json({ error: '콘텐츠를 찾을 수 없습니다' }, 404)
  
  await c.env.DB.prepare(
    `UPDATE contents SET status = 'needs_refresh', updated_at = datetime('now') WHERE id = ?`
  ).bind(contentId).run()
  
  return c.json({ success: true, content_id: contentId, keyword: content.keyword_text })
})

// ======================================================================
// 통합 개선 실행 API (한 번에 전부 실행)
// ======================================================================

enhancementRoutes.post('/run-all', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dryRun = (body as any).dry_run || false
  const updateInblog = (body as any).update_inblog || false
  
  const results: any = { schema: null, links: null, inblog: null }
  
  // 1. Schema 소급
  try {
    const schemaResp = await c.env.DB.prepare(
      `SELECT c.id, c.title, c.slug, c.keyword_text, c.meta_description, 
              c.content_html, c.faq_json, c.created_at, c.updated_at, c.word_count,
              c.thumbnail_url, k.category
       FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
       WHERE c.status = 'published'`
    ).all()
    
    let schemaUpdated = 0
    for (const target of (schemaResp.results || []) as any[]) {
      const htmlWithSchema = injectSchemaToHtml(target.content_html, target.faq_json, target)
      if (!dryRun) {
        await c.env.DB.prepare(`UPDATE contents SET content_html = ?, updated_at = datetime('now') WHERE id = ?`)
          .bind(htmlWithSchema, target.id).run()
      }
      schemaUpdated++
    }
    results.schema = { updated: schemaUpdated }
  } catch (e: any) {
    results.schema = { error: e.message }
  }
  
  // 2. 내부 링크 소급 (Schema 적용 후 최신 HTML로)
  try {
    const allPosts = await c.env.DB.prepare(
      `SELECT c.id, c.title, c.slug, c.keyword_text as keyword, k.category
       FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
       WHERE c.status = 'published' ORDER BY c.id`
    ).all()
    const postList = (allPosts.results || []).map((r: any) => ({
      id: r.id, title: r.title, slug: r.slug, keyword: r.keyword, category: r.category || 'general'
    }))
    
    const targets = await c.env.DB.prepare(
      `SELECT c.id, c.keyword_text, c.content_html, k.category
       FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
       WHERE c.status = 'published'`
    ).all()
    
    let linksUpdated = 0
    let totalLinks = 0
    for (const target of (targets.results || []) as any[]) {
      const otherPosts = postList.filter(p => p.id !== target.id)
      const { html: newHtml, insertedLinks } = insertInternalLinks(target.content_html, target.keyword_text, otherPosts, target.category || 'general', 3)
      if (insertedLinks.length > 0 && !dryRun) {
        await c.env.DB.prepare(`UPDATE contents SET content_html = ?, updated_at = datetime('now') WHERE id = ?`)
          .bind(newHtml, target.id).run()
        linksUpdated++
        totalLinks += insertedLinks.length
      }
    }
    results.links = { updated: linksUpdated, total_links: totalLinks }
  } catch (e: any) {
    results.links = { error: e.message }
  }
  
  // 3. Inblog 동기화
  if (updateInblog && !dryRun) {
    try {
      const inblogKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
      const inblogApiKey = inblogKeyRow?.value as string || c.env.INBLOG_API_KEY || ''
      
      if (inblogApiKey) {
        const targets = await c.env.DB.prepare(
          `SELECT c.id, c.content_html, pl.inblog_post_id
           FROM contents c JOIN publish_logs pl ON c.id = pl.content_id AND pl.status = 'published'
           WHERE c.status = 'published' AND pl.inblog_post_id IS NOT NULL`
        ).all()
        
        let inblogOk = 0, inblogFail = 0
        for (const t of (targets.results || []) as any[]) {
          try {
            const r = await fetch(`https://inblog.ai/api/v1/posts/${t.inblog_post_id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/vnd.api+json', 'Authorization': `Bearer ${inblogApiKey}`, 'Accept': 'application/vnd.api+json' },
              body: JSON.stringify({ jsonapi: { version: '1.0' }, data: { type: 'posts', id: t.inblog_post_id, attributes: { content_html: t.content_html } } })
            })
            if (r.ok) inblogOk++; else inblogFail++
          } catch { inblogFail++ }
        }
        results.inblog = { updated: inblogOk, failed: inblogFail }
      }
    } catch (e: any) {
      results.inblog = { error: e.message }
    }
  }
  
  return c.json({ message: '통합 개선 실행 완료', dry_run: dryRun, results })
})


// ======================================================================
// Utility
// ======================================================================
function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// ======================================================================
// 9. 토픽 클러스터 시스템 — 카테고리별 콘텐츠 맵 + 커버리지 분석
// ======================================================================

// 토픽 클러스터 정의 (카테고리 내 세부 토픽)
const TOPIC_CLUSTERS: Record<string, { name: string; topics: string[] }> = {
  implant: {
    name: '임플란트',
    topics: ['임플란트 수술', '임플란트 통증', '임플란트 가격/비용', '뼈이식', '임플란트 수명', '임플란트 관리', '임플란트 종류', '임플란트 실패', '임플란트 회복', '즉시 임플란트']
  },
  orthodontics: {
    name: '교정',
    topics: ['투명교정', '치아교정 기간', '교정 통증', '돌출입 교정', '부정교합', '교정 후 유지', '성인교정', '교정장치 종류', '교정 발치', '교정 비용']
  },
  general: {
    name: '일반진료',
    topics: ['충치 치료', '신경치료', '크라운', '사랑니', '치아 미백', '라미네이트', '잇몸 치료', '스케일링', '브릿지', '치아 파절']
  },
  prevention: {
    name: '예방관리',
    topics: ['구강위생', '치실/치간칫솔', '올바른 양치법', '정기검진', '불소도포', '어린이 치과', '임산부 치과', '구취', '이갈이', '치아 건강 식품']
  },
  local: {
    name: '지역정보',
    topics: ['천안', '아산', '대전', '세종', '청주', '당진', '서산', '공주', '보령', '논산']
  }
}

// GET /api/enhancements/topic-clusters — 토픽 클러스터 맵
enhancementRoutes.get('/topic-clusters', async (c) => {
  // 모든 발행된 포스트를 카테고리별로 그룹핑
  const posts = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.slug, c.seo_score, c.word_count, k.keyword, k.category
     FROM contents c
     LEFT JOIN keywords k ON c.keyword_id = k.id
     WHERE c.status = 'published' AND c.is_live = 1
     ORDER BY k.category, c.created_at DESC`
  ).all()

  const allPosts = (posts.results || []) as any[]
  const clusters: Record<string, any> = {}

  for (const [catKey, catDef] of Object.entries(TOPIC_CLUSTERS)) {
    const catPosts = allPosts.filter(p => p.category === catKey)
    
    // 각 토픽별 커버리지 체크
    const topicCoverage = catDef.topics.map(topic => {
      const topicWords = topic.split(/[\/\s]+/).filter(w => w.length >= 2)
      const matchingPosts = catPosts.filter(p => {
        const kw = (p.keyword || '').toLowerCase()
        const title = (p.title || '').toLowerCase()
        return topicWords.some(tw => kw.includes(tw) || title.includes(tw))
      })
      return {
        topic,
        covered: matchingPosts.length > 0,
        post_count: matchingPosts.length,
        posts: matchingPosts.slice(0, 3).map((p: any) => ({ id: p.id, title: p.title, slug: p.slug, seo_score: p.seo_score }))
      }
    })

    const coveredCount = topicCoverage.filter(t => t.covered).length
    clusters[catKey] = {
      name: catDef.name,
      total_topics: catDef.topics.length,
      covered_topics: coveredCount,
      coverage_pct: Math.round((coveredCount / catDef.topics.length) * 100),
      total_posts: catPosts.length,
      avg_seo: catPosts.length > 0 ? Math.round(catPosts.reduce((s: number, p: any) => s + (p.seo_score || 0), 0) / catPosts.length) : 0,
      topics: topicCoverage,
      uncovered: topicCoverage.filter(t => !t.covered).map(t => t.topic)
    }
  }

  // 전체 요약
  const totalTopics = Object.values(clusters).reduce((s: number, c: any) => s + c.total_topics, 0)
  const totalCovered = Object.values(clusters).reduce((s: number, c: any) => s + c.covered_topics, 0)

  return c.json({
    summary: {
      total_topics: totalTopics,
      covered_topics: totalCovered,
      coverage_pct: Math.round((totalCovered / totalTopics) * 100),
      total_posts: allPosts.length,
      recommendation: totalCovered / totalTopics < 0.5 
        ? '토픽 커버리지가 낮습니다. 미다룬 토픽 키워드를 우선 발행하세요.'
        : totalCovered / totalTopics < 0.8
        ? '커버리지가 양호합니다. 빈 토픽을 채워 Topical Authority를 강화하세요.'
        : '훌륭한 커버리지! 기존 글의 품질 업그레이드와 상호링크 강화에 집중하세요.'
    },
    clusters
  })
})

// GET /api/enhancements/topic-gaps — 미다룬 토픽 키워드 추천
enhancementRoutes.get('/topic-gaps', async (c) => {
  const posts = await c.env.DB.prepare(
    `SELECT k.keyword, k.category FROM contents c
     LEFT JOIN keywords k ON c.keyword_id = k.id
     WHERE c.status = 'published'`
  ).all()
  const usedKeywords = new Set((posts.results || []).map((p: any) => p.keyword?.toLowerCase()))
  
  const gaps: any[] = []
  for (const [catKey, catDef] of Object.entries(TOPIC_CLUSTERS)) {
    for (const topic of catDef.topics) {
      const topicWords = topic.split(/[\/\s]+/).filter(w => w.length >= 2)
      const isCovered = [...usedKeywords].some(kw => topicWords.some(tw => kw?.includes(tw)))
      if (!isCovered) {
        // 해당 토픽의 활성 키워드 추천
        const suggestions = await c.env.DB.prepare(
          `SELECT id, keyword, priority FROM keywords 
           WHERE is_active = 1 AND category = ? AND keyword LIKE ?
           ORDER BY used_count ASC, priority DESC LIMIT 5`
        ).bind(catKey, `%${topicWords[0]}%`).all()
        
        gaps.push({
          category: catKey,
          category_name: catDef.name,
          topic,
          priority: 'high',
          suggested_keywords: (suggestions.results || []).map((s: any) => ({ id: s.id, keyword: s.keyword }))
        })
      }
    }
  }

  return c.json({ 
    total_gaps: gaps.length,
    gaps: gaps.sort((a, b) => {
      // implant > general > orthodontics > prevention > local 순서 우선
      const catPriority: Record<string, number> = { implant: 5, general: 4, orthodontics: 3, prevention: 2, local: 1 }
      return (catPriority[b.category] || 0) - (catPriority[a.category] || 0)
    })
  })
})


// ======================================================================
// 10. 시즌별 키워드 자동 배치
// ======================================================================

const SEASONAL_KEYWORDS: Record<number, { season: string; keywords: string[] }> = {
  1: { season: '겨울/신년', keywords: ['새해 치과 검진', '겨울 잇몸 관리', '건조한 입술 구강', '연말 치아미백', '치과 정기검진'] },
  2: { season: '겨울/설날', keywords: ['설날 후 치통', '명절 치아 관리', '떡 치아 파절', '치과 예약', '봄 치아 준비'] },
  3: { season: '봄', keywords: ['봄 스케일링', '환절기 잇몸', '꽃가루 구강 건강', '입학 전 교정', '봄 치과 검진'] },
  4: { season: '봄', keywords: ['어린이날 치과', '봄 교정 상담', '치아 건강 식품', '구강건조증', '봄 임플란트'] },
  5: { season: '초여름', keywords: ['여름 전 미백', '구취 관리', '치아 건강 음료', '교정 여름 관리', '임플란트 여름'] },
  6: { season: '여름', keywords: ['여름 치통', '아이스크림 시린이', '여름 구강관리', '시린 이 원인', '여름 치과 휴진'] },
  7: { season: '여름/방학', keywords: ['방학 교정 시작', '방학 치과 치료', '여름 사랑니', '교정 방학', '치아 건강 간식'] },
  8: { season: '여름/가을준비', keywords: ['개학 전 치과', '가을 검진 준비', '교정 중 음식', '잇몸 출혈', '치석 제거'] },
  9: { season: '가을', keywords: ['추석 치아 관리', '명절 음식 치아', '가을 스케일링', '환절기 구강', '교정 가을 관리'] },
  10: { season: '가을', keywords: ['가을 임플란트', '연말 치료 계획', '치과 보험 활용', '연말 검진', '치아 건강 가을'] },
  11: { season: '겨울준비', keywords: ['연말 치아미백', '겨울 잇몸 관리', '연말 치과 예약', '보험 혜택 연말', '임플란트 겨울'] },
  12: { season: '겨울/연말', keywords: ['연말 치과 정산', '겨울 구강건조', '새해 교정 계획', '크리스마스 미백', '연말 건강검진'] }
}

// GET /api/enhancements/seasonal — 이번 달 시즌 키워드 추천
enhancementRoutes.get('/seasonal', async (c) => {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const month = kst.getUTCMonth() + 1
  const seasonal = SEASONAL_KEYWORDS[month] || { season: '일반', keywords: [] }
  
  // 이미 발행된 시즌 키워드 확인
  const publishedKws = await c.env.DB.prepare(
    `SELECT k.keyword FROM contents c 
     LEFT JOIN keywords k ON c.keyword_id = k.id
     WHERE c.status = 'published' 
     AND strftime('%Y-%m', c.created_at) = strftime('%Y-%m', 'now')
     AND k.keyword IS NOT NULL`
  ).all()
  const publishedSet = new Set((publishedKws.results || []).map((r: any) => r.keyword?.toLowerCase()))

  // DB에서 시즌 관련 키워드 검색
  const seasonalResults: any[] = []
  for (const kw of seasonal.keywords) {
    const searchWords = kw.split(/\s+/).filter(w => w.length >= 2)
    if (searchWords.length === 0) continue
    const matchResults = await c.env.DB.prepare(
      `SELECT id, keyword, category, used_count FROM keywords 
       WHERE is_active = 1 AND keyword LIKE ?
       ORDER BY used_count ASC LIMIT 3`
    ).bind(`%${searchWords[0]}%`).all()
    
    for (const r of (matchResults.results || []) as any[]) {
      const isPublished = publishedSet.has(r.keyword?.toLowerCase())
      seasonalResults.push({
        suggested_topic: kw,
        keyword_id: r.id,
        keyword: r.keyword,
        category: r.category,
        used_count: r.used_count,
        already_published_this_month: isPublished
      })
    }
  }

  return c.json({
    month,
    season: seasonal.season,
    seasonal_topics: seasonal.keywords,
    matching_keywords: seasonalResults.filter(r => !r.already_published_this_month),
    already_published: seasonalResults.filter(r => r.already_published_this_month).length,
    recommendation: `${month}월(${seasonal.season}) 시즌 키워드를 우선 배치하면 검색량 시즌 매칭 효과를 얻을 수 있습니다.`
  })
})

// POST /api/enhancements/seasonal/apply — 시즌 키워드 우선순위 부스트
enhancementRoutes.post('/seasonal/apply', async (c) => {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const month = kst.getUTCMonth() + 1
  const seasonal = SEASONAL_KEYWORDS[month]
  if (!seasonal) return c.json({ error: '시즌 데이터 없음' }, 404)

  let boostedCount = 0
  for (const topic of seasonal.keywords) {
    const searchWords = topic.split(/\s+/).filter(w => w.length >= 2)
    if (searchWords.length === 0) continue
    const result = await c.env.DB.prepare(
      `UPDATE keywords SET priority = MIN(priority + 2, 10) 
       WHERE is_active = 1 AND keyword LIKE ? AND priority < 10`
    ).bind(`%${searchWords[0]}%`).run()
    boostedCount += result.meta.changes || 0
  }

  return c.json({ 
    success: true, 
    month, 
    season: seasonal.season,
    boosted_keywords: boostedCount,
    message: `${boostedCount}개 시즌 키워드의 우선순위를 +2 부스트했습니다.`
  })
})

// ======================================================================
// 11. 사이트맵 자동 제출 + Google Search Console Ping
// ======================================================================

// POST /api/enhancements/sitemap/submit — 사이트맵을 주요 검색엔진에 자동 제출
enhancementRoutes.post('/sitemap/submit', async (c) => {
  const sitemapUrl = 'https://inblogauto.pages.dev/api/enhancements/sitemap.xml'
  const blogSitemapUrl = 'https://bdbddc.inblog.ai/sitemap.xml'
  
  // IndexNow 키 확인/생성
  let keyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'indexnow_api_key'").first()
  let indexNowKey = keyRow?.value as string || ''
  if (!indexNowKey) {
    // 자동 생성
    indexNowKey = crypto.randomUUID().replace(/-/g, '').substring(0, 32)
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, description) VALUES ('indexnow_api_key', ?, 'IndexNow API 키 (자동 생성)')"
    ).bind(indexNowKey).run()
  }
  
  // 모든 발행 URL 가져오기
  const posts = await c.env.DB.prepare(
    "SELECT slug FROM contents WHERE status = 'published' ORDER BY created_at DESC LIMIT 100"
  ).all()
  const urlList = (posts.results || []).map((p: any) => `https://bdbddc.inblog.ai/${p.slug}`)
  
  const indexNowPayload = {
    host: 'bdbddc.inblog.ai',
    key: indexNowKey,
    keyLocation: `https://inblogauto.pages.dev/api/indexnow/${indexNowKey}`,
    urlList
  }
  
  // IndexNow 프로토콜로 주요 검색엔진에 제출 (Google은 서치콘솔에서 사이트맵 등록 권장)
  const engines = [
    { name: 'Bing (IndexNow)', url: 'https://www.bing.com/indexnow' },
    { name: 'Naver (IndexNow)', url: 'https://searchadvisor.naver.com/indexnow' },
    { name: 'Yandex (IndexNow)', url: 'https://yandex.com/indexnow' },
    { name: 'Google Ping', url: `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`, method: 'GET' },
  ]
  
  const results: any[] = []
  
  for (const engine of engines) {
    try {
      let response: Response
      if ((engine as any).method === 'GET') {
        response = await fetch(engine.url)
      } else {
        response = await fetch(engine.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(indexNowPayload)
        })
      }
      
      const ok = response.ok || response.status === 200 || response.status === 202
      results.push({ 
        engine: engine.name, 
        status_code: response.status,
        ok,
        urls_submitted: urlList.length,
        status: ok ? 'submitted' : 'error'
      })
      
      // 로그 DB 저장
      await c.env.DB.prepare(
        "INSERT INTO sitemap_submissions (search_engine, url, status_code, submitted_at) VALUES (?, ?, ?, datetime('now'))"
      ).bind(engine.name, engine.url, response.status).run()
      
    } catch (err: any) {
      results.push({ engine: engine.name, status: 'failed', error: err.message })
    }
  }
  
  return c.json({
    message: '사이트맵 검색엔진 제출 완료',
    sitemap_url: sitemapUrl,
    blog_sitemap_url: blogSitemapUrl,
    results
  })
})

// GET /api/enhancements/sitemap/history — 사이트맵 제출 이력
enhancementRoutes.get('/sitemap/history', async (c) => {
  const logs = await c.env.DB.prepare(
    "SELECT * FROM sitemap_submissions ORDER BY submitted_at DESC LIMIT 50"
  ).all()
  return c.json({ submissions: logs.results || [] })
})


// ======================================================================
// 12. 기존 글 레트로핏 (TOC + CTA 소급 적용 + Inblog 동기화)
// ======================================================================

// CTA 템플릿 (키워드 placeholder 사용)
function buildCtaHtml(keyword: string, contentId: number): string {
  const CTA_TEMPLATES = [
    {
      emoji: '💬',
      heading: '이 글이 도움이 되셨나요?',
      body: `${keyword}에 대해 더 궁금한 점이 있으시다면, 가까운 치과에 방문하여 치과의사와 상담해보세요. 정확한 진단을 받으면 막연한 걱정이 구체적인 계획으로 바뀝니다.`,
      action: '📌 이 글을 저장해두시면 나중에 치과 방문 시 참고하실 수 있습니다.'
    },
    {
      emoji: '🔖',
      heading: '다음에 치과 방문하실 때 기억하세요',
      body: `오늘 읽으신 ${keyword} 정보를 바탕으로, 치과에서 "제 경우에는 어떤가요?"라고 한 번 물어보세요. 본인의 상황에 맞는 구체적인 답변을 받으실 수 있습니다.`,
      action: '📌 궁금한 점을 미리 메모해서 가시면 상담이 훨씬 효율적입니다.'
    },
    {
      emoji: '✅',
      heading: '마지막으로 한 가지 더',
      body: `${keyword}에 관한 정보는 시간이 지나면 달라질 수 있습니다. 최신 치료법과 본인에게 맞는 방법은 반드시 치과의사와 직접 확인하시기 바랍니다.`,
      action: '📌 주변에 같은 고민을 가진 분이 계시다면 이 글을 공유해주세요.'
    }
  ]
  const idx = contentId % CTA_TEMPLATES.length
  const cta = CTA_TEMPLATES[idx]
  return `\n<div style="background:linear-gradient(135deg,#f0f9ff 0%,#e0f2fe 100%);border:1px solid #bae6fd;border-radius:12px;padding:24px 28px;margin:32px 0 24px 0">
<p style="font-weight:700;font-size:17px;color:#0369a1;margin:0 0 12px 0">${cta.emoji} ${cta.heading}</p>
<p style="font-size:15px;color:#334155;line-height:1.7;margin:0 0 12px 0">${cta.body}</p>
<p style="font-size:14px;color:#0369a1;margin:0;font-weight:500">${cta.action}</p>
</div>\n`
}

// TOC 삽입 함수
function injectToc(html: string): { html: string; tocCount: number } {
  const tocH2Matches = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)]
  if (tocH2Matches.length < 3) return { html, tocCount: 0 }
  
  // 이미 TOC가 있는지 확인
  if (html.includes('이 글의 목차') || html.includes('table-of-contents')) {
    return { html, tocCount: tocH2Matches.length }
  }
  
  let tocItems = ''
  let h2Index = 0
  let newHtml = html.replace(/<h2([^>]*)>(.*?)<\/h2>/gi, (match, attrs, text) => {
    const cleanText = text.replace(/<[^>]*>/g, '').trim()
    const anchorId = `section-${h2Index}`
    h2Index++
    tocItems += `<li style="margin:4px 0"><a href="#${anchorId}" style="color:#2563eb;text-decoration:none;font-size:15px">${cleanText}</a></li>\n`
    if (/id=/.test(attrs)) {
      return `<h2${attrs.replace(/id="[^"]*"/, `id="${anchorId}"`)}>${text}</h2>`
    }
    return `<h2 id="${anchorId}"${attrs}>${text}</h2>`
  })

  const tocHtml = `<nav style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:12px;padding:20px 24px;margin:0 0 28px 0">
<p style="font-weight:700;font-size:16px;color:#0369a1;margin:0 0 12px 0">📋 이 글의 목차</p>
<ol style="margin:0;padding-left:20px;line-height:1.8">
${tocItems}</ol>
</nav>\n`
  
  const thumbEnd = newHtml.indexOf('</figure>')
  if (thumbEnd !== -1) {
    newHtml = newHtml.slice(0, thumbEnd + 9) + '\n' + tocHtml + newHtml.slice(thumbEnd + 9)
  } else {
    newHtml = tocHtml + newHtml
  }
  
  return { html: newHtml, tocCount: h2Index }
}

// CTA 삽입 함수
function injectCta(html: string, keyword: string, contentId: number): string {
  // 이미 CTA가 있는지 확인 (다양한 패턴)
  if (html.includes('이 글이 도움이 되셨나요') || 
      html.includes('치과 방문하실 때 기억하세요') || 
      html.includes('마지막으로 한 가지 더')) {
    return html
  }
  
  const ctaHtml = buildCtaHtml(keyword, contentId)
  
  // 의료 면책 div 앞에 삽입
  const disclaimerDivIdx = html.indexOf('<div style="background:#f0f7ff')
  if (disclaimerDivIdx !== -1) {
    return html.slice(0, disclaimerDivIdx) + ctaHtml + html.slice(disclaimerDivIdx)
  }
  // schema script 앞에 삽입
  const schemaIdx = html.indexOf('<script type="application/ld+json">')
  if (schemaIdx !== -1) {
    return html.slice(0, schemaIdx) + ctaHtml + html.slice(schemaIdx)
  }
  return html + ctaHtml
}

// POST /api/enhancements/retrofit — 기존 글에 TOC + CTA + Schema 소급 적용
enhancementRoutes.post('/retrofit', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dryRun = (body as any).dry_run || false
  const updateInblog = (body as any).update_inblog || false
  const contentIds: number[] = (body as any).content_ids || []
  
  // ★ v7.1: SQL injection 방지 — contentIds를 파라미터화
  let targets: any
  if (contentIds.length > 0) {
    // 숫자만 허용 (입력 검증)
    const safeIds = contentIds.filter(id => Number.isInteger(id) && id > 0)
    if (safeIds.length === 0) {
      return c.json({ error: 'Invalid content_ids', updated: 0 }, 400)
    }
    const placeholders = safeIds.map(() => '?').join(',')
    targets = await c.env.DB.prepare(
      `SELECT c.id, c.title, c.slug, c.keyword_text, c.meta_description,
              c.content_html, c.faq_json, c.created_at, c.updated_at, c.word_count,
              c.thumbnail_url, k.category
       FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
       WHERE c.status = 'published' AND c.id IN (${placeholders})
       ORDER BY c.id`
    ).bind(...safeIds).all()
  } else {
    targets = await c.env.DB.prepare(
      `SELECT c.id, c.title, c.slug, c.keyword_text, c.meta_description,
              c.content_html, c.faq_json, c.created_at, c.updated_at, c.word_count,
              c.thumbnail_url, k.category
       FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
       WHERE c.status = 'published'
       ORDER BY c.id`
    ).all()
  }
  const items = (targets.results || []) as any[]
  
  let tocAdded = 0, ctaAdded = 0, schemaAdded = 0, totalUpdated = 0
  const details: any[] = []
  
  // 내부 링크용 전체 포스트 목록
  const allPosts = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.slug, c.keyword_text as keyword, k.category
     FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id WHERE c.status = 'published'`
  ).all()
  const postList = (allPosts.results || []).map((r: any) => ({
    id: r.id, title: r.title, slug: r.slug, keyword: r.keyword, category: r.category || 'general'
  }))
  
  for (const item of items) {
    let html = item.content_html || ''
    let changes: string[] = []
    
    // 1. TOC 삽입
    const hasToc = html.includes('이 글의 목차') || html.includes('table-of-contents')
    if (!hasToc) {
      const tocResult = injectToc(html)
      if (tocResult.tocCount > 0) {
        html = tocResult.html
        tocAdded++
        changes.push(`TOC(${tocResult.tocCount}항목)`)
      }
    }
    
    // 2. CTA 삽입
    const hasCta = html.includes('이 글이 도움이 되셨나요') || 
                   html.includes('치과 방문하실 때 기억하세요') || 
                   html.includes('마지막으로 한 가지 더')
    if (!hasCta) {
      html = injectCta(html, item.keyword_text, item.id)
      ctaAdded++
      changes.push('CTA')
    }
    
    // 3. Schema 삽입/갱신
    const hasSchema = html.includes('application/ld+json')
    if (!hasSchema) {
      html = injectSchemaToHtml(html, item.faq_json, item)
      schemaAdded++
      changes.push('Schema')
    }
    
    // 4. 내부 링크 보강
    const otherPosts = postList.filter(p => p.id !== item.id)
    const { html: linkedHtml, insertedLinks } = insertInternalLinks(html, item.keyword_text, otherPosts, item.category || 'general', 3)
    if (insertedLinks.length > 0) {
      html = linkedHtml
      changes.push(`내부링크(${insertedLinks.length}개)`)
    }
    
    if (changes.length > 0) {
      if (!dryRun) {
        await c.env.DB.prepare(
          "UPDATE contents SET content_html = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(html, item.id).run()
      }
      totalUpdated++
      details.push({ id: item.id, title: item.title.substring(0, 40), changes })
    }
  }
  
  // Inblog 동기화
  let inblogResult: any = null
  if (updateInblog && !dryRun && totalUpdated > 0) {
    const inblogKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
    const inblogApiKey = inblogKeyRow?.value as string || c.env.INBLOG_API_KEY || ''
    
    if (inblogApiKey) {
      // ★ v7.1: SQL injection 방지 — updatedIds 파라미터화
      const updatedIds = details.map(d => d.id).filter((id: number) => Number.isInteger(id) && id > 0)
      const updPlaceholders = updatedIds.map(() => '?').join(',')
      const publishedPosts = await c.env.DB.prepare(
        `SELECT c.id, c.content_html, pl.inblog_post_id
         FROM contents c JOIN publish_logs pl ON c.id = pl.content_id AND pl.status = 'published'
         WHERE c.id IN (${updPlaceholders}) AND pl.inblog_post_id IS NOT NULL`
      ).bind(...updatedIds).all()
      
      let ok = 0, fail = 0
      for (const p of (publishedPosts.results || []) as any[]) {
        try {
          const r = await fetch(`https://inblog.ai/api/v1/posts/${p.inblog_post_id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/vnd.api+json', 'Authorization': `Bearer ${inblogApiKey}`, 'Accept': 'application/vnd.api+json' },
            body: JSON.stringify({ jsonapi: { version: '1.0' }, data: { type: 'posts', id: p.inblog_post_id, attributes: { content_html: p.content_html } } })
          })
          if (r.ok) ok++; else fail++
        } catch { fail++ }
      }
      inblogResult = { synced: ok, failed: fail }
    }
  }
  
  return c.json({
    message: `레트로핏 완료: ${totalUpdated}건 업데이트`,
    dry_run: dryRun,
    total_checked: items.length,
    updated: totalUpdated,
    toc_added: tocAdded,
    cta_added: ctaAdded,
    schema_added: schemaAdded,
    inblog_sync: inblogResult,
    details
  })
})


// ======================================================================
// 13. A/B 타이틀 테스팅 시스템
// ======================================================================

// POST /api/enhancements/ab-test/generate — 타이틀 변형 생성 (GPT 기반)
enhancementRoutes.post('/ab-test/generate', async (c) => {
  const body = await c.req.json()
  const contentId = (body as any).content_id
  if (!contentId) return c.json({ error: 'content_id 필요' }, 400)
  
  const content: any = await c.env.DB.prepare(
    "SELECT id, title, keyword_text, slug, meta_description FROM contents WHERE id = ?"
  ).bind(contentId).first()
  if (!content) return c.json({ error: '콘텐츠를 찾을 수 없습니다' }, 404)
  
  // 이미 변형이 있는지 확인
  const existing = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM title_variants WHERE content_id = ?"
  ).bind(contentId).first()
  if ((existing as any)?.cnt > 0) {
    const variants = await c.env.DB.prepare(
      "SELECT * FROM title_variants WHERE content_id = ? ORDER BY variant_label"
    ).bind(contentId).all()
    return c.json({ message: '이미 변형이 존재합니다', variants: variants.results })
  }
  
  // GPT로 타이틀 변형 3개 생성
  const apiKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").first()
  const gptKey = apiKeyRow?.value as string || c.env.OPENAI_API_KEY || ''
  const baseUrlRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'openai_base_url'").first()
  const gptBaseUrl = baseUrlRow?.value as string || 'https://www.genspark.ai/api/llm_proxy/v1'
  
  let variantTitles: string[] = [content.title] // A = 원본
  
  if (gptKey) {
    try {
      const response = await fetch(`${gptBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gptKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `아래 치과 블로그 제목의 변형 2개를 만들어주세요. 

원본 제목: ${content.title}
키워드: ${content.keyword_text}

요구사항:
1. 키워드는 반드시 포함
2. 각 변형은 다른 감정/접근법 사용 (호기심, 안심, 긴급성 등)
3. 30-60자 길이
4. 구글 검색 CTR을 높이는 데 초점

JSON으로만 답변: {"b": "변형B 제목", "c": "변형C 제목"}`
          }],
          response_format: { type: 'json_object' }
        })
      })
      
      if (response.ok) {
        const data = await response.json() as any
        const text = data.choices?.[0]?.message?.content || ''
        try {
          const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || ''
          const parsed = JSON.parse(jsonStr)
          if (parsed.b) variantTitles.push(parsed.b)
          if (parsed.c) variantTitles.push(parsed.c)
        } catch { /* 파싱 실패 시 원본만 */ }
      }
    } catch (e: any) {
      console.error('A/B title generation failed:', e.message)
    }
  }
  
  // 수동 변형 (GPT 실패 시 폴백)
  if (variantTitles.length < 3) {
    const kw = content.keyword_text
    const patterns = [
      `${kw}, 치과의사가 알려주는 핵심 포인트 (2026)`,
      `${kw} 완벽 가이드 — 치료 전 반드시 알아야 할 것들`,
      `${kw}: 환자가 가장 궁금해하는 7가지 질문`
    ]
    while (variantTitles.length < 3) {
      variantTitles.push(patterns[variantTitles.length - 1] || patterns[0])
    }
  }
  
  // DB 저장
  const labels = ['A', 'B', 'C']
  for (let i = 0; i < Math.min(variantTitles.length, 3); i++) {
    await c.env.DB.prepare(
      "INSERT INTO title_variants (content_id, variant_label, title, is_active) VALUES (?, ?, ?, ?)"
    ).bind(contentId, labels[i], variantTitles[i], i === 0 ? 1 : 0).run()
  }
  
  const variants = await c.env.DB.prepare(
    "SELECT * FROM title_variants WHERE content_id = ? ORDER BY variant_label"
  ).bind(contentId).all()
  
  return c.json({
    message: `${variantTitles.length}개 타이틀 변형 생성 완료`,
    content_id: contentId,
    original_title: content.title,
    variants: variants.results
  })
})

// POST /api/enhancements/ab-test/activate — 특정 변형 활성화 (Inblog 제목 변경)
enhancementRoutes.post('/ab-test/activate', async (c) => {
  const body = await c.req.json()
  const variantId = (body as any).variant_id
  if (!variantId) return c.json({ error: 'variant_id 필요' }, 400)
  
  const variant: any = await c.env.DB.prepare(
    "SELECT * FROM title_variants WHERE id = ?"
  ).bind(variantId).first()
  if (!variant) return c.json({ error: '변형을 찾을 수 없습니다' }, 404)
  
  // 모든 변형 비활성화 후 선택한 것만 활성화
  await c.env.DB.prepare(
    "UPDATE title_variants SET is_active = 0 WHERE content_id = ?"
  ).bind(variant.content_id).run()
  
  await c.env.DB.prepare(
    "UPDATE title_variants SET is_active = 1, activated_at = datetime('now') WHERE id = ?"
  ).bind(variantId).run()
  
  // contents 테이블도 업데이트
  await c.env.DB.prepare(
    "UPDATE contents SET title = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(variant.title, variant.content_id).run()
  
  // Inblog 제목 변경 시도
  let inblogResult = null
  const inblogKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
  const inblogApiKey = inblogKeyRow?.value as string || ''
  
  if (inblogApiKey) {
    const publishLog: any = await c.env.DB.prepare(
      "SELECT inblog_post_id FROM publish_logs WHERE content_id = ? AND status = 'published' AND inblog_post_id IS NOT NULL LIMIT 1"
    ).bind(variant.content_id).first()
    
    if (publishLog?.inblog_post_id) {
      try {
        const r = await fetch(`https://inblog.ai/api/v1/posts/${publishLog.inblog_post_id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/vnd.api+json', 'Authorization': `Bearer ${inblogApiKey}`, 'Accept': 'application/vnd.api+json' },
          body: JSON.stringify({ jsonapi: { version: '1.0' }, data: { type: 'posts', id: publishLog.inblog_post_id, attributes: { title: variant.title } } })
        })
        inblogResult = { synced: r.ok, status: r.status }
      } catch (e: any) {
        inblogResult = { synced: false, error: e.message }
      }
    }
  }
  
  return c.json({
    message: `변형 ${variant.variant_label} 활성화 완료`,
    variant,
    inblog_sync: inblogResult
  })
})

// POST /api/enhancements/ab-test/record — CTR 데이터 기록
enhancementRoutes.post('/ab-test/record', async (c) => {
  const body = await c.req.json()
  const variantId = (body as any).variant_id
  const impressions = (body as any).impressions || 0
  const clicks = (body as any).clicks || 0
  
  if (!variantId) return c.json({ error: 'variant_id 필요' }, 400)
  
  await c.env.DB.prepare(
    `UPDATE title_variants SET 
     impressions = impressions + ?, 
     clicks = clicks + ?,
     ctr = CASE WHEN (impressions + ?) > 0 THEN CAST((clicks + ?) AS REAL) / (impressions + ?) ELSE 0 END
     WHERE id = ?`
  ).bind(impressions, clicks, impressions, clicks, impressions, variantId).run()
  
  return c.json({ success: true })
})

// GET /api/enhancements/ab-test/results — 전체 A/B 테스트 결과
enhancementRoutes.get('/ab-test/results', async (c) => {
  const contentId = c.req.query('content_id')
  
  let query = `SELECT tv.*, c.keyword_text, c.slug 
               FROM title_variants tv
               JOIN contents c ON tv.content_id = c.id`
  if (contentId) query += ` WHERE tv.content_id = ${parseInt(contentId)}`
  query += ` ORDER BY tv.content_id, tv.variant_label`
  
  const variants = await c.env.DB.prepare(query).all()
  
  // 콘텐츠별 그룹핑
  const grouped: Record<number, any> = {}
  for (const v of (variants.results || []) as any[]) {
    if (!grouped[v.content_id]) {
      grouped[v.content_id] = { content_id: v.content_id, keyword: v.keyword_text, slug: v.slug, variants: [], winner: null }
    }
    grouped[v.content_id].variants.push(v)
  }
  
  // 승자 판정 (최소 100 노출 + 가장 높은 CTR)
  for (const g of Object.values(grouped)) {
    const qualified = g.variants.filter((v: any) => v.impressions >= 100)
    if (qualified.length >= 2) {
      qualified.sort((a: any, b: any) => b.ctr - a.ctr)
      g.winner = { variant_id: qualified[0].id, label: qualified[0].variant_label, ctr: qualified[0].ctr, title: qualified[0].title }
    }
  }
  
  return c.json({ 
    total_tests: Object.keys(grouped).length,
    tests: Object.values(grouped)
  })
})

// GET /api/enhancements/ab-test/list — A/B 테스트 대상 콘텐츠 목록
enhancementRoutes.get('/ab-test/list', async (c) => {
  const contents = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.keyword_text, c.seo_score, c.slug,
            (SELECT COUNT(*) FROM title_variants tv WHERE tv.content_id = c.id) as variant_count
     FROM contents c WHERE c.status = 'published' ORDER BY c.id DESC`
  ).all()
  return c.json({ contents: contents.results || [] })
})


// ======================================================================
// 14. 환자 질문 크롤링 시스템 (네이버 지식iN + Google PAA)
// ======================================================================

// POST /api/enhancements/patient-questions/crawl — 환자 질문 수집
enhancementRoutes.post('/patient-questions/crawl', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const keywords: string[] = (body as any).keywords || []
  const source = (body as any).source || 'naver_kin'
  
  // 키워드 미지정 시 DB에서 주요 카테고리별 키워드 가져오기
  let searchKeywords = keywords
  if (searchKeywords.length === 0) {
    const dbKeywords = await c.env.DB.prepare(
      `SELECT keyword, category FROM keywords 
       WHERE is_active = 1 
       GROUP BY category 
       ORDER BY RANDOM() LIMIT 10`
    ).all()
    searchKeywords = (dbKeywords.results || []).map((k: any) => k.keyword)
  }
  
  const allQuestions: any[] = []
  
  for (const kw of searchKeywords.slice(0, 10)) {
    try {
      if (source === 'naver_kin' || source === 'all') {
        // 네이버 지식iN 검색 (API 없이 웹 검색 결과 활용)
        const naverUrl = `https://search.naver.com/search.naver?where=kin&query=${encodeURIComponent(kw + ' 치과')}&sm=tab_opt&sort=0`
        
        try {
          const resp = await fetch(naverUrl, {
            headers: { 
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept-Language': 'ko-KR,ko;q=0.9'
            }
          })
          const html = await resp.text()
          
          // 질문 제목 추출 (간단한 파싱)
          const titleRegex = /<a[^>]*class="[^"]*question_text[^"]*"[^>]*>(.*?)<\/a>/gi
          const altTitleRegex = /<a[^>]*title="([^"]*)"[^>]*class="[^"]*_title[^"]*"/gi
          
          let match
          while ((match = titleRegex.exec(html)) !== null) {
            const question = match[1].replace(/<[^>]*>/g, '').trim()
            if (question.length > 10 && question.length < 200) {
              allQuestions.push({
                source: 'naver_kin',
                query: kw,
                question,
                category: await categorizeQuestion(question),
                relevance_score: calculateQuestionRelevance(question, kw)
              })
            }
          }
          while ((match = altTitleRegex.exec(html)) !== null) {
            const question = match[1].replace(/<[^>]*>/g, '').trim()
            if (question.length > 10 && question.length < 200 && !allQuestions.some(q => q.question === question)) {
              allQuestions.push({
                source: 'naver_kin',
                query: kw,
                question,
                category: await categorizeQuestion(question),
                relevance_score: calculateQuestionRelevance(question, kw)
              })
            }
          }
        } catch (fetchErr: any) {
          console.warn(`네이버 크롤링 실패 (${kw}):`, fetchErr.message)
        }
      }
      
      if (source === 'google_paa' || source === 'all') {
        // Google "People Also Ask" 시뮬레이션
        // (실제로는 SerpAPI 등을 쓰지만, 여기선 키워드 기반 질문 생성)
        const paaPatterns = [
          `${kw} 비용이 얼마나 드나요?`,
          `${kw} 기간은 얼마나 걸리나요?`,
          `${kw} 아프지 않나요?`,
          `${kw} 후에 주의할 점은?`,
          `${kw} 부작용은 없나요?`,
          `${kw} 언제 해야 하나요?`,
          `${kw} vs 다른 치료 차이점은?`
        ]
        
        for (const q of paaPatterns) {
          allQuestions.push({
            source: 'google_paa',
            query: kw,
            question: q,
            category: await categorizeQuestion(q),
            relevance_score: calculateQuestionRelevance(q, kw)
          })
        }
      }
    } catch (err: any) {
      console.error(`질문 크롤링 실패 (${kw}):`, err.message)
    }
  }
  
  // 중복 제거 + 관련성 높은 순 정렬
  const uniqueQuestions = allQuestions
    .filter((q, i, arr) => arr.findIndex(a => a.question === q.question) === i)
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, 100)
  
  // DB 저장
  let saved = 0
  for (const q of uniqueQuestions) {
    try {
      // 중복 확인
      const exists = await c.env.DB.prepare(
        "SELECT id FROM patient_questions WHERE question = ?"
      ).bind(q.question).first()
      
      if (!exists) {
        await c.env.DB.prepare(
          "INSERT INTO patient_questions (source, query, question, category, relevance_score) VALUES (?, ?, ?, ?, ?)"
        ).bind(q.source, q.query, q.question, q.category, q.relevance_score).run()
        saved++
      }
    } catch { /* 중복 무시 */ }
  }
  
  return c.json({
    message: `환자 질문 ${saved}건 수집 완료`,
    source,
    searched_keywords: searchKeywords.slice(0, 10),
    total_found: allQuestions.length,
    unique_saved: saved,
    top_questions: uniqueQuestions.slice(0, 20).map(q => ({
      question: q.question,
      source: q.source,
      category: q.category,
      relevance: Math.round(q.relevance_score * 100)
    }))
  })
})

// GET /api/enhancements/patient-questions — 수집된 질문 목록
enhancementRoutes.get('/patient-questions', async (c) => {
  const category = c.req.query('category')
  const unused = c.req.query('unused') === 'true'
  
  let query = "SELECT * FROM patient_questions WHERE 1=1"
  const binds: any[] = []
  if (category) { query += " AND category = ?"; binds.push(category) }
  if (unused) { query += " AND is_used = 0" }
  query += " ORDER BY relevance_score DESC, crawled_at DESC LIMIT 100"
  
  let stmt = c.env.DB.prepare(query)
  if (binds.length > 0) stmt = stmt.bind(...binds)
  const questions = await stmt.all()
  
  // 카테고리별 통계
  const stats = await c.env.DB.prepare(
    "SELECT category, COUNT(*) as count, SUM(CASE WHEN is_used = 0 THEN 1 ELSE 0 END) as unused_count FROM patient_questions GROUP BY category"
  ).all()
  
  return c.json({
    total: (questions.results || []).length,
    category_stats: stats.results || [],
    questions: questions.results || []
  })
})

// POST /api/enhancements/patient-questions/to-keywords — 질문을 키워드 DB에 반영
enhancementRoutes.post('/patient-questions/to-keywords', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const questionIds: number[] = (body as any).question_ids || []
  const autoSelect = (body as any).auto_select || false
  
  let questions: any[]
  if (autoSelect) {
    // 관련성 높고 미사용인 질문 자동 선택
    const result = await c.env.DB.prepare(
      "SELECT * FROM patient_questions WHERE is_used = 0 ORDER BY relevance_score DESC LIMIT 20"
    ).all()
    questions = (result.results || []) as any[]
  } else if (questionIds.length > 0) {
    // ★ v7.1: SQL injection 방지 — questionIds 파라미터화
    const safeQIds = questionIds.filter((id: number) => Number.isInteger(id) && id > 0)
    if (safeQIds.length === 0) return c.json({ error: 'Invalid question_ids' }, 400)
    const ph = safeQIds.map(() => '?').join(',')
    const result = await c.env.DB.prepare(
      `SELECT * FROM patient_questions WHERE id IN (${ph}) AND is_used = 0`
    ).bind(...safeQIds).all()
    questions = (result.results || []) as any[]
  } else {
    return c.json({ error: 'question_ids 또는 auto_select 필요' }, 400)
  }
  
  let added = 0, skipped = 0
  for (const q of questions) {
    // 질문에서 핵심 키워드 추출 (불필요한 부분 제거)
    let keyword = q.question
      .replace(/\?|？|~|!|。/g, '')
      .replace(/^(.*?)(이|가|은|는|을|를)\s*(어떻게|얼마나|왜|언제|어디서)/g, '$1')
      .trim()
    
    // 이미 존재하는 키워드인지 확인
    const existing = await c.env.DB.prepare(
      "SELECT id FROM keywords WHERE keyword = ? OR keyword LIKE ?"
    ).bind(keyword, `%${keyword.substring(0, 10)}%`).first()
    
    if (!existing && keyword.length >= 4) {
      await c.env.DB.prepare(
        "INSERT INTO keywords (keyword, category, priority, source, is_active) VALUES (?, ?, 5, 'patient_question', 1)"
      ).bind(keyword, q.category || 'general').run()
      
      await c.env.DB.prepare(
        "UPDATE patient_questions SET is_used = 1, keyword_match = ? WHERE id = ?"
      ).bind(keyword, q.id).run()
      added++
    } else {
      skipped++
      // 매칭되더라도 사용 처리
      await c.env.DB.prepare("UPDATE patient_questions SET is_used = 1 WHERE id = ?").bind(q.id).run()
    }
  }
  
  return c.json({
    message: `${added}개 키워드 추가, ${skipped}개 중복/제외`,
    added,
    skipped,
    total_processed: questions.length
  })
})

// 질문 카테고리 자동 분류
async function categorizeQuestion(question: string): Promise<string> {
  const q = question.toLowerCase()
  if (/임플란트|뼈이식|식립|임프란트/.test(q)) return 'implant'
  if (/교정|투명|돌출|부정교합|브라켓/.test(q)) return 'orthodontics'
  if (/예방|양치|치실|스케일링|불소|검진/.test(q)) return 'prevention'
  if (/충치|신경치료|크라운|사랑니|발치|미백|라미네이트|잇몸/.test(q)) return 'general'
  return 'general'
}

// 질문-키워드 관련성 점수 계산
function calculateQuestionRelevance(question: string, keyword: string): number {
  const q = question.toLowerCase()
  const kw = keyword.toLowerCase()
  
  let score = 0
  // 키워드 직접 포함
  if (q.includes(kw)) score += 0.5
  // 단어별 매칭
  const kwWords = kw.split(/\s+/)
  const matchedWords = kwWords.filter(w => q.includes(w))
  score += (matchedWords.length / kwWords.length) * 0.3
  // 치과 관련 키워드 보너스
  if (/치과|치아|치료|통증|아프|수술|비용|기간|회복/.test(q)) score += 0.1
  // 질문 형태 보너스 (실제 환자 질문 패턴)
  if (/\?|인가요|일까요|해야|할까|나요|되나요|않나요/.test(q)) score += 0.1
  
  return Math.min(1.0, score)
}


// ===== 이미지 URL 일괄 수정 (깨진 이미지 → 플레이스홀더 교체) =====
enhancementRoutes.post('/fix-images', async (c) => {
  const { update_inblog, dry_run } = await c.req.json().catch(() => ({ update_inblog: false, dry_run: true }))
  
  // 깨진 이미지 URL 패턴 (자체 API 이미지 + 중단된 Pollinations)
  const brokenPattern = /https:\/\/inblogauto\.pages\.dev\/api\/image\/(\d+)\/(thumbnail|body_\d+)\.jpg/g
  const pollinationsPattern = /https:\/\/image\.pollinations\.ai\/[^"'\s<>)]+/g
  
  // 발행된 콘텐츠 조회
  const contents: any[] = await c.env.DB.prepare(
    "SELECT id, keyword_text, content_html, thumbnail_url, slug FROM contents WHERE content_html LIKE '%inblogauto.pages.dev/api/image%' OR content_html LIKE '%pollinations.ai%'"
  ).all().then((r: any) => r.results || [])
  
  if (!contents.length) {
    return c.json({ message: '수정할 콘텐츠가 없습니다', fixed: 0 })
  }

  let fixed = 0
  let inblogUpdated = 0
  const details: any[] = []
  
  // Inblog API 키
  let inblogApiKey = ''
  if (update_inblog) {
    try {
      const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
      inblogApiKey = row?.value as string || ''
    } catch {}
  }

  const colors = ['4A90D9', '5B8C5A', '8B5CF6', 'D97706', '0891B2', '7C3AED', '059669']
  for (const content of contents) {
    let newHtml = content.content_html
    let newThumb = content.thumbnail_url || ''
    const replacements: string[] = []
    const keyword = content.keyword_text || '치과'
    const colorIdx = Math.abs(content.id) % colors.length
    
    // 깨진 자체 API 이미지 → 플레이스홀더
    newHtml = newHtml.replace(brokenPattern, (match: string, contentId: string, imageType: string) => {
      const w = imageType === 'thumbnail' ? 1200 : 1200
      const h = imageType === 'thumbnail' ? 630 : 800
      replacements.push(`${imageType} → placehold.co`)
      return `https://placehold.co/${w}x${h}/${colors[colorIdx]}/ffffff?text=${encodeURIComponent(keyword)}&font=sans-serif`
    })
    
    // 중단된 Pollinations URL → 플레이스홀더
    newHtml = newHtml.replace(pollinationsPattern, () => {
      replacements.push('pollinations → placehold.co')
      return `https://placehold.co/1200x630/${colors[colorIdx]}/ffffff?text=${encodeURIComponent(keyword)}&font=sans-serif`
    })
    
    // 썸네일 URL도 교체
    if (newThumb.includes('inblogauto.pages.dev/api/image') || newThumb.includes('pollinations.ai')) {
      newThumb = `https://placehold.co/1200x630/${colors[colorIdx]}/ffffff?text=${encodeURIComponent(keyword)}&font=sans-serif`
      replacements.push('thumbnail_url → placehold.co')
    }
    
    if (replacements.length === 0) continue
    
    if (!dry_run) {
      // DB 업데이트
      await c.env.DB.prepare(
        "UPDATE contents SET content_html = ?, thumbnail_url = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(newHtml, newThumb, content.id).run()
      
      // Inblog 업데이트
      if (update_inblog && inblogApiKey) {
        try {
          const logRow = await c.env.DB.prepare(
            "SELECT inblog_post_id FROM publish_logs WHERE content_id = ? AND status = 'published' ORDER BY id DESC LIMIT 1"
          ).bind(content.id).first()
          
          if (logRow?.inblog_post_id) {
            const patchResp = await fetch(`https://inblog.ai/api/v1/posts/${logRow.inblog_post_id}`, {
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
                  id: String(logRow.inblog_post_id),
                  attributes: {
                    content_html: newHtml,
                    og_image: newThumb
                  }
                }
              })
            })
            if (patchResp.ok) inblogUpdated++
          }
        } catch (e: any) {
          console.warn(`[이미지수정] Inblog 업데이트 실패 (ID ${content.id}):`, e.message)
        }
      }
    }
    
    fixed++
    details.push({ id: content.id, keyword: content.keyword_text, changes: replacements })
  }
  
  return c.json({
    message: `${fixed}개 콘텐츠 이미지 ${dry_run ? '수정 예정' : '수정 완료'}`,
    fixed,
    inblog_updated: inblogUpdated,
    dry_run: !!dry_run,
    details
  })
})

// ===== 실명 전수 검사 & 익명화 시스템 =====
// 공통: 실명 탐지 로직 (cron.ts의 후처리 필터와 동일 + 오탐 강화)
const COMMON_SURNAMES = '김이박최정강조윤장임한오서신권황안송전홍유고문양손배조백허노남심하주우곽성차유구연'

// 오탐 방지: 일반 단어/의학용어/지명/동사형 skipList
const REALNAME_SKIP_WORDS = new Set([
  // 안~
  '안전', '안정', '안내', '안과', '안심', '안면', '안쪽', '안되',
  // 전~
  '전문', '전체', '전혀', '전후', '전달', '전날', '전반', '전신',
  // 정~
  '정상', '정확', '정도', '정보', '정기', '정말', '정밀', '정리', '정에서',
  // 주~
  '주의', '주변', '주치', '주기', '주요', '주로', '주사',
  // 이~
  '이식', '이상', '이후', '이전', '이물', '이때', '이런', '이유',
  // 신~
  '신경', '신장', '신체', '신질', '신거', '신속', '신뢰',
  // 임~
  '임상', '임시', '임플', '임신',
  // 한~
  '한번', '한편', '한쪽', '한국', '한약', '한치', '한마', '한밤', '한동',
  // 최~
  '최고', '최선', '최대', '최소', '최근', '최초', '최신', '최적',
  // 강~
  '강력', '강한', '강도', '강해', '강요', '강화',
  // 조~
  '조금', '조건', '조직', '조기', '조절',
  // 유~
  '유지', '유의', '유형', '유발', '유치', '유리', '유사',
  // 문~
  '문의', '문제', '문헌',
  // 배~
  '배치', '배열', '배출',
  // 남~
  '남은', '남자', '남녀', '남성',
  // 허~
  '허용', '허리',
  // 심~
  '심한', '심각', '심리', '심미', '심해', '심장',
  // 노~
  '노출', '노력', '노화', '노인',
  // 하~
  '하지', '하루', '하나', '하시', '하셔', '하였',
  // 오~
  '오시', '오래', '오히', '오스', '오해',
  // 공~
  '공간', '공급', '공포', '공유',
  // 기타 (진~, 마~, 방~ 등)
  '진행', '진단', '진료', '진통', '진정', '진짜',
  '마취', '마감', '마찬', '마무', '마지',
  '어금', '어디', '어르', '어느',
  '방법', '방치', '방해', '방지', '방문',
  '차이', '차단', '차지', '차원',
  '권장', '권고',
  '장단', '장기', '장치', '장착',
  '민감',
  // 의학 용어 (성씨+2글자 형태지만 실명 아닌 것들)
  '고혈압', '구내염', '구강건', '구강내', '구강외', '구강위',
  '성장기', '성공률', '성인에', '성별에',
  '전신질', '전신마', '전신건', '전신상',
  '장기간', '장기적',
  '임플란', '임플렌', '임산부',
  '유치원', '유지보',
  '배농술',
  // 동사/형용사형 2글자 (성씨 뒤에 올 수 있지만 이름 아닌 것)
  '시는', '하는', '되는', '오는', '가는', '나는', '받는', '하며', '되며', '오며',
  '시면', '하면', '되면', '오면', '가면',
  '시고', '하고', '되고', '오고', '가고',
  '시다', '하다', '되다', '오다', '가다',
  // 지역명
  '서산', '홍성', '논산', '강릉', '김포', '김해', '안양', '안산', '공주', '전주', '문경',
  '대전', '세종', '청주', '천안', '아산', '당진', '보령', '제천', '충주', '예산', '음성',
])

// 허용되는 이름 (저자/원장)
const ALLOWED_NAMES = new Set(['문석준'])

// 이름 후보가 실명인지 검증하는 보조 함수
function isLikelyRealName(fullName: string, givenName: string, contextBefore: string): boolean {
  // 1) skipWords에 있으면 → 실명 아님
  if (REALNAME_SKIP_WORDS.has(fullName)) return false
  // 2) 허용된 이름이면 → 탐지하지 않음
  if (ALLOWED_NAMES.has(fullName)) return false
  // 3) 이미 "모"로 끝나는 익명화된 이름 → 탐지하지 않음 (정하모, 안정모, 남성모 등)
  if (givenName.endsWith('모')) return false
  // 4) 이름 2글자가 "시는", "하는" 등 동사 어미 패턴이면 → 실명 아님
  if (REALNAME_SKIP_WORDS.has(givenName)) return false
  // 5) 바로 앞에 한글이 있으면(=단어 중간) → 실명 아님 (예: "고혈압 환자")
  if (contextBefore && /[가-힣]$/.test(contextBefore)) return false
  
  return true
}

function detectRealNames(html: string): { fullName: string; surname: string; suffix: string; position: number }[] {
  const found: { fullName: string; surname: string; suffix: string; position: number }[] = []
  // HTML 태그 제거해서 순수 텍스트로 분석
  const plain = html.replace(/<[^>]*>/g, ' ')
  
  // 패턴 1: 성(1글자) + 이름(2글자) + 호칭 (씨/님) — "환자"는 오탐이 심해 제외
  const nameWithHonorific = new RegExp(`([${COMMON_SURNAMES}])([가-힣]{2})\\s*(씨|님)`, 'g')
  let match
  while ((match = nameWithHonorific.exec(plain)) !== null) {
    const surname = match[1]
    const givenName = match[2]
    const fullName = surname + givenName
    const suffix = match[3]
    const contextBefore = plain.substring(Math.max(0, match.index - 1), match.index)
    
    if (!isLikelyRealName(fullName, givenName, contextBefore)) continue
    
    found.push({ fullName, surname, suffix, position: match.index })
  }
  
  return found
}

function anonymizeRealNames(html: string): { html: string; replacements: { original: string; replacement: string; position: number }[] } {
  const replacements: { original: string; replacement: string; position: number }[] = []
  let result = html
  
  // 패턴: 호칭(씨/님) 붙은 실명만 → "X모 씨"
  const nameWithHonorific = new RegExp(`([${COMMON_SURNAMES}])([가-힣]{2})(\\s*)(씨|님)`, 'g')
  result = result.replace(nameWithHonorific, (match, surname, givenName, space, suffix, offset) => {
    const fullName = surname + givenName
    const contextBefore = result.substring(Math.max(0, offset - 1), offset)
    
    if (!isLikelyRealName(fullName, givenName, contextBefore)) return match
    
    const replacement = `${surname}모 씨`
    replacements.push({ original: match, replacement, position: offset })
    return replacement
  })
  
  return { html: result, replacements }
}

// GET /api/enhancements/scan-realnames — DB 전체 콘텐츠 실명 스캔
enhancementRoutes.get('/scan-realnames', async (c) => {
  try {
    const contents = await c.env.DB.prepare(
      `SELECT c.id, c.keyword_text as keyword, c.title, c.content_html, c.status, 
              pl.inblog_url, pl.inblog_post_id
       FROM contents c
       LEFT JOIN publish_logs pl ON pl.content_id = c.id AND pl.status = 'published'
       ORDER BY c.id ASC`
    ).all()
    
    const allResults: any[] = []
    let totalFound = 0
    
    for (const content of (contents.results || []) as any[]) {
      const html = content.content_html || ''
      const title = content.title || ''
      
      // HTML 본문 + 제목에서 실명 탐지
      const htmlNames = detectRealNames(html)
      const titleNames = detectRealNames(title)
      const allNames = [...htmlNames, ...titleNames.map(n => ({ ...n, position: -1 }))]
      
      if (allNames.length > 0) {
        totalFound += allNames.length
        allResults.push({
          content_id: content.id,
          keyword: content.keyword,
          title: content.title,
          status: content.status,
          inblog_url: content.inblog_url || null,
          inblog_post_id: content.inblog_post_id || null,
          real_names_found: allNames.map(n => ({
            name: n.fullName,
            context: n.suffix,
            in_title: n.position === -1
          })),
          count: allNames.length
        })
      }
    }
    
    return c.json({
      message: totalFound > 0 
        ? `⚠️ ${allResults.length}개 콘텐츠에서 총 ${totalFound}건의 실명이 발견되었습니다!`
        : '✅ 모든 콘텐츠에서 실명이 발견되지 않았습니다.',
      total_contents_scanned: (contents.results || []).length,
      contents_with_realnames: allResults.length,
      total_realnames_found: totalFound,
      details: allResults
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// POST /api/enhancements/fix-realnames — DB 전체 실명 익명화 처리
enhancementRoutes.post('/fix-realnames', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const dryRun = (body as any).dry_run !== false // 기본값: dry_run=true (안전모드)
    const updateInblog = (body as any).update_inblog === true // Inblog도 업데이트 여부
    const targetIds: number[] | null = (body as any).content_ids || null // 특정 ID만 처리
    
    // ★ v7.1: SQL injection 방지 — targetIds 파라미터화
    let contents: any
    if (targetIds && targetIds.length > 0) {
      const safeIds = targetIds.filter((id: number) => Number.isInteger(id) && id > 0)
      if (safeIds.length === 0) return c.json({ error: 'Invalid content_ids' }, 400)
      const ph = safeIds.map(() => '?').join(',')
      contents = await c.env.DB.prepare(
        `SELECT c.id, c.keyword_text as keyword, c.title, c.content_html, c.status,
                pl.inblog_url, pl.inblog_post_id
         FROM contents c LEFT JOIN publish_logs pl ON pl.content_id = c.id AND pl.status = 'published'
         WHERE c.id IN (${ph}) ORDER BY c.id ASC`
      ).bind(...safeIds).all()
    } else {
      contents = await c.env.DB.prepare(
        `SELECT c.id, c.keyword_text as keyword, c.title, c.content_html, c.status,
                pl.inblog_url, pl.inblog_post_id
         FROM contents c LEFT JOIN publish_logs pl ON pl.content_id = c.id AND pl.status = 'published'
         ORDER BY c.id ASC`
      ).all()
    }
    
    const results: any[] = []
    let totalFixed = 0
    let inblogUpdated = 0
    
    // Inblog API 키 (업데이트 시 필요)
    let inblogApiKey = ''
    if (updateInblog && !dryRun) {
      const keyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
      inblogApiKey = keyRow?.value as string || ''
    }
    
    for (const content of (contents.results || []) as any[]) {
      const html = content.content_html || ''
      const title = content.title || ''
      
      // 본문 익명화
      const { html: fixedHtml, replacements: htmlReplacements } = anonymizeRealNames(html)
      // 제목 익명화
      const { html: fixedTitle, replacements: titleReplacements } = anonymizeRealNames(title)
      
      const allReplacements = [
        ...htmlReplacements.map(r => ({ ...r, location: 'body' })),
        ...titleReplacements.map(r => ({ ...r, location: 'title' }))
      ]
      
      if (allReplacements.length === 0) continue
      
      totalFixed += allReplacements.length
      
      if (!dryRun) {
        // DB 업데이트
        await c.env.DB.prepare(
          `UPDATE contents SET content_html = ?, title = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(fixedHtml, fixedTitle, content.id).run()
        
        // Inblog 업데이트 (발행된 콘텐츠만)
        if (updateInblog && inblogApiKey && content.inblog_post_id) {
          try {
            const patchResp = await fetch('https://inblog.ai/api/v1/posts/' + content.inblog_post_id, {
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
                  id: String(content.inblog_post_id),
                  attributes: {
                    title: fixedTitle !== title ? fixedTitle : undefined,
                    content_html: fixedHtml
                  }
                }
              })
            })
            if (patchResp.ok) {
              inblogUpdated++
            } else {
              console.warn(`[fix-realnames] Inblog PATCH 실패 (${content.id}): ${patchResp.status}`)
            }
          } catch (inblogErr: any) {
            console.warn(`[fix-realnames] Inblog 업데이트 오류 (${content.id}):`, inblogErr.message)
          }
        }
      }
      
      results.push({
        content_id: content.id,
        keyword: content.keyword,
        title: content.title,
        status: content.status,
        inblog_url: content.inblog_url || null,
        replacements: allReplacements.map(r => ({
          original: r.original,
          replacement: r.replacement,
          location: r.location
        })),
        count: allReplacements.length
      })
    }
    
    return c.json({
      message: dryRun
        ? `🔍 미리보기: ${results.length}개 콘텐츠에서 ${totalFixed}건 익명화 예정 (dry_run=true)`
        : `✅ ${results.length}개 콘텐츠에서 ${totalFixed}건 익명화 완료${inblogUpdated > 0 ? ` (Inblog ${inblogUpdated}건 업데이트)` : ''}`,
      dry_run: dryRun,
      total_contents_fixed: results.length,
      total_replacements: totalFixed,
      inblog_updated: inblogUpdated,
      details: results,
      usage: {
        description: '실명 익명화 API 사용법',
        scan_only: 'GET /api/enhancements/scan-realnames',
        dry_run: 'POST /api/enhancements/fix-realnames (기본값: dry_run=true)',
        apply: 'POST /api/enhancements/fix-realnames { "dry_run": false }',
        apply_with_inblog: 'POST /api/enhancements/fix-realnames { "dry_run": false, "update_inblog": true }',
        specific_ids: 'POST /api/enhancements/fix-realnames { "dry_run": false, "content_ids": [1, 2, 3] }'
      }
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export { 
  enhancementRoutes, 
  generateFaqSchema, 
  generateArticleSchema, 
  injectSchemaToHtml, 
  insertInternalLinks, 
  keywordSimilarity,
  sendNotification,
  injectToc,
  injectCta,
  buildCtaHtml,
  anonymizeRealNames,
  detectRealNames
}
