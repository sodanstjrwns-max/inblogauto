import { Hono } from 'hono'
import type { Bindings } from '../index'

const contentRoutes = new Hono<{ Bindings: Bindings }>()

// ===== 콘텐츠 유형 자동 분류 =====
type ContentType = 'A' | 'B' | 'C' | 'D'

function classifyContentType(keyword: string, searchIntent: string): { type: ContentType; label: string; question: string } {
  const kw = keyword.toLowerCase()

  // 유형 A — 비용/가격 정보
  if (searchIntent === 'cost' || /비용|가격|얼마|보험|실비|의료비|할부|공제/.test(kw)) {
    return { type: 'A', label: '비용/가격 정보', question: `${keyword}이(가) 얼마인지, 왜 차이가 나는지 알고 싶다` }
  }

  // 유형 D — 비교/선택
  if (searchIntent === 'comparison' || /vs|비교|차이|종류별|추천|선택|어떤/.test(kw)) {
    return { type: 'D', label: '비교/선택', question: `${keyword} 중 어떤 것이 나에게 맞는지 알고 싶다` }
  }

  // 유형 C — 회복/주의사항
  if (/후|주의사항|회복|관리|음식|운동|붓기|통증|출혈|시림|부작용|증상/.test(kw)) {
    return { type: 'C', label: '회복/주의사항', question: `${keyword} 상황에서 어떻게 해야 하는지, 정상인지 불안하다` }
  }

  // 유형 B — 시술 과정/방법 (기본)
  return { type: 'B', label: '시술 과정/방법', question: `${keyword}이(가) 무엇인지, 어떻게 진행되는지 모른다` }
}

// ===== 유형별 구조 가이드 =====
function getTypeGuide(type: ContentType): string {
  const guides: Record<ContentType, string> = {
    'A': `## 유형 A — 비용/가격 정보 구조
1. 첫 단락에서 평균 가격 범위를 바로 제시 (숨기지 않음)
2. H2: 가격 차이가 나는 이유 (재료, 기술, 난이도)
3. H2: 건강보험/실손 적용 여부와 조건
4. H2: 추가 비용이 발생할 수 있는 경우
5. H2: 가격만 보고 선택하면 안 되는 이유
6. FAQ 5개+
핵심: 가격을 숨기거나 "상담 후 안내" 식으로 쓰지 않는다. 실제 범위를 명시한다.`,

    'B': `## 유형 B — 시술 과정/방법 구조
1. 첫 단락에서 이 시술이 무엇인지 1~2문장 정의
2. H2: 단계별 과정 (번호 리스트)
3. H2: 소요 시간과 내원 횟수
4. H2: 마취 여부와 실제 불편함 수준
5. H2: 이후 회복 과정과 주의사항
6. FAQ 5개+
핵심: "아프지 않습니다"보다 "어느 정도 불편함이 있을 수 있으며, 대부분 당일 귀가 가능합니다"처럼 현실적으로 쓴다.`,

    'C': `## 유형 C — 회복/주의사항 구조
1. 첫 단락에서 핵심 주의사항 요약
2. H2: 회복 타임라인 (1일차 / 3일차 / 1주차 / 2주차)
3. H2: 해야 하는 것 vs 하면 안 되는 것 (명확하게 분리)
4. H2: 이 증상은 정상 / 이 증상은 병원에 가야 함 (구체적 기준 명시)
5. H2: 장기적 관리 방법
6. FAQ 5개+
핵심: "이상하면 내원하세요"가 아니라, 구체적 기준(38도 이상 열, 3일 이상 출혈 등)을 명시한다.`,

    'D': `## 유형 D — 비교/선택 구조
1. 첫 단락에서 두 선택지의 핵심 차이를 한 줄로 정리
2. H2: 비교표(Table)로 핵심 차이 제시 — <table> 태그 사용
3. H2: 각 선택지가 적합한 케이스 (조건부 답변)
4. H2: 비용 비교
5. H2: 장기적 관점 (5~10년 후 유지, 교체 주기)
6. FAQ 5개+
핵심: "어떤 게 더 좋다"는 단정 대신 "어떤 상황에서는 A, 어떤 상황에서는 B"로 조건부 답변을 준다.`
  }
  return guides[type]
}

