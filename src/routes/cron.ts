import { Hono } from 'hono'
import type { Bindings } from '../index'
import { classifyContentType, getTypeGuide, buildSystemPrompt, calculateSeoScore } from './contents'
import { verifyInblogApiKey, syncTags, createInblogPost, publishInblogPost, getAuthorId } from './publish'

const cronApp = new Hono<{ Bindings: Bindings }>()

// ===== 충청권 도시 로테이션 =====
const CHUNGCHEONG_CITIES = [
  '대전', '세종', '청주', '천안', '아산',
  '서산', '당진', '논산', '공주', '보령',
  '제천', '충주', '홍성', '예산', '음성',
  '진천', '괴산', '옥천', '영동', '금산'
]

// DB에서 마지막으로 사용한 도시 인덱스를 가져와 다음 도시 반환
async function getNextRegion(db: D1Database): Promise<{ region: string; index: number }> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'region_rotation_index'").first()
  let currentIndex = parseInt(row?.value as string || '0')
  if (isNaN(currentIndex) || currentIndex >= CHUNGCHEONG_CITIES.length) currentIndex = 0
  
  const region = CHUNGCHEONG_CITIES[currentIndex]
  const nextIndex = (currentIndex + 1) % CHUNGCHEONG_CITIES.length
  
  // 다음 인덱스 저장
  if (row) {
    await db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'region_rotation_index'").bind(String(nextIndex)).run()
  } else {
    await db.prepare("INSERT INTO settings (key, value, description) VALUES ('region_rotation_index', ?, '충청권 도시 로테이션 인덱스')").bind(String(nextIndex)).run()
  }
  
  return { region, index: currentIndex }
}

