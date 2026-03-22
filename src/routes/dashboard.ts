import { Hono } from 'hono'
import type { Bindings } from '../index'

const dashboardRoutes = new Hono<{ Bindings: Bindings }>()

// GET /api/dashboard/stats - 대시보드 통계 (완전 구현)
dashboardRoutes.get('/stats', async (c) => {
  // KST(UTC+9) 기준 오늘 날짜 계산
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const today = kstNow.toISOString().split('T')[0]

  // 오늘 발행 현황
  const todayPublished = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM contents WHERE status = 'published' AND DATE(created_at) = ?"
  ).bind(today).first()

  // 오늘 생성된 콘텐츠 (발행 여부 무관)
  const todayGenerated = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM contents WHERE DATE(created_at) = ?"
  ).bind(today).first()

  // 오늘 스케줄
  const scheduleRow = await c.env.DB.prepare(
    "SELECT posts_per_day FROM schedules WHERE name = 'default'"
  ).first()

  // 총 누적 발행
  const totalPublished = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM contents WHERE status = 'published'"
  ).first()

  // 총 콘텐츠 수
  const totalContents = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM contents"
  ).first()

  // 대기 중 콘텐츠 (draft)
  const draftCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM contents WHERE status = 'draft'"
  ).first()

  // 평균 SEO 점수
  const avgSeo = await c.env.DB.prepare(
    "SELECT ROUND(AVG(seo_score), 1) as avg_score FROM contents WHERE seo_score > 0"
  ).first()

  // SEO 점수 분포
  const seoDistribution = await c.env.DB.prepare(
    `SELECT 
       SUM(CASE WHEN seo_score >= 90 THEN 1 ELSE 0 END) as excellent,
       SUM(CASE WHEN seo_score >= 80 AND seo_score < 90 THEN 1 ELSE 0 END) as good,
       SUM(CASE WHEN seo_score >= 60 AND seo_score < 80 THEN 1 ELSE 0 END) as average,
       SUM(CASE WHEN seo_score < 60 THEN 1 ELSE 0 END) as poor
     FROM contents WHERE seo_score > 0`
  ).first()

  // 발행 성공률 (전체)
  const totalLogs = await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM publish_logs").first()
  const successLogs = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM publish_logs WHERE status = 'published'"
  ).first()
  const failedLogs = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM publish_logs WHERE status = 'failed'"
  ).first()
  const successRate = (totalLogs?.cnt as number) > 0
    ? Math.round(((successLogs?.cnt as number) / (totalLogs?.cnt as number)) * 100)
    : 0

  // 주간 발행 데이터 (7일)
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

  // 30일 트렌드 데이터 (일별 발행 건수)
  const monthlyTrend = await c.env.DB.prepare(
    `SELECT DATE(created_at) as date, COUNT(*) as cnt 
     FROM contents WHERE status = 'published' AND created_at >= datetime('now', '-30 days')
     GROUP BY DATE(created_at) ORDER BY date`
  ).all()

  const monthlyLabels: string[] = []
  const monthlyCounts: number[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().split('T')[0]
    monthlyLabels.push(`${d.getMonth() + 1}/${d.getDate()}`)
    const found = monthlyTrend.results.find((r: any) => r.date === dateStr)
    monthlyCounts.push(found ? (found as any).cnt : 0)
  }

  // 카테고리별 분포 (발행된 콘텐츠)
  const categoryData = await c.env.DB.prepare(
    `SELECT k.category, COUNT(*) as cnt 
     FROM contents c JOIN keywords k ON c.keyword_id = k.id 
     WHERE c.status = 'published'
     GROUP BY k.category`
  ).all()
  const categoryCounts: Record<string, number> = {}
  categoryData.results.forEach((r: any) => { categoryCounts[r.category] = r.cnt })

  // 키워드 현황
  const keywordStats = await c.env.DB.prepare(
    `SELECT 
       COUNT(*) as total,
       SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
       SUM(CASE WHEN used_count = 0 AND is_active = 1 THEN 1 ELSE 0 END) as unused,
       SUM(used_count) as total_uses
     FROM keywords`
  ).first()

  // 카테고리별 키워드 소진율
  const kwByCat = await c.env.DB.prepare(
    `SELECT category, 
       COUNT(*) as total, 
       SUM(CASE WHEN used_count > 0 THEN 1 ELSE 0 END) as used
     FROM keywords WHERE is_active = 1 
     GROUP BY category`
  ).all()
  const keywordUsageByCategory: Record<string, { total: number; used: number; rate: number }> = {}
  kwByCat.results.forEach((r: any) => {
    keywordUsageByCategory[r.category] = {
      total: r.total,
      used: r.used,
      rate: r.total > 0 ? Math.round((r.used / r.total) * 100) : 0
    }
  })

  // 다음 발행 예정 키워드 (사용 횟수 적고 우선순위 높은 것)
  const upcoming = await c.env.DB.prepare(
    `SELECT k.id, k.keyword, k.category, k.priority, k.used_count FROM keywords k 
     WHERE k.is_active = 1 
     ORDER BY k.used_count ASC, k.priority DESC 
     LIMIT 5`
  ).all()

  // 최근 실패
  const failures = await c.env.DB.prepare(
    `SELECT pl.id, pl.error_message, pl.retry_count, pl.created_at, c.keyword_text, c.title
     FROM publish_logs pl JOIN contents c ON pl.content_id = c.id 
     WHERE pl.status = 'failed' 
     ORDER BY pl.created_at DESC LIMIT 5`
  ).all()

  // 최근 성공 발행 5건
  const recentSuccess = await c.env.DB.prepare(
    `SELECT pl.inblog_url, pl.published_at, c.title, c.keyword_text, c.seo_score
     FROM publish_logs pl JOIN contents c ON pl.content_id = c.id 
     WHERE pl.status = 'published' 
     ORDER BY pl.published_at DESC LIMIT 5`
  ).all()

  // 일일 리포트 데이터 (오늘)
  const dailyReport = {
    date: today,
    generated: todayGenerated?.cnt || 0,
    published: todayPublished?.cnt || 0,
    scheduled: scheduleRow?.posts_per_day || 5,
    completion_rate: (scheduleRow?.posts_per_day as number) > 0
      ? Math.round(((todayPublished?.cnt as number || 0) / (scheduleRow?.posts_per_day as number)) * 100)
      : 0
  }

  return c.json({
    // 기본 통계
    today_published: todayPublished?.cnt || 0,
    today_generated: todayGenerated?.cnt || 0,
    today_scheduled: scheduleRow?.posts_per_day || 5,
    total_published: totalPublished?.cnt || 0,
    total_contents: totalContents?.cnt || 0,
    draft_count: draftCount?.cnt || 0,
    avg_seo_score: avgSeo?.avg_score || 0,
    success_rate: successRate,
    failed_count: failedLogs?.cnt || 0,

    // SEO 점수 분포
    seo_distribution: {
      excellent: seoDistribution?.excellent || 0,
      good: seoDistribution?.good || 0,
      average: seoDistribution?.average || 0,
      poor: seoDistribution?.poor || 0
    },

    // 차트 데이터
    weekly_labels: weeklyLabels,
    weekly_counts: weeklyCounts,
    monthly_labels: monthlyLabels,
    monthly_counts: monthlyCounts,
    category_counts: categoryCounts,

    // 키워드 현황
    keyword_stats: {
      total: keywordStats?.total || 0,
      active: keywordStats?.active || 0,
      unused: keywordStats?.unused || 0,
      total_uses: keywordStats?.total_uses || 0,
      usage_by_category: keywordUsageByCategory
    },

    // 목록
    upcoming: upcoming.results.map((k: any) => ({
      id: k.id,
      keyword: k.keyword,
      category: k.category,
      priority: k.priority,
      used_count: k.used_count,
      scheduled_time: '예정'
    })),
    recent_failures: failures.results,
    recent_success: recentSuccess.results,

    // 일일 리포트
    daily_report: dailyReport
  })
})

export { dashboardRoutes }
