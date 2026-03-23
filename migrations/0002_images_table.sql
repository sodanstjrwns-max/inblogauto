CREATE TABLE IF NOT EXISTS generated_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER,
  keyword TEXT NOT NULL,
  image_type TEXT NOT NULL DEFAULT 'thumbnail',
  prompt TEXT,
  image_data BLOB,
  mime_type TEXT DEFAULT 'image/png',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (content_id) REFERENCES contents(id)
);

CREATE INDEX IF NOT EXISTS idx_images_content ON generated_images(content_id, image_type);