// POST /api/cron/generate - 자동/수동 콘텐츠 생성 + 선택적 자동 발행
cronApp.post('/', async (c) => {
  try {
  const body = await c.req.json().catch(() => ({}))
  const requestedCount = (body as any).count || 0
  const isManual = (body as any).manual || false
  const autoPublishOverride = (body as any).auto_publish // true/false 직접 지정

  // 스케줄 설정
  const schedule: any = await c.env.DB.prepare("SELECT * FROM schedules WHERE name = 'default'").first()
  const count = requestedCount || schedule?.posts_per_day || 5
  const categoryWeights = JSON.parse(schedule?.category_weights || '{"implant":30,"orthodontics":25,"general":25,"prevention":15,"local":5}')

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

  // 설정값 로드
  const disclaimerRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'medical_disclaimer'").first()
  const regionRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'clinic_region'").first()
  const minScoreRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'seo_min_score'").first()
  const autoPublishRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'auto_publish'").first()
  const inblogKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()

  const disclaimer = disclaimerRow?.value as string || '본 글은 일반적인 의료 정보를 제공하기 위한 목적으로 작성되었습니다. 개인의 구강 상태에 따라 진단과 치료 방법이 달라질 수 있으므로, 정확한 진단과 치료 계획은 반드시 치과의사와 상담하시기 바랍니다.'
  const regionSetting = regionRow?.value as string || '' // settings에서 고정 지역 (비어있으면 로테이션 사용)
  const minScore = parseInt(minScoreRow?.value as string || '80')
  const shouldAutoPublish = autoPublishOverride !== undefined
    ? autoPublishOverride
    : (autoPublishRow?.value === 'true')
  const inblogApiKey = inblogKeyRow?.value as string || c.env.INBLOG_API_KEY || ''

  // 키워드 자동 선택 (카테고리 가중치 기반)
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

  // Inblog API 정보 사전 검증 (자동 발행 시)
  let inblogApiInfo: any = null
  if (shouldAutoPublish && inblogApiKey) {
    try {
      inblogApiInfo = await verifyInblogApiKey(inblogApiKey)
    } catch (e: any) {
      console.error('Inblog API 키 검증 실패:', e.message)
    }
  }

  // 각 키워드별 콘텐츠 생성
  for (const kw of selectedKeywords) {
    try {
      // 콘텐츠 유형 자동 분류
      const classified = classifyContentType(kw.keyword, kw.search_intent || 'info')
      const typeGuide = getTypeGuide(classified.type)

      // 충청권 도시 로테이션 — 매 콘텐츠마다 다른 도시
      const regionInfo = regionSetting 
        ? { region: regionSetting, index: -1 }  // settings에 고정 지역이 있으면 그걸 사용
        : await getNextRegion(c.env.DB)          // 없으면 충청권 로테이션
      const region = regionInfo.region

      // Claude API 호출 (최대 3회 시도)
      let bestContent: any = null
      let attempts = 0
      const maxAttempts = 3

      while (attempts < maxAttempts) {
        attempts++
        try {
          const generated = await callClaude(
            claudeApiKey, kw.keyword, region, disclaimer,
            classified.type, typeGuide, classified.question, classified.emotion
          )
          const seoScore = calculateSeoScore(generated, kw.keyword)

          if (!bestContent || seoScore > (bestContent.seo_score || 0)) {
            bestContent = { ...generated, seo_score: seoScore, attempts }
          }
          if (seoScore >= minScore) break
        } catch (e: any) {
          if (attempts >= maxAttempts) throw e
        }
      }

      if (!bestContent) throw new Error('콘텐츠 생성 실패')

      // === 1단계: 콘텐츠를 먼저 DB에 저장 (이미지 없이) ===
      let finalHtml = bestContent.content_html
      
      const insertResult = await c.env.DB.prepare(
        `INSERT INTO contents (keyword_id, keyword_text, title, slug, meta_description, content_html, tags, faq_json, thumbnail_url, thumbnail_prompt, seo_score, word_count, generation_attempts, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, 'draft')`
      ).bind(
        kw.id, kw.keyword, bestContent.title, bestContent.slug,
        bestContent.meta_description, finalHtml,
        JSON.stringify(bestContent.tags), JSON.stringify(bestContent.faq),
        bestContent.seo_score, bestContent.word_count, bestContent.attempts
      ).run()

      const contentId = insertResult.meta.last_row_id as number

      // === 2단계: AI 이미지 생성 (contentId로 D1에 저장) ===
      let thumbnailUrl = ''
      let infoImageUrl = ''
      let infoCaption = ''
      
      try {
        const thumbResult = await generateAIImage(
          c.env, kw.keyword, kw.category || 'general', 'thumbnail', classified.type, contentId
        )
        thumbnailUrl = thumbResult.url
        
        const infoResult = await generateAIImage(
          c.env, kw.keyword, kw.category || 'general', 'illustration', classified.type, contentId
        )
        infoImageUrl = infoResult.url
        infoCaption = infoResult.caption
      } catch (imgErr: any) {
        console.error('이미지 생성 실패, 폴백 사용:', imgErr.message)
        thumbnailUrl = `https://placehold.co/1200x630/e8f4fd/2563eb?text=${encodeURIComponent(kw.keyword)}&font=sans-serif`
        infoImageUrl = thumbnailUrl
        infoCaption = '▲ 참고 이미지'
      }

      // === 3단계: 이미지 URL을 HTML에 삽입하고 DB 업데이트 ===
      // 본문 첫 번째 H2 섹션 뒤에 인포그래픽 삽입
      const firstH2End = finalHtml.indexOf('</h2>')
      if (firstH2End !== -1) {
        const afterFirstH2 = finalHtml.indexOf('<h2', firstH2End + 5)
        if (afterFirstH2 !== -1) {
          const infographicHtml = `<figure style="margin:32px 0;text-align:center"><img src="${infoImageUrl}" alt="${kw.keyword} 관련 이미지" style="width:100%;max-width:800px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.08)" loading="lazy"><figcaption style="text-align:center;font-size:13px;color:#888;margin-top:10px">${infoCaption}</figcaption></figure>`
          finalHtml = finalHtml.slice(0, afterFirstH2) + infographicHtml + finalHtml.slice(afterFirstH2)
        }
      }

      // 상단 썸네일
      finalHtml = `<figure style="margin:0 0 24px 0"><img src="${thumbnailUrl}" alt="${kw.keyword}" style="width:100%;border-radius:8px;max-height:400px;object-fit:cover" loading="lazy"></figure>` + finalHtml

      // DB 업데이트 (이미지 URL 포함된 최종 HTML)
      await c.env.DB.prepare(
        `UPDATE contents SET content_html = ?, thumbnail_url = ? WHERE id = ?`
      ).bind(finalHtml, thumbnailUrl, contentId).run()

      // 키워드 사용횟수 업데이트
      await c.env.DB.prepare(
        "UPDATE keywords SET used_count = used_count + 1, last_used_at = datetime('now') WHERE id = ?"
      ).bind(kw.id).run()

      // === 자동 발행 ===
      let publishStatus = 'draft'
      let inblogUrl = ''
      let inblogPostId = ''

      if (shouldAutoPublish && inblogApiKey && inblogApiInfo) {
        try {
          // 태그 동기화
          const syncedTags = await syncTags(inblogApiKey, bestContent.tags || [])
          const tagIds = syncedTags.map((t: any) => t.id)

          // 작성자 ID 가져오기 ("대표원장 문석준")
          const authorId = await getAuthorId(inblogApiKey)

          // Inblog에 포스트 생성 — 작성자 포함
          const createResult = await createInblogPost(inblogApiKey, {
            title: bestContent.title,
            slug: bestContent.slug,
            description: bestContent.meta_description,
            content_html: finalHtml,
            meta_description: bestContent.meta_description,
            image: thumbnailUrl
          }, tagIds, authorId)

          inblogPostId = createResult.id

          // 즉시 발행
          await publishInblogPost(inblogApiKey, inblogPostId, 'publish')

          inblogUrl = `https://${inblogApiInfo.subdomain}.inblog.ai/${bestContent.slug}`
          publishStatus = 'published'

          // 발행 로그 기록
          await c.env.DB.prepare(
            `INSERT INTO publish_logs (content_id, inblog_post_id, inblog_url, status, scheduled_at, published_at)
             VALUES (?, ?, ?, 'published', datetime('now'), datetime('now'))`
          ).bind(contentId, inblogPostId, inblogUrl).run()

          // 콘텐츠 상태 업데이트
          await c.env.DB.prepare(
            `UPDATE contents SET status = 'published', updated_at = datetime('now') WHERE id = ?`
          ).bind(contentId).run()

        } catch (pubErr: any) {
          console.error(`자동 발행 실패 (${kw.keyword}):`, pubErr.message)
          // 발행 실패해도 콘텐츠 생성은 성공으로 기록
          await c.env.DB.prepare(
            `INSERT INTO publish_logs (content_id, status, error_message, scheduled_at)
             VALUES (?, 'failed', ?, datetime('now'))`
          ).bind(contentId, pubErr.message).run()
        }
      }

      results.push({
        content_id: contentId,
        keyword: kw.keyword,
        title: bestContent.title,
        seo_score: bestContent.seo_score,
        content_type: classified.type,
        content_type_label: classified.label,
        region: region,
        status: publishStatus,
        inblog_url: inblogUrl || null,
        inblog_post_id: inblogPostId || null,
        thumbnail: thumbnailUrl
      })
    } catch (e: any) {
      results.push({ keyword: kw.keyword, error: e.message, status: 'failed' })
    }
  }

  const successCount = results.filter(r => !r.error).length
  const publishedCount = results.filter(r => r.status === 'published').length

  return c.json({
    message: `${successCount}/${count}건 생성, ${publishedCount}건 자동 발행 완료`,
    auto_publish: shouldAutoPublish,
    results
  })
  } catch (outerErr: any) {
    return c.json({ error: 'Cron 라우트 오류: ' + (outerErr?.message || String(outerErr)), stack: outerErr?.stack?.substring(0, 500) }, 500)
  }
})

