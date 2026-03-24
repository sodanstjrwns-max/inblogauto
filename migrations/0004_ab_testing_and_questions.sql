-- A/B 타이틀 테스팅 테이블
CREATE TABLE IF NOT EXISTS title_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER NOT NULL,
  variant_label TEXT NOT NULL DEFAULT 'A',  -- A, B, C
  title TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,  -- 현재 활성 타이틀 여부
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  activated_at DATETIME,
  FOREIGN KEY (content_id) REFERENCES contents(id)
);

CREATE INDEX IF NOT EXISTS idx_title_variants_content ON title_variants(content_id);

-- 환자 질문 크롤링 결과 저장
CREATE TABLE IF NOT EXISTS patient_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'naver_kin',  -- naver_kin, google_paa, manual
  query TEXT NOT NULL,
  question TEXT NOT NULL,
  answer_preview TEXT,
  category TEXT DEFAULT 'general',
  keyword_match TEXT,
  is_used INTEGER DEFAULT 0,  -- 키워드 DB에 반영됨
  relevance_score REAL DEFAULT 0.0,
  crawled_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_patient_questions_category ON patient_questions(category);
CREATE INDEX IF NOT EXISTS idx_patient_questions_used ON patient_questions(is_used);

-- 사이트맵 제출 로그
CREATE TABLE IF NOT EXISTS sitemap_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_engine TEXT NOT NULL,
  url TEXT NOT NULL,
  status_code INTEGER,
  response TEXT,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
