// ===== InBlog Auto-Publish Cron Worker (v5.6) =====
// 역할: draft 대기열에서 1개를 꺼내 인블로그에 발행 (5초 이내 완료)
// 글 생성(draft)은 별도로 미리 해놓음 — 이 Worker는 발행만 담당
// draft 부족 시 자동 보충 요청 (generate-drafts)

const BASE_URL = "https://inblogauto.pages.dev"

export default {
  async scheduled(event, env, ctx) {
    const now = new Date().toISOString()
    console.log(`[Cron] 🕐 발행 시작: ${now}`)

    try {
      // 1단계: draft 상태 확인
      const statusResp = await fetch(`${BASE_URL}/api/cron/draft-status`)
      let draftStatus = null
      if (statusResp.ok) {
        draftStatus = await statusResp.json()
        console.log(`[Cron] 📊 Draft 현황: ${draftStatus.draft_count}개 대기, 오늘 ${draftStatus.published_today}개 발행됨`)
      }

      // 2단계: draft → publish (가볍고 빠름, 5초 이내)
      const publishResp = await fetch(`${BASE_URL}/api/cron/publish-next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      })
      const result = await publishResp.json()

      if (result.published) {
        console.log(`[Cron] ✅ 발행 완료: "${result.title}" → ${result.inblog_url}`)
        console.log(`[Cron] 📋 남은 draft: ${result.drafts_remaining}개`)

        // 3단계: draft 부족 시 보충 요청 (비동기, 결과 기다리지 않음)
        if (result.needs_replenish || result.drafts_remaining < 3) {
          console.log(`[Cron] ⚠️ Draft 부족 (${result.drafts_remaining}개) → 보충 요청 발송`)
          // ctx.waitUntil로 비동기 보충 — Worker 응답 시간에 영향 없음
          ctx.waitUntil(
            fetch(`${BASE_URL}/api/cron/generate-drafts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ count: 3, target_drafts: 6 })
            }).then(async (resp) => {
              if (resp.ok) {
                const data = await resp.json()
                console.log(`[Cron] 📦 Draft 보충 완료: ${data.generated || 0}건 생성 (총 ${data.current_drafts}개)`)
              } else {
                console.warn(`[Cron] ⚠️ Draft 보충 실패: HTTP ${resp.status}`)
              }
            }).catch(err => {
              console.error(`[Cron] ❌ Draft 보충 에러:`, err.message)
            })
          )
        }
      } else {
        console.log(`[Cron] ⚠️ 발행 실패 또는 draft 없음: ${result.message || result.error || 'unknown'}`)

        // draft가 아예 없으면 보충 요청
        if (result.needs_replenish) {
          console.log(`[Cron] 🔄 Draft 0개 → 긴급 보충 요청`)
          ctx.waitUntil(
            fetch(`${BASE_URL}/api/cron/generate-drafts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ count: 3, target_drafts: 6 })
            }).catch(err => console.error(`[Cron] ❌ 긴급 보충 에러:`, err.message))
          )
        }
      }
    } catch (err) {
      console.error("[Cron] ❌ 전체 실패:", err.message)
    }
  }
}