// ===== Claude API 호출 (환자 공감형 v2) =====
async function callClaude(
  apiKey: string, keyword: string, region: string, disclaimer: string,
  contentType: string, typeGuide: string, patientQuestion: string, emotion?: string
) {
  const systemPrompt = buildSystemPrompt(keyword, contentType as any, typeGuide, patientQuestion, disclaimer, emotion)

  const userPrompt = `키워드: ${keyword}
콘텐츠 유형: ${contentType === 'A' ? '비용/가격 정보' : contentType === 'B' ? '시술 과정/방법' : contentType === 'C' ? '회복/주의사항' : contentType === 'D' ? '비교/선택' : '불안/공포 해소'}
환자의 감정: ${emotion || '불안·걱정'}
환자가 검색하게 된 마음: ${patientQuestion}
${region ? `지역: ${region}
- 본문 중 1~2곳에 "${region} 지역", "${region}에서" 등 자연스럽게 지역명 언급
- 제목이나 메타 디스크립션에도 "${region}" 포함 권장
- slug에 지역 영문명 포함 (예: daejeon, cheongju, sejong 등)
- 지역 주민이 읽는다고 생각하고, 해당 지역 환자가 공감할 수 있는 표현 사용` : ''}
연도: 2026년

핵심 방향:
- 환자의 불안과 걱정을 먼저 인정하고, 구체적 정보로 해소하세요
- 비용이나 가격 정보보다 실제 치료 과정, 통증, 회복에 집중하세요
- 환자가 읽고 나서 "이 정도면 괜찮겠다"라고 느낄 수 있어야 합니다
- "치과에서 이렇게 질문해보세요" 같은 임파워먼트 문장을 포함하세요

위 규칙에 따라 유효한 JSON만 출력하세요.`

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

  if (!response.ok) throw new Error(`Claude API ${response.status}`)

  const data: any = await response.json()
  const text = data.content?.[0]?.text || ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('JSON 파싱 실패')

  const parsed = JSON.parse(jsonMatch[0])
  const contentHtml = parsed.content_html || ''
  const plainText = contentHtml.replace(/<[^>]*>/g, '')

  return {
    title: parsed.title || keyword,
    slug: parsed.slug || keyword.replace(/\s+/g, '-'),
    meta_description: parsed.meta_description || '',
    content_html: contentHtml,
    tags: parsed.tags || [],
    faq: parsed.faq || [],
    word_count: plainText.length
  }
}

