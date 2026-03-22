-- Inblog Autopublish SaaS - Initial Schema
-- 키워드, 콘텐츠, 발행이력, 스케줄, 설정 관리

-- 키워드 DB
CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  subcategory TEXT,
  search_intent TEXT NOT NULL DEFAULT 'info',
  region TEXT,
  priority INTEGER NOT NULL DEFAULT 50,
  used_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  is_custom INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 생성된 콘텐츠
CREATE TABLE IF NOT EXISTS contents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id INTEGER NOT NULL,
  keyword_text TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  meta_description TEXT NOT NULL,
  content_html TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  faq_json TEXT NOT NULL DEFAULT '[]',
  thumbnail_url TEXT,
  thumbnail_prompt TEXT,
  seo_score INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  generation_attempts INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (keyword_id) REFERENCES keywords(id)
);

-- 발행 이력
CREATE TABLE IF NOT EXISTS publish_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER NOT NULL,
  inblog_post_id TEXT,
  inblog_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_at TEXT NOT NULL,
  published_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (content_id) REFERENCES contents(id)
);

-- 스케줄 설정
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT 'default',
  posts_per_day INTEGER NOT NULL DEFAULT 3,
  publish_times TEXT NOT NULL DEFAULT '["07:00","12:00","18:00"]',
  category_weights TEXT NOT NULL DEFAULT '{"implant":30,"orthodontics":20,"general":25,"prevention":15,"local":10}',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 사이트 설정
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 일간 리포트
CREATE TABLE IF NOT EXISTS daily_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL UNIQUE,
  total_scheduled INTEGER NOT NULL DEFAULT 0,
  total_published INTEGER NOT NULL DEFAULT 0,
  total_failed INTEGER NOT NULL DEFAULT 0,
  total_retried INTEGER NOT NULL DEFAULT 0,
  avg_seo_score REAL NOT NULL DEFAULT 0,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_keywords_category ON keywords(category);
CREATE INDEX IF NOT EXISTS idx_keywords_active ON keywords(is_active);
CREATE INDEX IF NOT EXISTS idx_keywords_used ON keywords(used_count, last_used_at);
CREATE INDEX IF NOT EXISTS idx_contents_status ON contents(status);
CREATE INDEX IF NOT EXISTS idx_contents_keyword ON contents(keyword_id);
CREATE INDEX IF NOT EXISTS idx_contents_created ON contents(created_at);
CREATE INDEX IF NOT EXISTS idx_publish_status ON publish_logs(status);
CREATE INDEX IF NOT EXISTS idx_publish_scheduled ON publish_logs(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_publish_content ON publish_logs(content_id);
CREATE INDEX IF NOT EXISTS idx_daily_reports_date ON daily_reports(report_date);
