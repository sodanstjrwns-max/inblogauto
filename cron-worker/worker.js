// Cron Worker v7.0: 콘텐츠 고도화 (인터렉티브 요소, SEO 스코어링 강화, 이미지 프롬프트 최적화)
// KST 02:00, 03:30, 05:00 → 하루 3건 발행
// 전략: publish-next로 기존 draft 발행 → draft 부족 시 generate-drafts로 보충

const DAILY_TARGET = 3

export default {
  async scheduled(event, env, ctx) {
    const APP_URL = env.APP_URL || 'https://inblogauto.pages.dev'
    const CRON_SECRET = env.CRON_SECRET || ''

    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000)
    const kstHour = kstNow.getUTCHours()
    const kstMin = kstNow.getUTCMinutes()
    const kstTime = `${kstHour}:${String(kstMin).padStart(2, '0')}`

    // ===== 1. 시간 랜덤화: ±10분 대기 (봇 패턴 회피) =====
    const randomDelay = Math.floor(Math.random() * 10 * 60 * 1000) // 0~10분
    console.log(`[Cron v6] KST ${kstTime} - ${Math.round(randomDelay / 1000)}초 대기 후 시작`)
    await new Promise(resolve => setTimeout(resolve, randomDelay))

    // ===== 2. 현황 확인: draft 잔량 + 오늘 발행 수 =====
    let draftStatus = null
    try {
      const statusRes = await fetch(`${APP_URL}/api/cron/draft-status`, {
        headers: CRON_SECRET ? { 'X-Cron-Secret': CRON_SECRET } : {},
        signal: AbortSignal.timeout(15000)
      })
      if (statusRes.ok) {
        draftStatus = await statusRes.json()
        console.log(`[Cron v6] 현황: draft=${draftStatus.draft_count}, 오늘발행=${draftStatus.published_today}`)
        
        if (draftStatus.published_today >= DAILY_TARGET) {
          console.log(`[Cron v6] 오늘 이미 ${draftStatus.published_today}건 발행 완료, 스킵`)
          
          // 하지만 draft 보충은 필요할 수 있음
          if (draftStatus.draft_count < 3) {
            console.log(`[Cron v6] draft 부족 (${draftStatus.draft_count}개) → 백그라운드 보충`)
            ctx.waitUntil(replenishDrafts(APP_URL, CRON_SECRET))
          }
          return
        }
      }
    } catch (checkErr) {
      console.warn(`[Cron v6] 현황 확인 실패, 계속 진행:`, checkErr.message)
    }

    // ===== 3. 발행 시도 (publish-next 사용 — 가볍고 빠름) =====
    const result = await attemptPublishNext(APP_URL, CRON_SECRET, kstTime)

    // ===== 4. draft 보충 (백그라운드) =====
    const currentDrafts = result.drafts_remaining ?? (draftStatus?.draft_count || 0)
    if (currentDrafts < 4 || result.needs_replenish) {
      console.log(`[Cron v6] draft ${currentDrafts}개 → 백그라운드 보충 시작`)
      ctx.waitUntil(replenishDrafts(APP_URL, CRON_SECRET))
    }

    // ===== 5. 마지막 트리거 시 일일 리포트 발송 =====
    if (kstHour >= 5 && kstMin >= 20) {
      ctx.waitUntil((async () => {
        try {
          await new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000))
          const reportRes = await fetch(`${APP_URL}/api/enhancements/daily-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(30000)
          })
          if (reportRes.ok) {
            console.log(`[Cron v6] 일일 리포트 발송 완료`)
          }
        } catch (e) {
          console.warn(`[Cron v6] 일일 리포트 발송 실패:`, e.message)
        }
      })())
    }

    // ===== 6. 실패 시 재시도 (20분 후 — 단축) =====
    if (!result.success) {
      console.log(`[Cron v6] 발행 실패, 20분 후 재시도 예약`)
      ctx.waitUntil((async () => {
        await new Promise(resolve => setTimeout(resolve, 20 * 60 * 1000))
        const retryResult = await attemptPublishNext(APP_URL, CRON_SECRET, 'retry')
        console.log(`[Cron v6] 재시도 ${retryResult.success ? '성공' : '실패'}: ${retryResult.error || retryResult.title || ''}`)
      })())
    }
  },

  // 수동 테스트용 HTTP 핸들러
  async fetch(request, env) {
    const url = new URL(request.url)
    const APP_URL = env.APP_URL || 'https://inblogauto.pages.dev'

    if (url.pathname === '/test') {
      await this.scheduled({}, env, { waitUntil: (p) => p })
      return new Response('Cron v6 test triggered', { status: 200 })
    }

    if (url.pathname === '/test-publish') {
      const result = await attemptPublishNext(APP_URL, '', 'manual-test')
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    if (url.pathname === '/status') {
      try {
        const [dashRes, draftRes] = await Promise.all([
          fetch(`${APP_URL}/api/dashboard/stats`, { signal: AbortSignal.timeout(10000) }).catch(() => null),
          fetch(`${APP_URL}/api/cron/draft-status`, { signal: AbortSignal.timeout(10000) }).catch(() => null)
        ])
        const dashData = dashRes?.ok ? await dashRes.json() : {}
        const draftData = draftRes?.ok ? await draftRes.json() : {}
        return new Response(JSON.stringify({
          version: 'v7.0',
          today_published: dashData.today_published || 0,
          daily_target: DAILY_TARGET,
          remaining: Math.max(0, DAILY_TARGET - (dashData.today_published || 0)),
          draft_count: draftData.draft_count || 0,
          draft_buffer_days: draftData.days_of_buffer || 0,
          schedule: 'KST 02:00, 03:30, 05:00 (±10min random)',
          architecture: 'publish-next + generate-drafts (분리형)',
          features: [
            'publish-next_first (빠른 발행)',
            'background_draft_replenish (비동기 보충)',
            'retry_on_failure (20분 후 재시도)',
            'duplicate_prevention (일 5건 하드리밋)',
            'slug_collision_guard (slug 중복 방지)',
            'failed_draft_marking (3회 실패시 failed 전환)'
          ]
        }, null, 2), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 })
      }
    }

    if (url.pathname === '/health') {
      try {
        const res = await fetch(`${APP_URL}/api/health`, { signal: AbortSignal.timeout(10000) })
        return new Response(JSON.stringify({
          status: res.ok ? 'healthy' : 'degraded',
          app_url: APP_URL,
          http_status: res.status,
          timestamp: new Date().toISOString()
        }), {
          status: res.ok ? 200 : 503,
          headers: { 'Content-Type': 'application/json' }
        })
      } catch (e) {
        return new Response(JSON.stringify({
          status: 'unhealthy',
          error: e.message,
          timestamp: new Date().toISOString()
        }), { status: 503, headers: { 'Content-Type': 'application/json' } })
      }
    }

    return new Response(JSON.stringify({
      name: 'InBlog AutoPublish Cron Worker',
      version: 'v7.0',
      schedule: 'KST 02:00, 03:30, 05:00 (±10min random)',
      daily_target: DAILY_TARGET,
      architecture: 'publish-next + generate-drafts',
      endpoints: {
        '/test': 'Manual trigger (full cron cycle)',
        '/test-publish': 'Test publish-next only',
        '/status': 'System status with live data',
        '/health': 'Health check (JSON)'
      }
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ===== publish-next 호출 (가볍고 빠름 — draft → 발행) =====
async function attemptPublishNext(appUrl, cronSecret, kstTime) {
  try {
    const response = await fetch(`${appUrl}/api/cron/publish-next`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cronSecret ? { 'X-Cron-Secret': cronSecret } : {})
      },
      signal: AbortSignal.timeout(120000) // 2분 타임아웃
    })

    const result = await response.json()
    
    if (result.published) {
      console.log(`[Cron v6] KST ${kstTime} - ✅ 발행 성공: "${result.title}" (${result.elapsed_ms}ms)`)
      return { 
        success: true, 
        title: result.title, 
        url: result.inblog_url,
        drafts_remaining: result.drafts_remaining,
        needs_replenish: result.needs_replenish,
        today_published: result.today_published
      }
    }

    // draft 없음 → generate 필요
    if (result.needs_replenish || result.drafts_remaining === 0) {
      console.log(`[Cron v6] KST ${kstTime} - draft 없음, 직접 생성+발행 시도`)
      return await attemptGenerateAndPublish(appUrl, cronSecret, kstTime)
    }

    console.log(`[Cron v6] KST ${kstTime} - 발행 스킵: ${result.message}`)
    return { success: true, message: result.message, drafts_remaining: result.drafts_remaining }
  } catch (err) {
    console.error(`[Cron v6] KST ${kstTime} - publish-next 실패: ${err.message}`)
    // 폴백: 기존 generate 방식
    return await attemptGenerateAndPublish(appUrl, cronSecret, kstTime)
  }
}

// ===== generate+publish 폴백 (draft가 없을 때만) =====
async function attemptGenerateAndPublish(appUrl, cronSecret, kstTime) {
  try {
    const response = await fetch(`${appUrl}/api/cron/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cronSecret ? { 'X-Cron-Secret': cronSecret } : {})
      },
      body: JSON.stringify({ count: 1, manual: false, auto_publish: true }),
      signal: AbortSignal.timeout(300000) // 5분 타임아웃 (AI 생성 포함)
    })

    const result = await response.json()
    const hasError = result.results?.some(r => r.error || r.status === 'failed')
    
    if (hasError) {
      const errorMsg = result.results?.find(r => r.error)?.error || 'unknown'
      console.error(`[Cron v6] KST ${kstTime} - generate 실패: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }

    console.log(`[Cron v6] KST ${kstTime} - generate+publish 성공: ${result.message}`)
    return { success: true, result, drafts_remaining: 0, needs_replenish: true }
  } catch (err) {
    console.error(`[Cron v6] KST ${kstTime} - generate 실패: ${err.message}`)
    return { success: false, error: err.message }
  }
}

// ===== draft 보충 (백그라운드) =====
async function replenishDrafts(appUrl, cronSecret) {
  try {
    console.log(`[Cron v6] draft 보충 시작...`)
    const response = await fetch(`${appUrl}/api/cron/generate-drafts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cronSecret ? { 'X-Cron-Secret': cronSecret } : {})
      },
      body: JSON.stringify({ count: 3, target_drafts: 6 }),
      signal: AbortSignal.timeout(600000) // 10분 타임아웃
    })
    const result = await response.json()
    console.log(`[Cron v6] draft 보충 완료: ${result.generated || 0}건 생성 (현재 ${result.current_drafts || '?'}개)`)
  } catch (err) {
    console.error(`[Cron v6] draft 보충 실패:`, err.message)
  }
}