// ===== Claude 시스템 프롬프트 (콘텐츠 생산 지침 전면 반영) =====
function buildSystemPrompt(keyword: string, contentType: ContentType, typeGuide: string, patientQuestion: string, disclaimer: string): string {
  return `역할: 치과 의료 정보 전문 콘텐츠 작성자
목적: 환자의 실제 궁금증을 해결하는 정보성 블로그 포스트 작성

## 이 글의 존재 이유
이 포스트가 답해야 할 환자 질문: "${patientQuestion}"
이 질문이 글 전체의 나침반입니다. 이 질문에서 벗어나는 문장은 쓰지 않습니다.

## 핵심 원칙 (3줄 요약)
1. **정보만 담는다** — 병원 홍보, 자랑, 감성 없음. 환자가 궁금한 것만
2. **질문에 직접 답한다** — 읽고 나면 "아 그렇구나"가 나와야 함
3. **구글이 신뢰하는 구조로 쓴다** — E-E-A-T 기준 충족

${typeGuide}

## 제목(H1) 규칙
- 키워드를 앞쪽 30자 이내에 배치
- 숫자 또는 연도 포함 (신뢰감, CTR 향상)
- 40~65자
- "완벽 가이드", "총정리", "알아야 할 N가지" 패턴 효과적
- 예: "임플란트 비용 총정리 — 왜 병원마다 다른가 (2026년 기준)"

## 도입(첫 단락) 규칙
- 100자 이내
- 첫 문장에 키워드 포함
- 핵심 정보(수치/범위)를 바로 제시
- 공감 → 약속 구조: 이 글을 읽으면 무엇을 알 수 있는지 명시
- 나쁜 예: "안녕하세요! 오늘은 ~에 대해 알아보겠습니다"
- 좋은 예: "임플란트 비용은 재료와 기관에 따라 1개당 80만~300만 원 사이에서 형성됩니다."

## H2 작성 원칙
- 독자가 실제로 궁금해할 질문으로 작성
- 단순 분류/나열 제목은 피함
- 나쁜 H2: "임플란트 종류" → 좋은 H2: "임플란트 종류에 따라 비용이 달라지는 이유"
- 나쁜 H2: "주의사항" → 좋은 H2: "임플란트 수술 후 절대 하면 안 되는 행동 3가지"
- 각 H2 섹션: 200~350자, 수치·기간·조건 반드시 명시
- "경우에 따라 다릅니다"로 끝내지 않음 → 어떤 경우에 어떻게 다른지까지 씀

## FAQ 규칙 (필수, 5~7개)
- Q는 환자가 실제로 검색할 법한 문장으로
- A는 1~3문장, 핵심만
- "네/아니오"로 시작해서 이유 설명하는 구조가 효과적

## 톤 & 보이스
써야 하는 것:
- 수치와 기간을 명시 ("보통 2~4주", "평균 150만 원 내외", "6개월마다")
- 조건을 명시 ("65세 이상 건강보험 대상자는", "발치 후 3개월 후부터")
- 단정적 표현 ("합니다", "됩니다", "않습니다")
- 의학 용어는 괄호로 풀어씀 ("치주염(잇몸 뼈가 녹는 질환)")

절대 쓰지 않는 것:
- "저희 병원에서는..." (홍보)
- "최선을 다하겠습니다" (정보 없음)
- "경우에 따라 다릅니다" (답 안 한 것)
- "빠른 쾌유를 빕니다" (감성 불필요)
- "많은 분들이 걱정하시는" (빈말)
- "사실 이것이 중요합니다" (강조 남발)
- 병원 이름, 원장 이름, 홍보성 문구 일체
- "최고", "최첨단", "합리적인 가격", "편안한", "친절한", "전문적인 치료", "최신 장비"
- 치료 결과 보장 표현 ("100% 성공", "완벽하게 회복")
- 타 병원 비교 비방

## 키워드 밀도 원칙
주요 키워드 "${keyword}": 1,500자 기준 3~5회 자연 삽입
- 제목(H1) 1회, 첫 단락 1회, 본문 H2/H3 내 1~2회, FAQ 또는 마무리 1회
- 같은 키워드가 한 단락에 2회 이상 반복되면 안 됨
- 보조 키워드(관련 시맨틱 표현)도 3개 이상 자연 삽입

## 마무리(마지막 단락)
- 핵심 요약 1~2문장
- 다음 행동 유도 (단, 병원 예약 유도 절대 금지 — 정보 확장으로만)
- 예: "개인 구강 상태에 따라 적정 주기가 다를 수 있으므로, 정기 검진 시 치과의사에게 확인하는 것이 좋습니다."

## 의료광고법 준수 (YMYL)
- 필수 면책 문구를 반드시 글 마지막에 삽입
- 효과 보장 금지, 비교 광고 금지, 비용 단정 금지(범위로만), 브랜드 추천 금지

## 출력 형식 (반드시 유효한 JSON만 출력, 다른 텍스트 금지)
{
  "title": "SEO 최적화 제목 (40~65자, 키워드 앞 30자 이내 배치, 숫자/연도 포함)",
  "slug": "영문-소문자-하이픈-3-5단어",
  "meta_description": "120~160자 메타 설명 (키워드 포함, 핵심 정보 요약)",
  "content_html": "완전한 HTML 본문",
  "tags": ["태그1", "태그2", "태그3", "태그4", "태그5"],
  "faq": [{"q":"환자가 실제 검색할 질문","a":"1~3문장 핵심 답변"}],
  "word_count": 숫자,
  "content_type": "${contentType}"
}

## content_html 필수 구조
1. 도입부 <p> (100자 이내, 키워드 포함, 핵심 정보 즉시 제공)
2. <h2> 4~6개 (각각 독립된 환자 질문에 대한 답)
3. 각 H2 섹션 내 <p> 2~4개 (200~350자)
4. <h3> 세부 소제목 적극 활용
5. <ul>/<ol> 목록 적극 활용
6. 비교 유형 시 <table> 활용
7. FAQ: <h2>자주 묻는 질문</h2> 아래 <details><summary>Q</summary><p>A</p></details> 5~7개
8. 마무리 <p> (핵심 요약 + 정보 확장 유도)
9. 맨 하단 면책 문구: <div style="background:#f8f9fa;padding:16px;border-radius:8px;margin-top:32px;font-size:13px;color:#666;border-left:3px solid #ddd"><strong>⚕️ 의료 안내</strong><br>${disclaimer}</div>`
}

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
  const { keyword_id, keyword_text, search_intent } = body

  // Get settings
  const claudeKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'claude_api_key'").first()
  const disclaimerRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'medical_disclaimer'").first()
  const regionRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'clinic_region'").first()
  const minScoreRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'seo_min_score'").first()

  const claudeApiKey = claudeKeyRow?.value as string || c.env.CLAUDE_API_KEY || ''
  const disclaimer = disclaimerRow?.value as string || '본 글은 일반적인 의료 정보를 제공하기 위한 목적으로 작성되었습니다. 개인의 구강 상태에 따라 진단과 치료 방법이 달라질 수 있으므로, 정확한 진단과 치료 계획은 반드시 치과의사와 상담하시기 바랍니다.'
  const region = regionRow?.value as string || ''
  const minScore = parseInt(minScoreRow?.value as string || '80')

  if (!claudeApiKey) {
    return c.json({ error: 'Claude API 키가 설정되지 않았습니다. 설정 페이지에서 입력해주세요.' }, 400)
  }

  // 콘텐츠 유형 자동 분류
  const classified = classifyContentType(keyword_text, search_intent || 'info')
  const typeGuide = getTypeGuide(classified.type)

  let bestContent: any = null
  let attempts = 0
  const maxAttempts = 3

  while (attempts < maxAttempts) {
    attempts++
    try {
      const generated = await generateWithClaude(claudeApiKey, keyword_text, region, disclaimer, classified.type, typeGuide, classified.question)
      const seoScore = calculateSeoScore(generated, keyword_text)

      if (!bestContent || seoScore > (bestContent.seo_score || 0)) {
        bestContent = { ...generated, seo_score: seoScore, attempts }
      }

      if (seoScore >= minScore) break
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
    const thumbResult = await generateThumbnail(keyword_text, bestContent.title, c.env)
    thumbnailUrl = thumbResult.url
    thumbnailPrompt = thumbResult.prompt
  } catch (e) {
    console.error('Thumbnail generation failed:', e)
  }

  // 콘텐츠 HTML에 썸네일 삽입
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
    content_type: classified.type,
    content_type_label: classified.label,
    attempts: bestContent.attempts
  })
})

