import { Hono } from 'hono'
import type { Bindings } from '../index'

const contentRoutes = new Hono<{ Bindings: Bindings }>()

// GET /api/contents - 콘텐츠 목록 조회
contentRoutes.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')
  const status = c.req.query('status') || ''

  let query = 'SELECT * FROM contents WHERE 1=1'
  const params: any[] = []

  if (status) {
    query += ' AND status = ?'
    params.push(status)
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const result = await c.env.DB.prepare(query).bind(...params).all()
  return c.json({ contents: result.results })
})

// GET /api/contents/:id - 콘텐츠 상세 조회
contentRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const result = await c.env.DB.prepare('SELECT * FROM contents WHERE id = ?').bind(id).first()
  if (!result) return c.json({ error: '콘텐츠를 찾을 수 없습니다' }, 404)
  return c.json({ content: result })
})

// POST /api/contents/generate - AI 콘텐츠 생성
contentRoutes.post('/generate', async (c) => {
  const body = await c.req.json()
  const { keyword_id, keyword_text } = body

  // Get settings
  const claudeKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'claude_api_key'").first()
  const disclaimerRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'medical_disclaimer'").first()
  const regionRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'clinic_region'").first()
  const minScoreRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'seo_min_score'").first()

  const claudeApiKey = claudeKeyRow?.value as string || c.env.CLAUDE_API_KEY || ''
  const disclaimer = disclaimerRow?.value as string || '본 콘텐츠는 일반적인 의료 정보 제공을 목적으로 작성되었으며, 특정 질환의 진단이나 치료를 대체하지 않습니다. 정확한 진단과 치료를 위해 반드시 치과 전문의와 상담하시기 바랍니다.'
  const region = regionRow?.value as string || ''
  const minScore = parseInt(minScoreRow?.value as string || '80')

  if (!claudeApiKey) {
    return c.json({ error: 'Claude API 키가 설정되지 않았습니다. 설정 페이지에서 입력해주세요.' }, 400)
  }

  let bestContent: any = null
  let attempts = 0
  const maxAttempts = 3

  while (attempts < maxAttempts) {
    attempts++
    try {
      const generated = await generateWithClaude(claudeApiKey, keyword_text, region, disclaimer)
      const seoScore = calculateSeoScore(generated)

      if (seoScore >= minScore || attempts >= maxAttempts) {
        bestContent = { ...generated, seo_score: seoScore, attempts }
        break
      }
    } catch (e: any) {
      if (attempts >= maxAttempts) {
        return c.json({ error: 'AI 생성 실패: ' + e.message }, 500)
      }
    }
  }

  if (!bestContent) {
    return c.json({ error: 'AI 콘텐츠 생성에 실패했습니다' }, 500)
  }

  // Generate thumbnail
  let thumbnailUrl = ''
  let thumbnailPrompt = ''
  try {
    const thumbResult = await generateThumbnail(keyword_text, bestContent.title)
    thumbnailUrl = thumbResult.url
    thumbnailPrompt = thumbResult.prompt
  } catch (e) {
    // 썸네일 실패해도 콘텐츠는 저장
    console.error('Thumbnail generation failed:', e)
  }

  // 콘텐츠 HTML에 썸네일 삽입 (맨 앞)
  let finalHtml = bestContent.content_html
  if (thumbnailUrl) {
    finalHtml = `<figure style="margin:0 0 24px 0"><img src="${thumbnailUrl}" alt="${keyword_text}" style="width:100%;border-radius:8px;max-height:400px;object-fit:cover" loading="lazy"><figcaption style="text-align:center;font-size:13px;color:#888;margin-top:8px">${keyword_text} 관련 이미지</figcaption></figure>` + finalHtml
  }

  // Save to DB
  const result = await c.env.DB.prepare(
    `INSERT INTO contents (keyword_id, keyword_text, title, slug, meta_description, content_html, tags, faq_json, thumbnail_url, thumbnail_prompt, seo_score, word_count, generation_attempts, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
  ).bind(
    keyword_id || 0,
    keyword_text,
    bestContent.title,
    bestContent.slug,
    bestContent.meta_description,
    finalHtml,
    JSON.stringify(bestContent.tags),
    JSON.stringify(bestContent.faq),
    thumbnailUrl,
    thumbnailPrompt,
    bestContent.seo_score,
    bestContent.word_count,
    bestContent.attempts
  ).run()

  // 키워드 사용횟수 업데이트
  if (keyword_id) {
    await c.env.DB.prepare(
      "UPDATE keywords SET used_count = used_count + 1, last_used_at = datetime('now') WHERE id = ?"
    ).bind(keyword_id).run()
  }

  return c.json({
    id: result.meta.last_row_id,
    title: bestContent.title,
    seo_score: bestContent.seo_score,
    word_count: bestContent.word_count,
    thumbnail_url: thumbnailUrl,
    attempts: bestContent.attempts
  })
})

// ===== Claude API 호출 =====
async function generateWithClaude(apiKey: string, keyword: string, region: string, disclaimer: string) {
  const systemPrompt = `당신은 치과 전문 SEO 콘텐츠 작성자입니다.

## 핵심 원칙
1. **정보 제공 전용**: 순수하게 유용한 의료 정보만 작성합니다.
2. **홍보성 문구 절대 금지**: "최고", "최첨단", "합리적인 가격", "편안한", "친절한", "믿을 수 있는", "전문적인 치료", "최신 장비" 등 홍보·광고성 표현을 일절 사용하지 않습니다.
3. **병원명 노출 금지**: 특정 병원 이름을 절대 언급하지 않습니다. 이 콘텐츠는 일반 정보 글입니다.
4. **의료법 준수**: 
   - 치료 효과를 보장하는 표현 금지 (예: "완벽하게 회복", "100% 성공")
   - 비교 광고 금지 (예: "타 치과보다 우수")
   - 환자 경험담·후기 조작 금지
   - 비용 단정 금지 (범위로만 안내, "정확한 비용은 진료 후 결정")
   - 의료기기·약품 특정 브랜드 추천 금지
5. **E-E-A-T 기준**: 경험, 전문성, 권위, 신뢰를 갖춘 콘텐츠를 작성합니다.
6. **자연스러운 문체**: 환자가 궁금해할 내용을 친절하지만 과장 없이 설명합니다.

## 출력 형식 (반드시 JSON)
{
  "title": "SEO 최적화 제목 (40~65자, 키워드 포함)",
  "slug": "영문-소문자-하이픈-3-5단어",
  "meta_description": "120~160자 메타 설명",
  "content_html": "완전한 HTML (h2 4개+, 본문 1500자+, FAQ 5개+ 포함)",
  "tags": ["태그1", "태그2", "태그3", "태그4", "태그5"],
  "faq": [{"q": "질문", "a": "답변"}, ...],
  "word_count": 숫자
}

## content_html 구조 필수 요소
- <h2> 소제목 4개 이상
- 각 섹션에 <p> 2~4개 단락
- <h3> 세부 소제목 활용
- <ul>/<ol> 목록 적극 활용
- FAQ 섹션: <h2>자주 묻는 질문</h2> 아래 <details><summary>질문</summary><p>답변</p></details> 형태 5개 이상
- 하단에 의료 면책 문구 삽입: <div style="background:#f8f9fa;padding:16px;border-radius:8px;margin-top:32px;font-size:13px;color:#666;border-left:3px solid #ddd"><strong>⚕️ 의료 안내</strong><br>${disclaimer}</div>
- 보조 키워드 3개 이상 자연 삽입
- 본문 1,500자 이상`

  const userPrompt = `다음 키워드로 치과 정보 블로그 포스트를 작성해주세요.

키워드: ${keyword}
${region ? `참고 지역: ${region}` : ''}

위 시스템 프롬프트의 규칙을 엄격히 준수하고, 반드시 JSON 형식으로만 응답해주세요.`

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
      messages: [
        { role: 'user', content: userPrompt }
      ],
      system: systemPrompt
    })
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Claude API 오류 (${response.status}): ${errText}`)
  }

  const data: any = await response.json()
  const text = data.content?.[0]?.text || ''

  // Parse JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Claude 응답에서 JSON을 파싱할 수 없습니다')

  const parsed = JSON.parse(jsonMatch[0])
  return {
    title: parsed.title || keyword,
    slug: parsed.slug || keyword.replace(/\s+/g, '-').toLowerCase(),
    meta_description: parsed.meta_description || '',
    content_html: parsed.content_html || '',
    tags: parsed.tags || [],
    faq: parsed.faq || [],
    word_count: parsed.word_count || (parsed.content_html || '').replace(/<[^>]*>/g, '').length
  }
}

