-- 콘텐츠 성과 추적 테이블 (Google Search Console 연동 준비)
CREATE TABLE IF NOT EXISTS content_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  avg_position REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (content_id) REFERENCES contents(id),
  UNIQUE(content_id, date)
);

-- 콘텐츠 유형 기록 컬럼 추가 (A/B/C/D/E)
-- ALTER TABLE contents ADD COLUMN content_type TEXT DEFAULT 'B';
-- ALTER TABLE contents ADD COLUMN region TEXT DEFAULT '';

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_perf_content ON content_performance(content_id);
CREATE INDEX IF NOT EXISTS idx_perf_date ON content_performance(date);
CREATE INDEX IF NOT EXISTS idx_perf_impressions ON content_performance(impressions DESC);
