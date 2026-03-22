import { Hono } from 'hono'
import type { Bindings } from '../index'

const keywordRoutes = new Hono<{ Bindings: Bindings }>()

// GET /api/keywords - 키워드 목록 조회
keywordRoutes.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '100')
  const offset = parseInt(c.req.query('offset') || '0')
  const category = c.req.query('category') || ''
  const search = c.req.query('search') || ''

  let query = 'SELECT * FROM keywords WHERE 1=1'
  const params: any[] = []

  if (category) {
    query += ' AND category = ?'
    params.push(category)
  }
  if (search) {
    query += ' AND keyword LIKE ?'
    params.push(`%${search}%`)
  }

  query += ' ORDER BY priority DESC, used_count ASC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const result = await c.env.DB.prepare(query).bind(...params).all()
  const countResult = await c.env.DB.prepare('SELECT COUNT(*) as total FROM keywords').first()

  return c.json({
    keywords: result.results,
    total: countResult?.total || 0
  })
})

// GET /api/keywords/stats - 키워드 통계
keywordRoutes.get('/stats', async (c) => {
  const total = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM keywords').first()
  const active = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM keywords WHERE is_active = 1').first()
  const byCategory = await c.env.DB.prepare(
    'SELECT category, COUNT(*) as cnt FROM keywords GROUP BY category'
  ).all()

  return c.json({
    total: total?.cnt || 0,
    active: active?.cnt || 0,
    by_category: byCategory.results
  })
})

// POST /api/keywords - 키워드 추가
keywordRoutes.post('/', async (c) => {
  const body = await c.req.json()
  const { keyword, category, search_intent, priority, region } = body

  if (!keyword) return c.json({ error: '키워드를 입력하세요' }, 400)

  const result = await c.env.DB.prepare(
    'INSERT INTO keywords (keyword, category, search_intent, priority, region, is_custom) VALUES (?, ?, ?, ?, ?, 1)'
  ).bind(keyword, category || 'general', search_intent || 'info', priority || 50, region || null).run()

  return c.json({ id: result.meta.last_row_id, success: true })
})

// PATCH /api/keywords/:id - 키워드 수정
keywordRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()

  const fields: string[] = []
  const values: any[] = []

  for (const [key, val] of Object.entries(body)) {
    if (['keyword', 'category', 'search_intent', 'priority', 'region', 'is_active'].includes(key)) {
      fields.push(`${key} = ?`)
      values.push(val)
    }
  }

  if (!fields.length) return c.json({ error: '변경할 항목이 없습니다' }, 400)

  fields.push("updated_at = datetime('now')")
  values.push(id)

  await c.env.DB.prepare(`UPDATE keywords SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run()
  return c.json({ success: true })
})

// DELETE /api/keywords/:id - 키워드 삭제
keywordRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM keywords WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// POST /api/keywords/pick - 오늘 발행할 키워드 자동 선택
keywordRoutes.post('/pick', async (c) => {
  const body = await c.req.json()
  const count = body.count || 3
  const categoryWeights = body.category_weights || { implant: 30, orthodontics: 20, general: 25, prevention: 15, local: 10 }

  const picked: any[] = []
  const totalWeight = Object.values(categoryWeights).reduce((s: number, v: any) => s + v, 0)

  for (const [cat, weight] of Object.entries(categoryWeights)) {
    const catCount = Math.max(0, Math.round(count * (weight as number / totalWeight as number)))
    if (catCount === 0) continue

    const results = await c.env.DB.prepare(
      `SELECT * FROM keywords 
       WHERE is_active = 1 AND category = ?
       ORDER BY used_count ASC, priority DESC, RANDOM()
       LIMIT ?`
    ).bind(cat, catCount).all()

    picked.push(...results.results)
  }

  // 부족하면 추가로 랜덤 선택
  if (picked.length < count) {
    const excludeIds = picked.map(k => k.id).join(',') || '0'
    const extra = await c.env.DB.prepare(
      `SELECT * FROM keywords 
       WHERE is_active = 1 AND id NOT IN (${excludeIds})
       ORDER BY used_count ASC, priority DESC, RANDOM()
       LIMIT ?`
    ).bind(count - picked.length).all()
    picked.push(...extra.results)
  }

  return c.json({ keywords: picked.slice(0, count) })
})

export { keywordRoutes }