// ===== SEO 점수 계산 =====
function calculateSeoScore(content: any): number {
  let score = 0
  const title = content.title || ''
  const meta = content.meta_description || ''
  const slug = content.slug || ''
  const html = content.content_html || ''
  const tags = content.tags || []
  const faq = content.faq || []
  const plainText = html.replace(/<[^>]*>/g, '')

  // 1. 제목 길이 (40~65자) - 15점
  if (title.length >= 40 && title.length <= 65) score += 15
  else if (title.length >= 30 && title.length <= 80) score += 8

  // 2. 메타 설명 (120~160자) - 10점
  if (meta.length >= 120 && meta.length <= 160) score += 10
  else if (meta.length >= 80 && meta.length <= 200) score += 5

  // 3. URL 슬러그 (영문 3~5단어) - 5점
  const slugWords = slug.split('-').filter(Boolean)
  if (slugWords.length >= 3 && slugWords.length <= 5 && /^[a-z0-9-]+$/.test(slug)) score += 5
  else if (slug.length > 0) score += 2

  // 4. H2 소제목 4개+ - 15점
  const h2Count = (html.match(/<h2/g) || []).length
  if (h2Count >= 4) score += 15
  else if (h2Count >= 2) score += 8

  // 5. FAQ 5개+ - 15점
  if (faq.length >= 5) score += 15
  else if (faq.length >= 3) score += 8

  // 6. 본문 1500자+ - 15점
  if (plainText.length >= 1500) score += 15
  else if (plainText.length >= 1000) score += 8

  // 7. 태그 4~8개 - 5점
  if (tags.length >= 4 && tags.length <= 8) score += 5
  else if (tags.length >= 2) score += 2

  // 8. 목록 사용 - 5점
  if (html.includes('<ul') || html.includes('<ol')) score += 5

  // 9. 면책 문구 포함 - 10점
  if (html.includes('의료 안내') || html.includes('면책')) score += 10
  else if (html.includes('전문의') || html.includes('상담')) score += 5

  // 10. 홍보성 문구 없음 체크 - 5점 (감점 방식)
  const spamWords = ['최고', '최첨단', '합리적인 가격', '편안한 진료', '친절한 상담', '최신 장비', '믿을 수 있는']
  const hasSpam = spamWords.some(w => plainText.includes(w))
  if (!hasSpam) score += 5

  return Math.min(100, score)
}

// ===== 썸네일 생성 =====
async function generateThumbnail(keyword: string, title: string): Promise<{ url: string; prompt: string }> {
  // Placeholder 썸네일 생성 (실제 구현 시 Cloudflare AI 또는 외부 API 사용)
  const prompt = `Clean, professional dental medical illustration for: ${keyword}. Modern minimalist style, soft blue and white color palette, no text overlay, suitable for a medical blog thumbnail.`

  // 기본 placeholder - 실제 운영 시 이미지 생성 API로 교체
  const placeholderUrl = `https://placehold.co/1200x630/e8f4fd/2563eb?text=${encodeURIComponent(keyword)}&font=sans-serif`

  return { url: placeholderUrl, prompt }
}

export { contentRoutes }
