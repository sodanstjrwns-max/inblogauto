// Cron Worker: 새벽에 inblogauto Pages 앱의 API를 호출하여 자동 발행
// KST 02:00, 03:00, 04:00, 05:00, 05:30 → 5건 발행 (오전 6시 전 완료)

export default {
  async scheduled(event, env, ctx) {
    const APP_URL = env.APP_URL || 'https://inblogauto.pages.dev'
    const CRON_SECRET = env.CRON_SECRET || ''

    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000)
    const kstTime = `${kstNow.getUTCHours()}:${String(kstNow.getUTCMinutes()).padStart(2, '0')}`

    console.log(`[Cron] KST ${kstTime} - 자동 발행 1건 시작`)

    try {
      const response = await fetch(`${APP_URL}/api/cron/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(CRON_SECRET ? { 'X-Cron-Secret': CRON_SECRET } : {})
        },
        body: JSON.stringify({
          count: 1,
          manual: false,
          auto_publish: true
        })
      })

      const result = await response.json()
      console.log(`[Cron] KST ${kstTime} - 완료:`, JSON.stringify(result.message || result))
    } catch (err) {
      console.error(`[Cron] KST ${kstTime} - 실패:`, err.message)
    }
  },

  // 수동 테스트용 HTTP 핸들러
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/test') {
      // 수동으로 cron 테스트
      await this.scheduled({}, env, { waitUntil: () => {} })
      return new Response('Cron test triggered', { status: 200 })
    }

    return new Response('Inblog AutoPublish Cron Worker\n\nSchedule: KST 02:00, 03:00, 04:00, 05:00, 05:30\nTarget: 5 posts/day before 6am KST\n\nGET /test - Manual trigger', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    })
  }
}