const cronHandler = cronApp

// ===== AI 이미지 생성 시스템 (키워드별 고유 이미지) =====

// 콘텐츠 유형별 이미지 프롬프트 템플릿
function buildImagePrompt(keyword: string, category: string, purpose: 'thumbnail' | 'illustration', contentType: string): string {
  const noText = 'absolutely no text, no letters, no words, no numbers, no labels, no captions, no watermarks anywhere in the image'
  const baseStyle = `Clean modern medical illustration, soft pastel colors, light blue and white palette, minimalist flat design, ${noText}, no human faces, no logos, professional healthcare aesthetic`
  
  // 카테고리별 핵심 시각 요소
  const categoryVisuals: Record<string, string> = {
    implant: 'dental implant cross-section diagram, jaw bone structure, titanium screw and crown, gum tissue',
    orthodontics: 'teeth with clear aligners, beautiful smile, orthodontic treatment concept',
    general: 'healthy white tooth, dental mirror, clean oral care scene',
    prevention: 'toothbrush and toothpaste, dental floss, protective shield around tooth',
    local: 'modern dental clinic interior, comfortable dental chair, welcoming atmosphere',
  }
  
  // 콘텐츠 유형별 분위기
  const typeMood: Record<string, string> = {
    A: 'clean simple composition, trustworthy professional feeling',
    B: 'gentle procedural scene, calming medical environment, dental tools arranged neatly',
    C: 'soothing recovery atmosphere, gentle warm colors, peaceful healing vibe',
    D: 'balanced symmetrical composition, clean comparison visual',
    E: 'calming reassuring atmosphere, warm soft lighting, peaceful comforting scene',
  }
  
  const visual = categoryVisuals[category] || categoryVisuals.general
  const mood = typeMood[contentType] || typeMood.B
  
  if (purpose === 'thumbnail') {
    return `${baseStyle}, ${visual}, centered composition, simple clean background, blog hero image, ${mood}`
  } else {
    return `${baseStyle}, ${visual}, ${mood}, detailed realistic medical illustration, soft shadows, clean white background`
  }
}

