import { Hono } from 'hono'
import type { Bindings } from '../index'

const performanceRoutes = new Hono<{ Bindings: Bindings }>()

// GET /api/performance/overview — 전체 성과 개요
performanceRoutes.get('/overview', async (c) => {
  // 콘텐츠별 최신 성과 데이터 집계
  const topPerformers = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.keyword_text, c.seo_score, c.slug, c.status,
            COALESCE(SUM(p.impressions), 0) as total_impressions,
            COALESCE(SUM(p.clicks), 0) as total_clicks,
            ROUND(COALESCE(AVG(p.avg_position), 0), 1) as avg_position,
            ROUND(CASE WHEN SUM(p.impressions) > 0 THEN SUM(p.clicks) * 100.0 / SUM(p.impressions) ELSE 0 END, 2) as ctr
     FROM contents c
     LEFT JOIN content_performance p ON c.id = p.content_id
     WHERE c.status = 'published'
     GROUP BY c.id
     ORDER BY total_clicks DESC
     LIMIT 20`
  ).all()

  // 일별 트렌드 (30일)
  const dailyTrend = await c.env.DB.prepare(
    `SELECT date, SUM(impressions) as impressions, SUM(clicks) as clicks,
            ROUND(AVG(avg_position), 1) as avg_position
     FROM content_performance
     WHERE date >= date('now', '-30 days')
     GROUP BY date ORDER BY date`
  ).all()

  // 콘텐츠 유형별 성과 비교
  const typePerformance = await c.env.DB.prepare(
    `SELECT 
       CASE 
         WHEN c.keyword_text LIKE '%비용%' OR c.keyword_text LIKE '%가격%' THEN 'A-비용'
         WHEN c.keyword_text LIKE '%후%' OR c.keyword_text LIKE '%회복%' OR c.keyword_text LIKE '%관리%' THEN 'C-회복'
         WHEN c.keyword_text LIKE '%비교%' OR c.keyword_text LIKE '%추천%' THEN 'D-비교'
         WHEN c.keyword_text LIKE '%무서%' OR c.keyword_text LIKE '%아프%' THEN 'E-불안'
         ELSE 'B-시술과정'
       END as content_type,
       COUNT(*) as cnt,
       ROUND(AVG(c.seo_score), 1) as avg_seo,
       COALESCE(SUM(p.impressions), 0) as total_impressions,
       COALESCE(SUM(p.clicks), 0) as total_clicks
     FROM contents c
     LEFT JOIN content_performance p ON c.id = p.content_id
     WHERE c.status = 'published'
     GROUP BY content_type`
  ).all()

  // 키워드 성과 (성과가 있는 것만)
  const keywordPerformance = await c.env.DB.prepare(
    `SELECT c.keyword_text, c.seo_score, c.slug,
            SUM(p.impressions) as impressions,
            SUM(p.clicks) as clicks,
            ROUND(AVG(p.avg_position), 1) as avg_position
     FROM contents c
     JOIN content_performance p ON c.id = p.content_id
     WHERE c.status = 'published'
     GROUP BY c.keyword_text
     HAVING impressions > 0
     ORDER BY impressions DESC
     LIMIT 20`
  ).all()

  return c.json({
    top_performers: topPerformers.results,
    daily_trend: dailyTrend.results,
    type_performance: typePerformance.results,
    keyword_performance: keywordPerformance.results
  })
})

// POST /api/performance/log — 수동 성과 입력 (GSC 연동 전 수동 기록용)
performanceRoutes.post('/log', async (c) => {
  const body = await c.req.json()
  const { content_id, date, impressions, clicks, avg_position } = body

  if (!content_id || !date) {
    return c.json({ error: 'content_id와 date가 필요합니다' }, 400)
  }

  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0

  await c.env.DB.prepare(
    `INSERT INTO content_performance (content_id, date, impressions, clicks, avg_position, ctr, source)
     VALUES (?, ?, ?, ?, ?, ?, 'manual')
     ON CONFLICT(content_id, date) DO UPDATE SET 
       impressions = ?, clicks = ?, avg_position = ?, ctr = ?`
  ).bind(
    content_id, date, impressions || 0, clicks || 0, avg_position || 0, ctr,
    impressions || 0, clicks || 0, avg_position || 0, ctr
  ).run()

  return c.json({ success: true })
})

// POST /api/performance/bulk — 벌크 성과 입력 (GSC API에서 받은 데이터 일괄 저장)
performanceRoutes.post('/bulk', async (c) => {
  const body = await c.req.json()
  const { entries } = body // [{ slug, date, impressions, clicks, position }]

  if (!Array.isArray(entries) || !entries.length) {
    return c.json({ error: 'entries 배열이 필요합니다' }, 400)
  }

  let saved = 0
  for (const entry of entries) {
    // slug로 content_id 찾기
    const content: any = await c.env.DB.prepare(
      "SELECT id FROM contents WHERE slug = ? LIMIT 1"
    ).bind(entry.slug).first()
    
    if (!content) continue

    const ctr = entry.impressions > 0 ? (entry.clicks / entry.impressions) * 100 : 0

    await c.env.DB.prepare(
      `INSERT INTO content_performance (content_id, date, impressions, clicks, avg_position, ctr, source)
       VALUES (?, ?, ?, ?, ?, ?, 'gsc')
       ON CONFLICT(content_id, date) DO UPDATE SET 
         impressions = ?, clicks = ?, avg_position = ?, ctr = ?`
    ).bind(
      content.id, entry.date, entry.impressions || 0, entry.clicks || 0, entry.position || 0, ctr,
      entry.impressions || 0, entry.clicks || 0, entry.position || 0, ctr
    ).run()
    saved++
  }

  return c.json({ success: true, saved, total: entries.length })
})

// GET /api/performance/suggestions — 키워드 가중치 자동 조정 제안
performanceRoutes.get('/suggestions', async (c) => {
  // 성과가 좋은 카테고리의 가중치를 높이라는 제안
  const catPerf = await c.env.DB.prepare(
    `SELECT k.category,
            COUNT(DISTINCT c.id) as posts,
            ROUND(AVG(c.seo_score), 1) as avg_seo,
            COALESCE(SUM(p.clicks), 0) as total_clicks,
            COALESCE(SUM(p.impressions), 0) as total_impressions
     FROM contents c
     JOIN keywords k ON c.keyword_id = k.id
     LEFT JOIN content_performance p ON c.id = p.content_id
     WHERE c.status = 'published'
     GROUP BY k.category
     ORDER BY total_clicks DESC`
  ).all()

  // 아직 사용 안 된 고우선순위 키워드
  const untappedKeywords = await c.env.DB.prepare(
    `SELECT keyword, category, priority, search_intent 
     FROM keywords 
     WHERE is_active = 1 AND used_count = 0 AND priority >= 80
     ORDER BY priority DESC LIMIT 10`
  ).all()

  return c.json({
    category_performance: catPerf.results,
    untapped_high_priority: untappedKeywords.results,
    recommendation: '성과 데이터가 축적되면 카테고리별 가중치 자동 조정이 가능합니다. Google Search Console 연동을 권장합니다.'
  })
})

export { performanceRoutes }