// ===== Claude API 호출 =====
async function generateWithClaude(
  apiKey: string, keyword: string, region: string, disclaimer: string,
  contentType: ContentType, typeGuide: string, patientQuestion: string
) {
  const systemPrompt = buildSystemPrompt(keyword, contentType, typeGuide, patientQuestion, disclaimer)

  const userPrompt = `다음 키워드로 치과 정보 블로그 포스트를 작성해주세요.

키워드: ${keyword}
콘텐츠 유형: ${contentType === 'A' ? '비용/가격 정보' : contentType === 'B' ? '시술 과정/방법' : contentType === 'C' ? '회복/주의사항' : '비교/선택'}
환자 질문: ${patientQuestion}
${region ? `참고 지역: ${region}` : ''}
연도: 2026년

위 시스템 프롬프트의 모든 규칙을 엄격히 준수하고, 반드시 유효한 JSON만 출력하세요. JSON 외 다른 텍스트는 출력하지 마세요.`

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
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt
    })
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Claude API 오류 (${response.status}): ${errText}`)
  }

  const data: any = await response.json()
  const text = data.content?.[0]?.text || ''

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Claude 응답에서 JSON을 파싱할 수 없습니다')

  const parsed = JSON.parse(jsonMatch[0])
  const contentHtml = parsed.content_html || ''
  const plainText = contentHtml.replace(/<[^>]*>/g, '')

  return {
    title: parsed.title || keyword,
    slug: parsed.slug || keyword.replace(/\s+/g, '-').toLowerCase(),
    meta_description: parsed.meta_description || '',
    content_html: contentHtml,
    tags: parsed.tags || [],
    faq: parsed.faq || [],
    word_count: plainText.length
  }
}

// ===== SEO 품질 + 의료광고법 준수 점수 (강화 버전) =====
function calculateSeoScore(content: any, keyword: string): number {
  let score = 0
  const title = content.title || ''
  const meta = content.meta_description || ''
  const slug = content.slug || ''
  const html = content.content_html || ''
  const tags = content.tags || []
  const faq = content.faq || []
  const plainText = html.replace(/<[^>]*>/g, '')

  // ===== 감점 사항 기록 =====
  const violations: string[] = []

  // ===== 1. 키워드 구조 (20점) =====
  // 제목에 키워드 포함 (7점)
  if (title.includes(keyword)) score += 7
  // 첫 단락(첫 150자)에 키워드 포함 (7점)
  const firstParagraph = plainText.substring(0, 150)
  if (firstParagraph.includes(keyword)) score += 7
  // H2에 관련 키워드 포함 — 최소 2개 H2 (6점)
  const h2Matches = html.match(/<h2[^>]*>(.*?)<\/h2>/gi) || []
  const h2WithKeyword = h2Matches.filter(h => {
    const h2Text = h.replace(/<[^>]*>/g, '')
    const kwWords = keyword.split(/\s+/)
    return kwWords.some(w => h2Text.includes(w))
  })
  if (h2WithKeyword.length >= 2) score += 6
  else if (h2WithKeyword.length >= 1) score += 3

  // ===== 2. 정보 완결성 (20점) =====
  // 수치/기간 포함 (5점)
  const hasNumbers = /\d+[\s]*(만\s*원|원|%|개월|주|일|시간|분|mm|회|개|년|cc|mg)/.test(plainText)
  if (hasNumbers) score += 5
  // FAQ 포함 (10점)
  if (faq.length >= 5) score += 10
  else if (faq.length >= 3) score += 5
  // 목록이나 표 사용 (5점)
  const hasList = html.includes('<ul') || html.includes('<ol') || html.includes('<table')
  if (hasList) score += 5

  // ===== 3. 분량 (15점) =====
  if (plainText.length >= 1500) score += 15
  else if (plainText.length >= 1200) score += 10
  else if (plainText.length >= 800) score += 5

  // ===== 4. SEO 구조 (15점) =====
  // H2 4개 이상 (8점)
  const h2Count = (html.match(/<h2/gi) || []).length
  if (h2Count >= 4) score += 8
  else if (h2Count >= 3) score += 4
  // 슬러그 형식 (4점)
  const slugWords = slug.split('-').filter(Boolean)
  if (slugWords.length >= 3 && slugWords.length <= 6 && /^[a-z0-9-]+$/.test(slug)) score += 4
  // 메타 설명 길이 (3점)
  if (meta.length >= 120 && meta.length <= 160) score += 3
  else if (meta.length >= 80 && meta.length <= 200) score += 1

  // ===== 5. 의료광고법 위반 검사 (30점 — 위반 시 감점) =====
  let medLawScore = 30

  // 5-1. 병원명/원장명 노출 금지 (-10점)
  const clinicNamePatterns = [
    '저희 병원', '우리 병원', '본원', '당원', '본 치과', '우리 치과',
    '원장님', '대표원장', '의료진 소개',
    /[가-힣]{2,4}치과/,  // "XX치과" 패턴
    /[가-힣]{2,3}원장/,  // "X원장" 패턴
  ]
  for (const pat of clinicNamePatterns) {
    if (typeof pat === 'string') {
      if (plainText.includes(pat)) { medLawScore -= 10; violations.push(`병원명/원장명 노출: "${pat}"`); break }
    } else {
      if (pat.test(plainText)) { medLawScore -= 10; violations.push(`병원명/원장명 패턴 감지`); break }
    }
  }

  // 5-2. 홍보/광고성 표현 금지 (-8점)
  const promoPatterns = [
    '최고의', '최첨단', '합리적인 가격', '편안한 진료', '친절한 상담',
    '최신 장비', '믿을 수 있는', '최선을 다', '걱정하지 마',
    '빠른 쾌유', '안심하', '특별한 혜택', '이벤트', '할인',
    '무료 상담', '무료 검진', '지금 바로', '서둘러', '한정',
    '전문적인 치료', '숙련된', '풍부한 경험', '다년간',
    '첨단 시스템', '명의', '실력 있는'
  ]
  const foundPromo = promoPatterns.filter(p => plainText.includes(p))
  if (foundPromo.length > 0) { 
    medLawScore -= Math.min(8, foundPromo.length * 3)
    violations.push(`홍보성 표현: ${foundPromo.slice(0, 3).join(', ')}`)
  }

  // 5-3. 치료 결과 보장/과장 금지 (-8점)
  const guaranteePatterns = [
    '100% 성공', '완벽하게', '완벽한 결과', '무조건', '반드시 낫',
    '확실히 효과', '보장합니다', '약속합니다', '틀림없이',
    '부작용 없', '통증 없이', '안전하게 보장', '절대 실패',
    '완전 회복', '즉각적인 효과', '영구적', '평생 사용',
    '단 한 번으로', '고통 없는'
  ]
  const foundGuarantee = guaranteePatterns.filter(p => plainText.includes(p))
  if (foundGuarantee.length > 0) {
    medLawScore -= Math.min(8, foundGuarantee.length * 4)
    violations.push(`결과 보장/과장: ${foundGuarantee.slice(0, 3).join(', ')}`)
  }

  // 5-4. 타병원 비교/비방 금지 (-4점)
  const comparisonPatterns = [
    '다른 병원보다', '타 병원', '일반 치과와 달리', '다른 곳에서는',
    '여기만', '오직 우리만', '유일하게'
  ]
  const foundComparison = comparisonPatterns.filter(p => plainText.includes(p))
  if (foundComparison.length > 0) {
    medLawScore -= 4
    violations.push(`타병원 비교: ${foundComparison.slice(0, 2).join(', ')}`)
  }

  score += Math.max(0, medLawScore)

  // ===== 6. 면책 문구 (추가 보너스, 필수) =====
  // 의료 면책 문구가 없으면 감점 (-5점)
  const hasDisclaimer = html.includes('의료 안내') && (html.includes('치과의사와 상담') || html.includes('치과 전문의') || html.includes('상담하시기 바랍니다'))
  if (hasDisclaimer) {
    // 정상 — 보너스 없음 (이미 의료법 30점에 포함)
  } else if (html.includes('의료 안내') || html.includes('면책') || html.includes('상담하시기')) {
    score -= 2 // 불완전 면책
    violations.push('면책 문구 불완전')
  } else {
    score -= 5 // 면책 문구 없음
    violations.push('면책 문구 없음')
  }

  // ===== 7. 인사말/빈말 체크 (-3점) =====
  const fluffPatterns = [
    '안녕하세요', '오늘은.*알아보겠습니다', '많은 분들이 걱정',
    '사실 이것이 중요', '경우에 따라 다릅니다', '개인차가 있습니다'
  ]
  const foundFluff = fluffPatterns.filter(p => new RegExp(p).test(plainText))
  if (foundFluff.length > 0) {
    score -= Math.min(3, foundFluff.length * 1)
    violations.push(`빈말/인사말: ${foundFluff.length}개`)
  }

  // 결과 저장 (violations는 로깅 용도)
  if (violations.length > 0) {
    console.log(`[SEO 검증] "${keyword}" 위반사항: ${violations.join(' | ')}`)
  }

  return Math.min(100, Math.max(0, score))
}

// ===== 썸네일 생성 (실제 AI 이미지 생성) =====
async function generateThumbnail(keyword: string, title: string, env?: any): Promise<{ url: string; prompt: string }> {
  const prompt = `Clean professional dental medical infographic illustration about "${keyword}". Modern minimalist flat design, soft blue (#e8f4fd) and white color palette, medical icons, no text overlay, no human faces, suitable for medical blog OG image thumbnail 1200x630.`
  
  // 폴백용 플레이스홀더
  const placeholderUrl = `https://placehold.co/1200x630/e8f4fd/2563eb?text=${encodeURIComponent(keyword)}&font=sans-serif`

  try {
    // 방법 1: Pollinations AI (무료, API 키 불필요)
    const encodedPrompt = encodeURIComponent(prompt)
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1200&height=630&model=flux&nologo=true&seed=${Date.now()}`
    
    // URL 생성만 하고 이미지 접근성 확인 (실제 이미지는 Inblog 크롤러가 가져감)
    const checkResponse = await fetch(pollinationsUrl, { method: 'HEAD', redirect: 'follow' })
    
    if (checkResponse.ok || checkResponse.status === 302 || checkResponse.status === 301) {
      return { url: pollinationsUrl, prompt }
    }
    
    // 방법 2: Workers AI 바인딩 사용 (프로덕션에서 AI 바인딩 설정 시)
    if (env?.AI) {
      try {
        const aiResult = await env.AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', {
          prompt: prompt,
          width: 1200,
          height: 630
        })
        // Workers AI는 바이너리 이미지를 반환 — R2에 업로드 필요
        if (env?.R2 && aiResult) {
          const key = `thumbnails/${Date.now()}-${keyword.replace(/\s+/g, '-').substring(0, 30)}.png`
          await env.R2.put(key, aiResult, { httpMetadata: { contentType: 'image/png' } })
          // R2 퍼블릭 URL 또는 커스텀 도메인 필요
          return { url: `/${key}`, prompt }
        }
      } catch (aiErr) {
        console.error('Workers AI 썸네일 생성 실패:', aiErr)
      }
    }

    // Pollinations URL을 직접 반환 (GET 시 이미지 생성됨)
    return { url: pollinationsUrl, prompt }
  } catch (e) {
    console.error('썸네일 생성 실패, 플레이스홀더 사용:', e)
    return { url: placeholderUrl, prompt }
  }
}

// ===== 외부에서 사용할 수 있도록 export =====
export { contentRoutes, classifyContentType, getTypeGuide, buildSystemPrompt, calculateSeoScore }