// 이미지 캡션 생성
function getImageCaption(contentType: string, keyword: string): string {
  return `▲ ${keyword} 관련 이미지`
}

// 이미지를 D1에 Base64 TEXT로 저장하고 자체 URL 반환
async function saveImageToD1(
  env: any, contentId: number, keyword: string, imageType: string, prompt: string, base64Data: string
): Promise<string> {
  // Base64 문자열을 TEXT로 저장 (D1 BLOB 호환성 문제 회피)
  await env.DB.prepare(
    `INSERT OR REPLACE INTO generated_images (content_id, keyword, image_type, prompt, image_data, mime_type)
     VALUES (?, ?, ?, ?, ?, 'image/jpeg')`
  ).bind(contentId, keyword, imageType, prompt, base64Data).run()
  
  // 자체 서빙 URL 반환
  return `https://inblogauto.pages.dev/api/image/${contentId}/${imageType}.jpg`
}

// 메인 이미지 생성 함수
async function generateAIImage(
  env: any, keyword: string, category: string, purpose: 'thumbnail' | 'illustration', contentType: string,
  contentId?: number
): Promise<{ url: string; caption: string }> {
  const prompt = buildImagePrompt(keyword, category, purpose, contentType)
  const caption = purpose === 'illustration' ? getImageCaption(contentType, keyword) : ''
  
  // 방법 1: Cloudflare Workers AI (바인딩 사용)
  if (env?.AI) {
    try {
      const aiResult = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
        prompt: prompt,
        num_steps: 4,
      })
      
      // flux-1-schnell은 { image: Base64String } 형태로 반환
      const raw = aiResult?.image ?? aiResult
      
      if (raw && typeof raw === 'string' && raw.length > 1000) {
        console.log(`[이미지] Workers AI 생성 성공: ${keyword} (${purpose}), base64 len=${raw.length}`)
        
        // contentId가 있으면 D1에 Base64 문자열로 저장하고 자체 URL 반환
        if (contentId) {
          const url = await saveImageToD1(env, contentId, keyword, purpose, prompt, raw)
          return { url, caption }
        }
        
        // contentId 없으면 data URI로 반환
        return { url: `data:image/jpeg;base64,${raw}`, caption }
      }
    } catch (aiErr: any) {
      console.error('Workers AI 이미지 생성 실패:', aiErr.message)
    }
  }
  
  // 방법 2: 플레이스홀더 폴백 (키워드 기반 고유 이미지)
  // 매 키워드마다 다른 색상+텍스트로 최소한의 차별화
  const colors = ['4A90D9', '5B8C5A', '8B5CF6', 'D97706', 'DC2626', '0891B2', '7C3AED', '059669']
  const colorIdx = Math.abs(hashString(keyword + purpose)) % colors.length
  const bg = colors[colorIdx]
  const fallbackUrl = `https://placehold.co/1200x630/${bg}/ffffff?text=${encodeURIComponent(keyword)}&font=sans-serif`
  console.log(`[이미지] 폴백 사용: ${keyword} (${purpose})`)
  return { url: fallbackUrl, caption }
}

// 문자열 해시 (시드 생성용)
function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return hash
}

export { cronHandler }
