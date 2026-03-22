import { Hono } from 'hono'
import type { Bindings } from '../index'
import { classifyContentType, getTypeGuide, buildSystemPrompt, calculateSeoScore } from './contents'
import { verifyInblogApiKey, syncTags, createInblogPost, publishInblogPost } from './publish'

const cronApp = new Hono<{ Bindings: Bindings }>()

// POST /api/cron/generate - 자동/수동 콘텐츠 생성 + 선택적 자동 발행
cronApp.post('/', async (c) => {
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
  const region = regionRow?.value as string || ''
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

      // 이미지 — Unsplash 고품질 치과/의료 이미지 (항상 안정적)
      const thumbImg = getDentalImage(kw.category || 'general', 'thumbnail')
      const infoImg = getDentalImage(kw.category || 'general', 'infographic', classified.type)
      const thumbnailUrl = thumbImg.url
      const infoImageUrl = infoImg.url

      // 콘텐츠 HTML에 인포그래픽(본문 중간) + 썸네일(상단) 삽입
      let finalHtml = bestContent.content_html

      // 1) 본문 첫 번째 H2 섹션 뒤에 인포그래픽 삽입
      const firstH2End = finalHtml.indexOf('</h2>')
      if (firstH2End !== -1) {
        const afterFirstH2 = finalHtml.indexOf('<h2', firstH2End + 5)
        if (afterFirstH2 !== -1) {
          const infographicHtml = `<figure style="margin:32px 0;text-align:center"><img src="${infoImageUrl}" alt="${kw.keyword} 관련 이미지" style="width:100%;max-width:800px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.08)" loading="lazy"><figcaption style="text-align:center;font-size:13px;color:#888;margin-top:10px">${infoImg.caption}</figcaption></figure>`
          finalHtml = finalHtml.slice(0, afterFirstH2) + infographicHtml + finalHtml.slice(afterFirstH2)
        }
      }

      // 2) 상단 썸네일
      finalHtml = `<figure style="margin:0 0 24px 0"><img src="${thumbnailUrl}" alt="${kw.keyword}" style="width:100%;border-radius:8px;max-height:400px;object-fit:cover" loading="lazy"></figure>` + finalHtml

      // DB 저장
      const insertResult = await c.env.DB.prepare(
        `INSERT INTO contents (keyword_id, keyword_text, title, slug, meta_description, content_html, tags, faq_json, thumbnail_url, thumbnail_prompt, seo_score, word_count, generation_attempts, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
      ).bind(
        kw.id, kw.keyword, bestContent.title, bestContent.slug,
        bestContent.meta_description, finalHtml,
        JSON.stringify(bestContent.tags), JSON.stringify(bestContent.faq),
        thumbnailUrl, '', bestContent.seo_score, bestContent.word_count, bestContent.attempts
      ).run()

      const contentId = insertResult.meta.last_row_id

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

          // Inblog에 포스트 생성
          const createResult = await createInblogPost(inblogApiKey, {
            title: bestContent.title,
            slug: bestContent.slug,
            description: bestContent.meta_description,
            content_html: finalHtml,
            meta_description: bestContent.meta_description,
            image: thumbnailUrl
          }, tagIds)

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
${region ? '참고 지역: ' + region : ''}
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

// ===== Unsplash 치과/의료 이미지 풀 (항상 안정적, 고품질) =====
function getDentalImage(category: string, purpose: 'thumbnail' | 'infographic', contentType?: string): { url: string; caption: string } {
  // 카테고리별 + 용도별 Unsplash 이미지 (모두 검증된 URL)
  const images: Record<string, { thumb: string[]; info: Record<string, string[]> }> = {
    implant: {
      thumb: [
        'https://images.unsplash.com/photo-1606811841689-23dfddce3e95?w=1200&h=630&fit=crop&q=80',
        'https://images.unsplash.com/photo-1598256989800-fe5f95da9787?w=1200&h=630&fit=crop&q=80',
        'https://images.unsplash.com/photo-1609840114035-3c981b782dfe?w=1200&h=630&fit=crop&q=80',
        'https://images.unsplash.com/photo-1629909613654-28e377c37b09?w=1200&h=630&fit=crop&q=80',
      ],
      info: {
        B: [
          'https://images.unsplash.com/photo-1588776814546-1ffcf47267a5?w=1200&h=800&fit=crop&q=80',
          'https://images.unsplash.com/photo-1579684385127-1ef15d508118?w=1200&h=800&fit=crop&q=80',
        ],
        C: [
          'https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?w=1200&h=800&fit=crop&q=80',
          'https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=1200&h=800&fit=crop&q=80',
        ],
        D: [
          'https://images.unsplash.com/photo-1571772996211-2f02c9727629?w=1200&h=800&fit=crop&q=80',
          'https://images.unsplash.com/photo-1607613009820-a29f7bb81c04?w=1200&h=800&fit=crop&q=80',
        ],
      }
    },
    orthodontics: {
      thumb: [
        'https://images.unsplash.com/photo-1606811971618-4486d14f3f99?w=1200&h=630&fit=crop&q=80',
        'https://images.unsplash.com/photo-1570612861542-284f4c12e75f?w=1200&h=630&fit=crop&q=80',
        'https://images.unsplash.com/photo-1598256989800-fe5f95da9787?w=1200&h=630&fit=crop&q=80',
      ],
      info: {
        B: [
          'https://images.unsplash.com/photo-1588776814546-1ffcf47267a5?w=1200&h=800&fit=crop&q=80',
          'https://images.unsplash.com/photo-1606811841689-23dfddce3e95?w=1200&h=800&fit=crop&q=80',
        ],
        C: [
          'https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?w=1200&h=800&fit=crop&q=80',
          'https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=1200&h=800&fit=crop&q=80',
        ],
        D: [
          'https://images.unsplash.com/photo-1571772996211-2f02c9727629?w=1200&h=800&fit=crop&q=80',
          'https://images.unsplash.com/photo-1607613009820-a29f7bb81c04?w=1200&h=800&fit=crop&q=80',
        ],
      }
    },
    general: {
      thumb: [
        'https://images.unsplash.com/photo-1629909613654-28e377c37b09?w=1200&h=630&fit=crop&q=80',
        'https://images.unsplash.com/photo-1606811841689-23dfddce3e95?w=1200&h=630&fit=crop&q=80',
        'https://images.unsplash.com/photo-1609840114035-3c981b782dfe?w=1200&h=630&fit=crop&q=80',
      ],
      info: {
        B: [
          'https://images.unsplash.com/photo-1579684385127-1ef15d508118?w=1200&h=800&fit=crop&q=80',
          'https://images.unsplash.com/photo-1588776814546-1ffcf47267a5?w=1200&h=800&fit=crop&q=80',
        ],
        C: [
          'https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=1200&h=800&fit=crop&q=80',
          'https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?w=1200&h=800&fit=crop&q=80',
        ],
        D: [
          'https://images.unsplash.com/photo-1571772996211-2f02c9727629?w=1200&h=800&fit=crop&q=80',
          'https://images.unsplash.com/photo-1607613009820-a29f7bb81c04?w=1200&h=800&fit=crop&q=80',
        ],
      }
    },
    prevention: {
      thumb: [
        'https://images.unsplash.com/photo-1606811971618-4486d14f3f99?w=1200&h=630&fit=crop&q=80',
        'https://images.unsplash.com/photo-1609840114035-3c981b782dfe?w=1200&h=630&fit=crop&q=80',
      ],
      info: {
        B: [
          'https://images.unsplash.com/photo-1588776814546-1ffcf47267a5?w=1200&h=800&fit=crop&q=80',
        ],
        C: [
          'https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?w=1200&h=800&fit=crop&q=80',
        ],
        D: [
          'https://images.unsplash.com/photo-1571772996211-2f02c9727629?w=1200&h=800&fit=crop&q=80',
        ],
      }
    },
    local: {
      thumb: [
        'https://images.unsplash.com/photo-1629909613654-28e377c37b09?w=1200&h=630&fit=crop&q=80',
      ],
      info: {
        B: [
          'https://images.unsplash.com/photo-1579684385127-1ef15d508118?w=1200&h=800&fit=crop&q=80',
        ],
        C: [
          'https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=1200&h=800&fit=crop&q=80',
        ],
        D: [
          'https://images.unsplash.com/photo-1607613009820-a29f7bb81c04?w=1200&h=800&fit=crop&q=80',
        ],
      }
    }
  }

  const pool = images[category] || images.general
  const now = Date.now()

  if (purpose === 'thumbnail') {
    const idx = now % pool.thumb.length
    return { url: pool.thumb[idx], caption: '' }
  } else {
    const type = contentType || 'B'
    const infoPool = pool.info[type] || pool.info.B
    const idx = (now + 3) % infoPool.length
    const captions: Record<string, string> = {
      B: '▲ 시술 과정 참고 이미지',
      C: '▲ 회복 관리 참고 이미지',
      D: '▲ 치료 옵션 비교 참고 이미지',
    }
    return { url: infoPool[idx], caption: captions[type] || '▲ 참고 이미지' }
  }
}

export { cronHandler }
