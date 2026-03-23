import { Hono } from 'hono'
import type { Bindings } from '../index'
import { classifyContentType, getTypeGuide, buildSystemPrompt, calculateSeoScore } from './contents'
import { verifyInblogApiKey, syncTags, createInblogPost, publishInblogPost, getAuthorId } from './publish'
import { injectSchemaToHtml, insertInternalLinks, sendNotification } from './enhancements'
import { autoReplenishKeywords } from './keyword-discovery'

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

// ===== 콘텐츠 유형 로테이션 (균등 배분 - 비용/가격 제외) =====
const CONTENT_TYPE_ROTATION: Array<'B' | 'C' | 'D' | 'E' | 'F'> = ['B', 'C', 'E', 'D', 'F', 'B', 'E', 'C', 'F', 'B']

async function getNextContentType(db: D1Database): Promise<{ type: 'B' | 'C' | 'D' | 'E' | 'F'; index: number }> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'content_type_rotation_index'").first()
  let currentIndex = parseInt(row?.value as string || '0')
  if (isNaN(currentIndex) || currentIndex >= CONTENT_TYPE_ROTATION.length) currentIndex = 0
  
  const type = CONTENT_TYPE_ROTATION[currentIndex]
  const nextIndex = (currentIndex + 1) % CONTENT_TYPE_ROTATION.length
  
  if (row) {
    await db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'content_type_rotation_index'").bind(String(nextIndex)).run()
  } else {
    await db.prepare("INSERT INTO settings (key, value, description) VALUES ('content_type_rotation_index', ?, '콘텐츠 유형 로테이션 인덱스')").bind(String(nextIndex)).run()
  }
  
  return { type, index: currentIndex }
}

