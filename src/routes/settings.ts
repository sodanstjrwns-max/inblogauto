import { Hono } from 'hono'
import type { Bindings } from '../index'

const settingsRoutes = new Hono<{ Bindings: Bindings }>()

// GET /api/settings - 설정 전체 조회
settingsRoutes.get('/', async (c) => {
  const result = await c.env.DB.prepare('SELECT * FROM settings ORDER BY key').all()
  return c.json({ settings: result.results })
})

// GET /api/settings/:key - 특정 설정 조회
settingsRoutes.get('/:key', async (c) => {
  const key = c.req.param('key')
  const result = await c.env.DB.prepare('SELECT * FROM settings WHERE key = ?').bind(key).first()
  return c.json({ setting: result })
})

// PUT /api/settings - 설정 일괄 저장
settingsRoutes.put('/', async (c) => {
  const body = await c.req.json()
  const { settings } = body

  if (!Array.isArray(settings)) {
    return c.json({ error: '설정 배열이 필요합니다' }, 400)
  }

  for (const { key, value } of settings) {
    if (!key) continue
    await c.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`
    ).bind(key, value || '', value || '').run()
  }

  return c.json({ success: true })
})

// PUT /api/settings/:key - 특정 설정 저장
settingsRoutes.put('/:key', async (c) => {
  const key = c.req.param('key')
  const body = await c.req.json()

  await c.env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`
  ).bind(key, body.value || '', body.value || '').run()

  return c.json({ success: true })
})

export { settingsRoutes }
