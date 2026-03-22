import { Hono } from 'hono'
import type { Bindings } from '../index'

const dashboardRoutes = new Hono<{ Bindings: Bindings }>()

// GET /api/dashboard/stats - 대시보드 통계
dashboardRoutes.get('/stats', async (c) => {
  const today = new Date().toISOString().split('T')[0]

  // 오늘 발행 현황
  const todayPublished = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM contents WHERE status = 'published' AND DATE(created_at) = ?"
  ).bind(today).first()

  // 오늘 스케줄
  const scheduleRow = await c.env.DB.prepare(
    "SELECT posts_per_day FROM schedules WHERE name = 'default'"
  ).first()

  // 총 누적 발행
  const totalPublished = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM contents WHERE status = 'published'"
  ).first()

  // 평균 SEO 점수
  const avgSeo = await c.env.DB.prepare(
    "SELECT ROUND(AVG(seo_score), 1) as avg_score FROM contents WHERE seo_score > 0"
  ).first()

  // 발행 성공률
  const totalLogs = await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM publish_logs").first()
  const successLogs = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM publish_logs WHERE status = 'published'"
  ).first()
  const successRate = (totalLogs?.cnt as number) > 0
    ? Math.round(((successLogs?.cnt as number) / (totalLogs?.cnt as number)) * 100)
    : 0

  // 주간 발행 데이터
  const weeklyData = await c.env.DB.prepare(
    `SELECT DATE(created_at) as date, COUNT(*) as cnt 
     FROM contents WHERE status = 'published' AND created_at >= datetime('now', '-7 days')
     GROUP BY DATE(created_at) ORDER BY date`
  ).all()

  const dayLabels = ['일', '월', '화', '수', '목', '금', '토']
  const weeklyLabels: string[] = []
  const weeklyCounts: number[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().split('T')[0]
    weeklyLabels.push(dayLabels[d.getDay()])
    const found = weeklyData.results.find((r: any) => r.date === dateStr)
    weeklyCounts.push(found ? (found as any).cnt : 0)
  }

  // 카테고리별 분포
  const categoryData = await c.env.DB.prepare(
    `SELECT k.category, COUNT(*) as cnt 
     FROM contents c JOIN keywords k ON c.keyword_id = k.id 
     WHERE c.status = 'published'
     GROUP BY k.category`
  ).all()
  const categoryCounts: Record<string, number> = {}
  categoryData.results.forEach((r: any) => { categoryCounts[r.category] = r.cnt })

  // 다음 발행 예정 키워드
  const upcoming = await c.env.DB.prepare(
    `SELECT k.keyword, k.category FROM keywords k 
     WHERE k.is_active = 1 
     ORDER BY k.used_count ASC, k.priority DESC 
     LIMIT 5`
  ).all()

  // 최근 실패
  const failures = await c.env.DB.prepare(
    `SELECT pl.id, pl.error_message, c.keyword_text 
     FROM publish_logs pl JOIN contents c ON pl.content_id = c.id 
     WHERE pl.status = 'failed' 
     ORDER BY pl.created_at DESC LIMIT 5`
  ).all()

  return c.json({
    today_published: todayPublished?.cnt || 0,
    today_scheduled: scheduleRow?.posts_per_day || 3,
    total_published: totalPublished?.cnt || 0,
    avg_seo_score: avgSeo?.avg_score || 0,
    success_rate: successRate,
    weekly_labels: weeklyLabels,
    weekly_counts: weeklyCounts,
    category_counts: categoryCounts,
    upcoming: upcoming.results.map((k: any) => ({
      keyword: k.keyword,
      category: k.category,
      scheduled_time: '예정'
    })),
    recent_failures: failures.results
  })
})

export { dashboardRoutes }
