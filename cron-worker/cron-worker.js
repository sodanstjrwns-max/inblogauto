export default {
  async scheduled(event, env, ctx) {
    // 6시~8시대 크론 3번 → 각각 1개씩 발행
    // 랜덤 지연(0~45분)을 추가해서 자연스럽게 분산
    const maxDelayMs = 45 * 60 * 1000 // 최대 45분
    const delayMs = Math.floor(Math.random() * maxDelayMs)
    const delayMin = Math.round(delayMs / 60000)

    console.log(`[Cron] ${delayMin}분 랜덤 지연 후 1개 발행 예정`)

    // Cloudflare Workers는 waitUntil로 비동기 처리
    ctx.waitUntil(
      new Promise(resolve => setTimeout(resolve, delayMs)).then(async () => {
        try {
          const response = await fetch("https://inblogauto.pages.dev/api/cron/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ count: 1, manual: false, auto_publish: true })
          });
          const result = await response.json();
          console.log(`[Cron] 발행 완료 (지연 ${delayMin}분):`, JSON.stringify(result));
        } catch (err) {
          console.error(`[Cron] 발행 실패:`, err.message);
        }
      })
    );
  }
}