// ===== 내부 링크용 기존 발행글 조회 =====
async function getPublishedPosts(db: D1Database, excludeKeyword?: string): Promise<{ title: string; slug: string; keyword: string; category: string }[]> {
  const rows = await db.prepare(
    `SELECT title, slug, keyword_text as keyword, k.category 
     FROM contents c LEFT JOIN keywords k ON c.keyword_id = k.id
     WHERE c.status = 'published' 
     ORDER BY c.created_at DESC LIMIT 30`
  ).all()
  return (rows.results || []).map((r: any) => ({
    title: r.title,
    slug: r.slug,
    keyword: r.keyword,
    category: r.category || 'general'
  }))
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
  const postsPerDay = schedule?.posts_per_day || 5
  
  // ===== 새벽 한방 발행 전략 =====
  // Cloudflare Cron Trigger가 새벽(KST 02:00~05:30)에 5번 호출
  // 각 호출 시 1건씩 생성+발행 → Workers 타임아웃 걱정 없음
  // 수동 호출 시에는 지정 건수 사용
  let count: number
  if (requestedCount > 0) {
    count = requestedCount // 수동: 지정 건수
  } else if (!isManual) {
    // Cron 자동 호출: 항상 1건씩 (타임아웃 안전)
    // 하루 총 발행 수는 cron 호출 횟수(5회)로 제어
    count = 1
  } else {
    count = postsPerDay // 슬롯 미지정 수동: 전체
  }
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

  // ===== 키워드 자동 보충 (매일 Cron 실행 시 잔여량 체크) =====
  let replenishResult: any = null
  try {
    replenishResult = await autoReplenishKeywords(c.env.DB, {
      postsPerDay: postsPerDay,
      thresholdDays: 30,  // 30일 미만이면 보충
      targetDays: 90      // 90일분(450개)까지 채움
    })
    if (replenishResult.triggered) {
      console.log(`[키워드 자동 보충] ${replenishResult.saved}개 추가 (${replenishResult.reason})`)
    }
  } catch (e: any) {
    console.error('[키워드 자동 보충 실패]', e.message)
  }

  // ===== 중복 키워드 방지: 이미 콘텐츠가 있는 키워드 ID 수집 =====
  const usedKeywordRows = await c.env.DB.prepare(
    "SELECT DISTINCT keyword_id FROM contents WHERE keyword_id IS NOT NULL"
  ).all()
  const usedKeywordIds = new Set((usedKeywordRows.results || []).map((r: any) => r.keyword_id))

  // 키워드 자동 선택 (카테고리 가중치 기반 + 중복 제외)
  const totalWeight = Object.values(categoryWeights).reduce((s: number, v: any) => s + (v as number), 0)
  const keywords: any[] = []

  // 차단 키워드 필터 (비용/보험 + 후기/추천 + 쓰레기 키워드)
  const COST_INSURANCE_FILTER = /비용|가격|할부|할인|보험|실비|실손|급여|비급여|건강보험|얼마|가격대|잘하는\s*(곳|치과)|추천\s*(병원|치과)|후기|리뷰|맛집|환절기|황사|알레르기|구내염|마스크\s*구취/
  
  for (const [cat, weight] of Object.entries(categoryWeights)) {
    const catCount = Math.max(0, Math.round(count * ((weight as number) / (totalWeight as number))))
    if (catCount === 0) continue

    // 우선: 아직 콘텐츠가 없는 키워드 (비용/보험 키워드 제외)
    const results = await c.env.DB.prepare(
      `SELECT * FROM keywords 
       WHERE is_active = 1 AND category = ?
       ORDER BY used_count ASC, priority DESC, RANDOM()
       LIMIT ?`
    ).bind(cat, catCount * 5).all() // 5배로 가져와서 비용/보험 필터링 후 선별
    
    const allResults = (results.results || []).filter((k: any) => !COST_INSURANCE_FILTER.test(k.keyword))
    const filtered = allResults.filter((k: any) => !usedKeywordIds.has(k.id))
    const fallback = allResults.filter((k: any) => usedKeywordIds.has(k.id))
    // 미사용 키워드 우선, 부족하면 기사용 키워드도 허용
    keywords.push(...filtered.slice(0, catCount), ...fallback.slice(0, Math.max(0, catCount - filtered.length)))
  }

  // 부족하면 추가 (중복 방지 필터 적용)
  if (keywords.length < count) {
    const excludeIds = keywords.map((k: any) => k.id).join(',') || '0'
    const extra = await c.env.DB.prepare(
      `SELECT * FROM keywords 
       WHERE is_active = 1 AND id NOT IN (${excludeIds})
       ORDER BY used_count ASC, priority DESC, RANDOM()
       LIMIT ?`
    ).bind((count - keywords.length) * 3).all()
    // 비용/보험 키워드 제외 + 미사용 우선
    const extraAll = (extra.results || []).filter((k: any) => !COST_INSURANCE_FILTER.test(k.keyword))
    const extraFiltered = extraAll.filter((k: any) => !usedKeywordIds.has(k.id))
    const extraFallback = extraAll.filter((k: any) => usedKeywordIds.has(k.id))
    keywords.push(...extraFiltered, ...extraFallback)
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
      // 콘텐츠 유형: 키워드 자동 분류 + 로테이션 강제 배분 (균등화)
      const classified = classifyContentType(kw.keyword, kw.search_intent || 'info')
      const rotatedType = await getNextContentType(c.env.DB)
      // 키워드가 명확히 특정 유형(E=불안, C=회복)이면 그걸 존중, 아니면 로테이션
      const finalType = (classified.type === 'E' || classified.type === 'C' || classified.type === 'D') 
        ? classified.type 
        : rotatedType.type
      const typeGuide = getTypeGuide(finalType)
      // classified 정보도 최종 유형으로 업데이트
      classified.type = finalType as any
      classified.label = finalType === 'B' ? '시술 과정/방법' : finalType === 'C' ? '회복/주의사항' : finalType === 'D' ? '비교/선택' : finalType === 'E' ? '불안/공포 해소' : '적응증/필요성'

      // 충청권 도시 로테이션 — 매 콘텐츠마다 다른 도시
      const regionInfo = regionSetting 
        ? { region: regionSetting, index: -1 }  // settings에 고정 지역이 있으면 그걸 사용
        : await getNextRegion(c.env.DB)          // 없으면 충청권 로테이션
      const region = regionInfo.region

      // 내부 링크용 기존 발행글 목록 조회
      const existingPosts = await getPublishedPosts(c.env.DB, kw.keyword)

      // Claude API 호출 (최대 3회 시도)
      let bestContent: any = null
      let attempts = 0
      const maxAttempts = 3

      while (attempts < maxAttempts) {
        attempts++
        try {
          const generated = await callClaude(
            claudeApiKey, kw.keyword, region, disclaimer,
            classified.type, typeGuide, classified.question, classified.emotion,
            existingPosts
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

      // === 0.5단계: 비용/보험 콘텐츠 후처리 (Claude가 여전히 삽입할 경우 제거) ===
      const COST_REMOVAL_PATTERNS = [
        /보험\s*적용[^<]{0,100}/g,
        /실비[^<]{0,50}/g,
        /급여[^<]{0,50}/g,
        /비급여[^<]{0,50}/g,
        /건강보험[^<]{0,80}/g,
        /\d+만\s*원[^<]{0,50}/g,
        /<details[^>]*>[\s\S]*?(보험|실비|급여|비용|가격|만\s*원)[\s\S]*?<\/details>/gi,
      ]
      let cleanedHtml = bestContent.content_html
      for (const pat of COST_REMOVAL_PATTERNS) {
        // FAQ details 태그 전체 제거 (비용 관련)
        cleanedHtml = cleanedHtml.replace(pat, '')
      }
      bestContent.content_html = cleanedHtml

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

      // === 2단계: AI 이미지 생성 (썸네일 1장만 — Inblog 1MB 제한 대응) ===
      let thumbnailUrl = ''
      
      try {
        const thumbResult = await generateAIImage(
          c.env, kw.keyword, kw.category || 'general', 'thumbnail', classified.type, contentId
        )
        thumbnailUrl = thumbResult.url
        
        // ★ 안전장치: data URI가 반환되면 Pollinations 폴백 (절대 base64를 Inblog에 전송 금지)
        if (thumbnailUrl.startsWith('data:')) {
          console.warn('[이미지] data URI 감지 → Pollinations 폴백 강제 전환')
          const seed = Math.abs(Date.now() % 999999)
          const encodedPrompt = encodeURIComponent(`Clean modern dental medical illustration about ${kw.keyword}, soft pastel colors, no text`.substring(0, 180))
          thumbnailUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1200&height=630&seed=${seed}&nologo=true`
        }
      } catch (imgErr: any) {
        console.error('이미지 생성 실패, 폴백 사용:', imgErr.message)
        thumbnailUrl = `https://placehold.co/1200x630/e8f4fd/2563eb?text=${encodeURIComponent(kw.keyword)}&font=sans-serif`
      }

      // === 3단계: 이미지 URL을 HTML에 삽입하고 DB 업데이트 ===
      // 상단 썸네일만 삽입 (본문 내 추가 이미지 삭제 → 1MB 제한 방지)
      finalHtml = `<figure style="margin:0 0 24px 0"><img src="${thumbnailUrl}" alt="${kw.keyword}" style="width:100%;border-radius:8px;max-height:400px;object-fit:cover" loading="lazy"></figure>` + finalHtml

      // === 3.5단계: 내부 링크 자동 삽입 ===
      if (existingPosts.length > 0) {
        const postListForLinks = existingPosts.map((p, idx) => ({
          id: idx, title: p.title, slug: p.slug, keyword: p.keyword, category: p.category
        }))
        const { html: linkedHtml } = insertInternalLinks(
          finalHtml, kw.keyword, postListForLinks, kw.category || 'general', 3
        )
        finalHtml = linkedHtml
      }

      // === 3.6단계: FAQ Schema(JSON-LD) + Article Schema 자동 삽입 ===
      finalHtml = injectSchemaToHtml(finalHtml, JSON.stringify(bestContent.faq), {
        title: bestContent.title,
        meta_description: bestContent.meta_description,
        slug: bestContent.slug,
        keyword_text: kw.keyword,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        word_count: bestContent.word_count,
        thumbnail_url: thumbnailUrl
      })

      // DB 업데이트 (이미지 URL + 내부 링크 + Schema 포함 최종 HTML)
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
  const failedCount = results.filter(r => r.error).length

  // === 알림 전송 ===
  try {
    if (successCount > 0) {
      await sendNotification(c.env.DB, {
        type: publishedCount > 0 ? 'publish_success' : 'cron_complete',
        title: `콘텐츠 ${isManual ? '수동' : '자동'} 생성 완료`,
        message: `${successCount}/${count}건 생성, ${publishedCount}건 발행${failedCount > 0 ? `, ${failedCount}건 실패` : ''}`,
        details: results.map((r: any) => ({
          keyword: r.keyword,
          seo_score: r.seo_score,
          status: r.status || (r.error ? 'failed' : 'draft'),
          inblog_url: r.inblog_url
        })),
        url: 'https://inblogauto.pages.dev'
      })
    }
    if (failedCount > 0) {
      await sendNotification(c.env.DB, {
        type: 'publish_failed',
        title: `⚠️ 콘텐츠 생성 실패 알림`,
        message: `${failedCount}건 실패: ${results.filter((r: any) => r.error).map((r: any) => r.keyword).join(', ')}`,
        details: results.filter((r: any) => r.error)
      })
    }
  } catch (notifErr: any) {
    console.error('알림 전송 실패:', notifErr.message)
  }

  return c.json({
    message: `${successCount}/${count}건 생성, ${publishedCount}건 자동 발행 완료`,
    auto_publish: shouldAutoPublish,
    keyword_replenish: replenishResult ? {
      triggered: replenishResult.triggered,
      saved: replenishResult.saved,
      reason: replenishResult.reason
    } : null,
    results
  })
  } catch (outerErr: any) {
    return c.json({ error: 'Cron 라우트 오류: ' + (outerErr?.message || String(outerErr)), stack: outerErr?.stack?.substring(0, 500) }, 500)
  }
})

// ===== Claude API 호출 (환자 공감형 v2 + 내부 링크) =====
async function callClaude(
  apiKey: string, keyword: string, region: string, disclaimer: string,
  contentType: string, typeGuide: string, patientQuestion: string, emotion?: string,
  existingPosts?: { title: string; slug: string; keyword: string; category: string }[]
) {
  const systemPrompt = buildSystemPrompt(keyword, contentType as any, typeGuide, patientQuestion, disclaimer, emotion)

  // 내부 링크용 기존 글 목록 (관련성 높은 것만 전달)
  let internalLinksBlock = ''
  if (existingPosts && existingPosts.length > 0) {
    const postList = existingPosts.slice(0, 15).map(p => 
      `- "${p.title}" → https://bdbddc.inblog.ai/${p.slug} (키워드: ${p.keyword})`
    ).join('\n')
    internalLinksBlock = `
## 내부 링크 삽입 (필수 — SEO 핵심)
아래는 이미 발행된 관련 글 목록입니다. 본문 중 자연스러운 맥락에서 **2~3개**를 선택하여 <a> 태그로 삽입하세요.
- "관련 글: [제목](URL)" 형태가 아닌, **문맥 속에 자연스럽게** 링크를 녹여야 합니다
- 예시: "임플란트 수술 후 관리가 궁금하시다면 <a href='URL'>임플란트 수명과 관리법</a>을 참고하세요"
- 같은 키워드의 글은 제외하고, 관련 치료/연관 정보를 가진 글을 선택하세요

기존 발행 글:
${postList}
`
  }

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
${internalLinksBlock}
핵심 방향:
- 환자의 불안과 걱정을 먼저 인정하고, 구체적 정보로 해소하세요
- 비용이나 가격 정보보다 실제 치료 과정, 통증, 회복에 집중하세요
- 환자가 읽고 나서 "이 정도면 괜찮겠다"라고 느낄 수 있어야 합니다
- "치과에서 이렇게 질문해보세요" 같은 임파워먼트 문장을 포함하세요

⛔ 절대 금지: "만원", "만 원", "가격", "비용", "보험 적용", "보험", "실비", "실손", "급여", "비급여", "건강보험", "할부", "할인", "무료 상담", "무료 검진", "수가", "본인부담", "의료비", "치료비" — 이 단어들을 title, content_html, meta_description, FAQ 어디에도 절대 쓰지 마세요. 비용 관련 FAQ 질문도 포함 금지.

위 규칙에 따라 유효한 JSON만 출력하세요.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
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
  const baseStyle = `High quality photorealistic 3D medical illustration, clean modern design, soft pastel colors with light blue and white palette, ${noText}, no human faces, no logos, professional dental healthcare aesthetic, studio lighting, cinematic composition, 8k quality, ultra-detailed`
  
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
    F: 'thoughtful contemplative atmosphere, warm encouraging feeling, clear visual metaphor',
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

// 이미지를 R2 또는 D1에 저장하고 URL 반환
async function saveImageToStorage(
  env: any, contentId: number, keyword: string, imageType: string, prompt: string, base64Data: string
): Promise<string> {
  // 방법 1: R2 스토리지 사용 (우선)
  if (env?.R2) {
    try {
      const binaryString = atob(base64Data)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }
      const key = `images/${contentId}/${imageType}.jpg`
      await env.R2.put(key, bytes.buffer, { 
        httpMetadata: { contentType: 'image/jpeg' },
        customMetadata: { keyword, prompt: prompt.substring(0, 200) }
      })
      // R2 퍼블릭 URL (Cloudflare Pages에서 자동 서빙) — 폴백으로 D1 API 사용
      return `https://inblogauto.pages.dev/api/image/${contentId}/${imageType}.jpg`
    } catch (r2Err: any) {
      console.error('R2 저장 실패, D1 폴백:', r2Err.message)
    }
  }

  // 방법 2: D1 폴백 (기존 방식)
  await env.DB.prepare(
    `INSERT OR REPLACE INTO generated_images (content_id, keyword, image_type, prompt, image_data, mime_type)
     VALUES (?, ?, ?, ?, ?, 'image/jpeg')`
  ).bind(contentId, keyword, imageType, prompt, base64Data).run()
  
  return `https://inblogauto.pages.dev/api/image/${contentId}/${imageType}.jpg`
}

// 메인 이미지 생성 함수 (고급 모델 우선)
async function generateAIImage(
  env: any, keyword: string, category: string, purpose: 'thumbnail' | 'illustration', contentType: string,
  contentId?: number
): Promise<{ url: string; caption: string }> {
  const prompt = buildImagePrompt(keyword, category, purpose, contentType)
  const caption = purpose === 'illustration' ? getImageCaption(contentType, keyword) : ''
  
  // ===== 방법 1: fal.ai FLUX 프리미엄 체인 (FLUX.2 pro → FLUX.1 pro → schnell) =====
  // 설정에서 fal.ai API 키 읽기
  let falApiKey = ''
  try {
    const falKeyRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'fal_api_key'").first()
    falApiKey = falKeyRow?.value as string || ''
  } catch (e) {}
  
  if (falApiKey) {
    // fal.ai 모델 우선순위 체인 (최고급 → 고급 → 기본)
    const falModels = [
      {
        name: 'FLUX.2 pro',
        url: 'https://fal.run/fal-ai/flux-pro/v1.1-ultra',
        body: {
          prompt: prompt,
          image_size: { width: 1200, height: 630 },
          num_images: 1,
          safety_tolerance: '5',
          output_format: 'jpeg',
        },
        cost: '~₩100/장'
      },
      {
        name: 'FLUX.1 pro',
        url: 'https://fal.run/fal-ai/flux-pro',
        body: {
          prompt: prompt,
          image_size: { width: 1200, height: 630 },
          num_images: 1,
          safety_tolerance: '5',
          output_format: 'jpeg',
        },
        cost: '~₩70/장'
      },
      {
        name: 'FLUX.1 schnell',
        url: 'https://fal.run/fal-ai/flux/schnell',
        body: {
          prompt: prompt,
          image_size: { width: 1200, height: 630 },
          num_images: 1,
          enable_safety_checker: false,
        },
        cost: '~₩4/장'
      }
    ]
    
    for (const model of falModels) {
      try {
        console.log(`[이미지] ${model.name} 시도 중... (${model.cost})`)
        const falResponse = await fetch(model.url, {
          method: 'POST',
          headers: {
            'Authorization': `Key ${falApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(model.body),
          signal: AbortSignal.timeout(60000) // 60초 타임아웃
        })
        
        if (falResponse.ok) {
          const falData: any = await falResponse.json()
          const imageUrl = falData?.images?.[0]?.url
          if (imageUrl) {
            console.log(`[이미지] ✅ ${model.name} 성공: ${keyword} (${purpose}) ${model.cost}`)
            return { url: imageUrl, caption }
          }
        } else {
          const errText = await falResponse.text()
          console.warn(`[이미지] ❌ ${model.name} 실패 (${falResponse.status}): ${errText.substring(0, 200)}`)
          // 다음 모델로 자동 폴백
          continue
        }
      } catch (falErr: any) {
        console.warn(`[이미지] ❌ ${model.name} 에러: ${falErr.message}`)
        // 다음 모델로 자동 폴백
        continue
      }
    }
    console.warn('[이미지] fal.ai 전체 모델 실패, 다음 방법으로 폴백')
  }
  
  // ===== 방법 2: Cloudflare Workers AI (무료 할당량 내에서) =====
  if (env?.AI) {
    try {
      const aiResult = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
        prompt: prompt,
        num_steps: 4,
      })
      const raw = (aiResult as any)?.image ?? aiResult
      
      if (raw && typeof raw === 'string' && raw.length > 1000) {
        console.log(`[이미지] Workers AI schnell 성공: ${keyword}, base64 len=${raw.length}`)
        if (contentId && env?.R2) {
          try {
            const savedUrl = await saveImageToStorage(env, contentId, keyword, purpose, prompt, raw)
            return { url: savedUrl, caption }
          } catch (r2Err: any) {
            console.error('R2 저장 실패:', r2Err.message)
          }
        }
      }
    } catch (schnellErr: any) {
      console.warn(`Workers AI schnell 실패: ${schnellErr.message}`)
    }
  }
  
  // ===== 방법 3: Pollinations AI (무료 폴백) =====
  try {
    const seed = Math.abs(hashString(keyword + purpose + contentType))
    const shortPrompt = prompt.substring(0, 200)
    const encodedPrompt = encodeURIComponent(shortPrompt)
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1200&height=630&seed=${seed}&nologo=true&model=turbo`
    
    const headCheck = await fetch(pollinationsUrl, { method: 'HEAD', signal: AbortSignal.timeout(20000) })
    if (headCheck.ok || headCheck.status === 302 || headCheck.status === 301) {
      console.log(`[이미지] Pollinations turbo 사용: ${keyword} (${purpose})`)
      return { url: pollinationsUrl, caption }
    }
  } catch (pollErr: any) {
    console.warn('Pollinations 실패:', pollErr.message)
  }

  // ===== 방법 4: 플레이스홀더 폴백 (최후의 수단) =====
  const colors = ['4A90D9', '5B8C5A', '8B5CF6', 'D97706', 'DC2626', '0891B2', '7C3AED', '059669']
  const colorIdx = Math.abs(hashString(keyword + purpose)) % colors.length
  const bg = colors[colorIdx]
  const fallbackUrl = `https://placehold.co/1200x630/${bg}/ffffff?text=${encodeURIComponent(keyword)}&font=sans-serif`
  console.log(`[이미지] 플레이스홀더 폴백: ${keyword} (${purpose})`)
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
