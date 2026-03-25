// Cron Worker v2: 새벽 자동 발행 + 실패 재시도 + 중복 방지 + 시간 랜덤화
// KST 02:00~05:00 → 3건 발행 (v4: 제목 다양화 + 페르소나 + 지역명 본문만)

const DAILY_TARGET = 3

export default {
  async scheduled(event, env, ctx) {
    const APP_URL = env.APP_URL || 'https://inblogauto.pages.dev'
    const CRON_SECRET = env.CRON_SECRET || ''

    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000)
    const kstHour = kstNow.getUTCHours()
    const kstMin = kstNow.getUTCMinutes()
    const kstTime = `${kstHour}:${String(kstMin).padStart(2, '0')}`
    const todayKST = `${kstNow.getUTCFullYear()}-${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}-${String(kstNow.getUTCDate()).padStart(2, '0')}`

    // ===== 1. 시간 랜덤화: ±15분 대기 (봇 패턴 회피) =====
    const randomDelay = Math.floor(Math.random() * 15 * 60 * 1000) // 0~15분
    console.log(`[Cron] KST ${kstTime} - ${Math.round(randomDelay / 1000)}초 랜덤 대기 후 시작`)
    await new Promise(resolve => setTimeout(resolve, randomDelay))

    // ===== 2. 중복 발행 방지: 오늘 이미 N건 발행했으면 스킵 =====
    try {
      const dashRes = await fetch(`${APP_URL}/api/dashboard`, {
        headers: CRON_SECRET ? { 'X-Cron-Secret': CRON_SECRET } : {}
      })
      if (dashRes.ok) {
        const dashData = await dashRes.json()
        const todayPublished = dashData.today_published || 0
        if (todayPublished >= DAILY_TARGET) {
          console.log(`[Cron] KST ${kstTime} - 오늘 이미 ${todayPublished}건 발행 완료, 스킵`)
          return
        }
        console.log(`[Cron] KST ${kstTime} - 오늘 ${todayPublished}/${DAILY_TARGET}건 발행됨, 계속 진행`)
      }
    } catch (checkErr) {
      console.warn(`[Cron] 발행 현황 확인 실패, 계속 진행:`, checkErr.message)
    }

    // ===== 3. 발행 시도 =====
    const result = await attemptPublish(APP_URL, CRON_SECRET, kstTime)

    // ===== 3.5. 마지막 트리거 시 일일 리포트 발송 (KST 05:30 트리거) =====
    if (kstHour >= 5 && kstMin >= 20) {
      ctx.waitUntil((async () => {
        try {
          // 발행 완료 후 2분 대기 후 리포트 발송
          await new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000))
          const reportRes = await fetch(`${APP_URL}/api/enhancements/daily-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          })
          if (reportRes.ok) {
            console.log(`[Cron] 일일 리포트 발송 완료`)
          }
        } catch (e) {
          console.warn(`[Cron] 일일 리포트 발송 실패:`, e.message)
        }
      })())
    }

    // ===== 4. 실패 시 자동 재시도 (30분 후 1회) =====
    if (!result.success) {
      console.log(`[Cron] KST ${kstTime} - 첫 시도 실패, 30분 후 재시도 예약`)
      
      // ctx.waitUntil로 백그라운드에서 30분 후 재시도
      ctx.waitUntil((async () => {
        await new Promise(resolve => setTimeout(resolve, 30 * 60 * 1000)) // 30분 대기
        
        const retryKstNow = new Date(Date.now() + 9 * 60 * 60 * 1000)
        const retryTime = `${retryKstNow.getUTCHours()}:${String(retryKstNow.getUTCMinutes()).padStart(2, '0')}`
        
        console.log(`[Cron] KST ${retryTime} - 재시도 시작`)
        const retryResult = await attemptPublish(APP_URL, CRON_SECRET, retryTime)
        
        if (retryResult.success) {
          console.log(`[Cron] KST ${retryTime} - 재시도 성공!`)
        } else {
          console.error(`[Cron] KST ${retryTime} - 재시도도 실패: ${retryResult.error}`)
        }
      })())
    }
  },

  // 수동 테스트용 HTTP 핸들러
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/test') {
      await this.scheduled({}, env, { waitUntil: (p) => p })
      return new Response('Cron test triggered', { status: 200 })
    }

    if (url.pathname === '/status') {
      try {
        const APP_URL = env.APP_URL || 'https://inblogauto.pages.dev'
        const dashRes = await fetch(`${APP_URL}/api/dashboard`)
        const dashData = await dashRes.json()
        return new Response(JSON.stringify({
          today_published: dashData.today_published || 0,
          daily_target: DAILY_TARGET,
          remaining: Math.max(0, DAILY_TARGET - (dashData.today_published || 0)),
          schedule: 'KST 02:00, 03:30, 05:00 (±15min random)',
          features: ['retry_on_failure', 'duplicate_prevention', 'time_randomization']
        }, null, 2), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 })
      }
    }

    return new Response(`Inblog AutoPublish Cron Worker v4

Schedule: KST 02:00, 03:30, 05:00 (±15min random)
Target: ${DAILY_TARGET} posts/day (v4: 제목 다양화 + 페르소나 + 지역명 본문만)

Features:
  - Time randomization (±15min)
  - Duplicate prevention (skip if daily target met)
  - Auto retry on failure (30min delay)

Endpoints:
  GET /test   - Manual trigger
  GET /status - Today's publish status`, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    })
  }
}

// 발행 시도 함수 (재사용)
async function attemptPublish(appUrl, cronSecret, kstTime) {
  try {
    const response = await fetch(`${appUrl}/api/cron/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cronSecret ? { 'X-Cron-Secret': cronSecret } : {})
      },
      body: JSON.stringify({
        count: 1,
        manual: false,
        auto_publish: true
      })
    })

    const result = await response.json()
    const hasError = result.results?.some(r => r.error || r.status === 'failed')
    
    if (hasError) {
      const errorMsg = result.results?.find(r => r.error)?.error || 'unknown'
      console.error(`[Cron] KST ${kstTime} - 발행 실패: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }

    console.log(`[Cron] KST ${kstTime} - 발행 성공: ${result.message}`)
    return { success: true, result }
  } catch (err) {
    console.error(`[Cron] KST ${kstTime} - 네트워크 오류: ${err.message}`)
    return { success: false, error: err.message }
  }
}
