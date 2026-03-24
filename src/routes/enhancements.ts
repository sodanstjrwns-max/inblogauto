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
  
  // 대상 콘텐츠
  let targetQuery = `SELECT c.id, c.title, c.slug, c.keyword_text, c.meta_description,
     c.content_html, c.faq_json, c.created_at, c.updated_at, c.word_count,
     c.thumbnail_url, k.category
     FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
     WHERE c.status = 'published'`
  
  if (contentIds.length > 0) {
    targetQuery += ` AND c.id IN (${contentIds.join(',')})`
  }
  
  const targets = await c.env.DB.prepare(targetQuery).all()
  
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
  
  let query = `SELECT c.id, c.content_html, c.title, c.meta_description, pl.inblog_post_id
     FROM contents c
     JOIN publish_logs pl ON c.id = pl.content_id AND pl.status = 'published'
     WHERE c.status = 'published' AND pl.inblog_post_id IS NOT NULL`
  
  if (contentIds.length > 0) {
    query += ` AND c.id IN (${contentIds.join(',')})`
  }
  
  const targets = await c.env.DB.prepare(query).all()
  
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

export { 
  enhancementRoutes, 
  generateFaqSchema, 
  generateArticleSchema, 
  injectSchemaToHtml, 
  insertInternalLinks, 
  keywordSimilarity,
  sendNotification
}
