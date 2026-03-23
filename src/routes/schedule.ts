import { Hono } from 'hono'
import type { Bindings } from '../index'

const scheduleRoutes = new Hono<{ Bindings: Bindings }>()

// GET /api/schedule - 스케줄 조회
scheduleRoutes.get('/', async (c) => {
  let schedule: any = await c.env.DB.prepare("SELECT * FROM schedules WHERE name = 'default'").first()

  if (!schedule) {
    await c.env.DB.prepare(
      `INSERT INTO schedules (name, posts_per_day, publish_times, category_weights) VALUES ('default', 5, '["02:00","03:00","04:00","05:00","05:30"]', '{"implant":30,"orthodontics":25,"general":25,"prevention":15,"local":5}')`
    ).run()
    schedule = await c.env.DB.prepare("SELECT * FROM schedules WHERE name = 'default'").first()
  }

  return c.json({
    ...schedule,
    publish_times: JSON.parse(schedule.publish_times || '[]'),
    category_weights: JSON.parse(schedule.category_weights || '{}')
  })
})

// PUT /api/schedule - 스케줄 수정
scheduleRoutes.put('/', async (c) => {
  const body = await c.req.json()
  const { posts_per_day, publish_times, category_weights } = body

  await c.env.DB.prepare(
    `UPDATE schedules SET 
      posts_per_day = ?, 
      publish_times = ?, 
      category_weights = ?,
      updated_at = datetime('now')
     WHERE name = 'default'`
  ).bind(
    posts_per_day || 3,
    JSON.stringify(publish_times || ['07:00', '12:00', '18:00']),
    JSON.stringify(category_weights || {})
  ).run()

  return c.json({ success: true })
})

export { scheduleRoutes }
