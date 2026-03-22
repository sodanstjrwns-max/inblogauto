import { Hono } from 'hono'
import type { Bindings } from '../index'

const cronApp = new Hono<{ Bindings: Bindings }>()

// POST /api/cron/generate - 자동/수동 콘텐츠 생성 + 발행
cronApp.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const requestedCount = (body as any).count || 0
  const isManual = (body as any).manual || false

  // 스케줄 설정 가져오기
  const schedule: any = await c.env.DB.prepare("SELECT * FROM schedules WHERE name = 'default'").first()
  const count = requestedCount || schedule?.posts_per_day || 3
  const categoryWeights = JSON.parse(schedule?.category_weights || '{"implant":30,"orthodontics":20,"general":25,"prevention":15,"local":10}')

  // 자동 발행 설정 확인
  if (!isManual) {
    const autoRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'auto_publish'").first()
    if (autoRow?.value === 'false') {
      return c.json({ message: '자동 발행이 비활성화되어 있습니다.', results: [] })
    }
  }

  // Claude API 키 확인
  const claudeKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'claude_api_key'").first()
  const claudeApiKey = claudeKeyRow?.value as string || c.env.CLAUDE_API_KEY || ''
  if (!claudeApiKey) {
    return c.json({ error: 'Claude API 키가 설정되지 않았습니다.' }, 400)
  }

  // 키워드 자동 선택
  const totalWeight = Object.values(categoryWeights).reduce((s: number, v: any) => s + (v as number), 0)
  const keywords: any[] = []

  for (const [cat, weight] of Object.entries(categoryWeights)) {
    const catCount = Math.max(0, Math.round(count * ((weight as number) / (totalWeight as number))))
    if (catCount === 0) continue

    const results = await c.env.DB.prepare(
      `SELECT * FROM keywords 
       WHERE is_active = 1 AND category = ?
       ORDER BY used_count ASC, priority DESC, RANDOM()
       LIMIT ?`
    ).bind(cat, catCount).all()

    keywords.push(...results.results)
  }

  // 부족하면 추가
  if (keywords.length < count) {
    const excludeIds = keywords.map((k: any) => k.id).join(',') || '0'
    const extra = await c.env.DB.prepare(
      `SELECT * FROM keywords 
       WHERE is_active = 1 AND id NOT IN (${excludeIds})
       ORDER BY used_count ASC, priority DESC, RANDOM()
       LIMIT ?`
    ).bind(count - keywords.length).all()
    keywords.push(...extra.results)
  }

  const selectedKeywords = keywords.slice(0, count)
  const results: any[] = []

  // 각 키워드별 콘텐츠 생성
  for (const kw of selectedKeywords) {
    try {
      // 콘텐츠 생성 API 내부 호출
      const genResponse = await fetch(new URL('/api/contents/generate', c.req.url).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword_id: kw.id,
          keyword_text: kw.keyword
        })
      })

      // Worker 내부에서는 직접 로직 호출
      const disclaimerRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'medical_disclaimer'").first()
      const regionRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'clinic_region'").first()
      const minScoreRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'seo_min_score'").first()

      const disclaimer = disclaimerRow?.value as string || '본 콘텐츠는 일반적인 의료 정보 제공을 목적으로 작성되었습니다.'
      const region = regionRow?.value as string || ''
      const minScore = parseInt(minScoreRow?.value as string || '80')

      const generated = await generateContentDirect(claudeApiKey, kw.keyword, region, disclaimer)
      const seoScore = calculateSeoScoreDirect(generated)

      // 재생성 (점수 미달 시)
      let finalContent = generated
      let attempts = 1
      if (seoScore < minScore && attempts < 3) {
        const retry = await generateContentDirect(claudeApiKey, kw.keyword, region, disclaimer)
        const retryScore = calculateSeoScoreDirect(retry)
        if (retryScore > seoScore) {
          finalContent = retry
        }
        attempts++
      }

      const finalScore = calculateSeoScoreDirect(finalContent)

      // 썸네일
      const thumbnailUrl = `https://placehold.co/1200x630/e8f4fd/2563eb?text=${encodeURIComponent(kw.keyword)}&font=sans-serif`

      // 콘텐츠 HTML에 썸네일 삽입
      let finalHtml = finalContent.content_html
      if (thumbnailUrl) {
        finalHtml = `<figure style="margin:0 0 24px 0"><img src="${thumbnailUrl}" alt="${kw.keyword}" style="width:100%;border-radius:8px;max-height:400px;object-fit:cover" loading="lazy"><figcaption style="text-align:center;font-size:13px;color:#888;margin-top:8px">${kw.keyword} 관련 이미지</figcaption></figure>` + finalHtml
      }

      // DB 저장
      const insertResult = await c.env.DB.prepare(
        `INSERT INTO contents (keyword_id, keyword_text, title, slug, meta_description, content_html, tags, faq_json, thumbnail_url, thumbnail_prompt, seo_score, word_count, generation_attempts, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
      ).bind(
        kw.id, kw.keyword, finalContent.title, finalContent.slug,
        finalContent.meta_description, finalHtml,
        JSON.stringify(finalContent.tags), JSON.stringify(finalContent.faq),
        thumbnailUrl, '', finalScore, finalContent.word_count, attempts
      ).run()

      // 키워드 사용횟수 업데이트
      await c.env.DB.prepare(
        "UPDATE keywords SET used_count = used_count + 1, last_used_at = datetime('now') WHERE id = ?"
      ).bind(kw.id).run()

      results.push({
        content_id: insertResult.meta.last_row_id,
        keyword: kw.keyword,
        title: finalContent.title,
        seo_score: finalScore,
        status: 'draft',
        thumbnail: thumbnailUrl
      })

    } catch (e: any) {
      results.push({
        keyword: kw.keyword,
        error: e.message,
        status: 'failed'
      })
    }
  }

  return c.json({
    message: `${results.filter(r => !r.error).length}/${count}건 생성 완료`,
    results
  })
})

// ===== 직접 Claude 호출 함수 (중복이지만 cron에서 독립적으로 사용) =====
async function generateContentDirect(apiKey: string, keyword: string, region: string, disclaimer: string) {
  const systemPrompt = `당신은 치과 전문 SEO 콘텐츠 작성자입니다.

## 핵심 원칙
1. **정보 제공 전용**: 순수하게 유용한 의료 정보만 작성합니다.
2. **홍보성 문구 절대 금지**: "최고", "최첨단", "합리적인 가격", "편안한", "친절한", "믿을 수 있는", "전문적인 치료", "최신 장비" 등 홍보·광고성 표현을 일절 사용하지 않습니다.
3. **병원명 노출 금지**: 특정 병원 이름을 절대 언급하지 않습니다.
4. **의료법 준수**: 
   - 치료 효과를 보장하는 표현 금지
   - 비교 광고 금지
   - 비용 단정 금지 (범위로만 안내)
   - 의료기기·약품 특정 브랜드 추천 금지
5. **E-E-A-T 기준**: 경험, 전문성, 권위, 신뢰를 갖춘 콘텐츠를 작성합니다.

## 출력 형식 (반드시 유효한 JSON만 출력)
{
  "title": "SEO 최적화 제목 (40~65자, 키워드 포함)",
  "slug": "영문-소문자-하이픈-3-5단어",
  "meta_description": "120~160자 메타 설명",
  "content_html": "완전한 HTML 본문",
  "tags": ["태그1", "태그2", "태그3", "태그4", "태그5"],
  "faq": [{"q":"질문","a":"답변"}],
  "word_count": 숫자
}

## content_html 필수 요소
- <h2> 4개 이상, 각 섹션에 <p> 2~4개
- FAQ: <h2>자주 묻는 질문</h2> 아래 <details><summary>Q</summary><p>A</p></details> 5개+
- 하단 면책 문구: <div style="background:#f8f9fa;padding:16px;border-radius:8px;margin-top:32px;font-size:13px;color:#666;border-left:3px solid #ddd"><strong>⚕️ 의료 안내</strong><br>${disclaimer}</div>
- 1,500자 이상`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: `키워드: ${keyword}\n${region ? '지역: ' + region : ''}\n\n위 규칙에 따라 JSON만 출력하세요.` }],
      system: systemPrompt
    })
  })

  if (!response.ok) throw new Error(`Claude API ${response.status}`)

  const data: any = await response.json()
  const text = data.content?.[0]?.text || ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('JSON 파싱 실패')

  const parsed = JSON.parse(jsonMatch[0])
  return {
    title: parsed.title || keyword,
    slug: parsed.slug || keyword.replace(/\s+/g, '-'),
    meta_description: parsed.meta_description || '',
    content_html: parsed.content_html || '',
    tags: parsed.tags || [],
    faq: parsed.faq || [],
    word_count: parsed.word_count || 0
  }
}

function calculateSeoScoreDirect(content: any): number {
  let score = 0
  const title = content.title || ''
  const meta = content.meta_description || ''
  const slug = content.slug || ''
  const html = content.content_html || ''
  const tags = content.tags || []
  const faq = content.faq || []

  if (title.length >= 40 && title.length <= 65) score += 15
  else if (title.length >= 30) score += 8

  if (meta.length >= 120 && meta.length <= 160) score += 10
  else if (meta.length >= 80) score += 5

  const slugWords = slug.split('-').filter(Boolean)
  if (slugWords.length >= 3 && slugWords.length <= 5) score += 5
  else if (slug.length > 0) score += 2

  const h2Count = (html.match(/<h2/g) || []).length
  if (h2Count >= 4) score += 15
  else if (h2Count >= 2) score += 8

  if (faq.length >= 5) score += 15
  else if (faq.length >= 3) score += 8

  const plainText = html.replace(/<[^>]*>/g, '')
  if (plainText.length >= 1500) score += 15
  else if (plainText.length >= 1000) score += 8

  if (tags.length >= 4 && tags.length <= 8) score += 5
  else if (tags.length >= 2) score += 2

  if (html.includes('<ul') || html.includes('<ol')) score += 5
  if (html.includes('의료 안내') || html.includes('면책')) score += 10
  else if (html.includes('전문의')) score += 5

  const spamWords = ['최고', '최첨단', '합리적인 가격', '편안한 진료', '최신 장비']
  if (!spamWords.some(w => plainText.includes(w))) score += 5

  return Math.min(100, score)
}

const cronHandler = cronApp

export { cronHandler }
