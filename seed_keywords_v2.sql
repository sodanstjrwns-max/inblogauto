-- ============================================================
-- 환자 질문형 롱테일 키워드 200개+ (2026-03-23 추가분)
-- 환자가 새벽에 폰으로 실제 검색할 법한 구어체 키워드
-- ============================================================

-- ===== implant (임플란트) — 60개 =====
INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority) VALUES
-- 비용/보험 질문
('임플란트 가격 평균 2026', 'implant', '비용', 'info', 85),
('임플란트 보험 적용 조건', 'implant', '보험', 'info', 90),
('임플란트 실비 청구 방법', 'implant', '보험', 'info', 80),
('65세 임플란트 건강보험', 'implant', '보험', 'info', 90),
('임플란트 1개 가격', 'implant', '비용', 'info', 85),
('전체 임플란트 비용', 'implant', '비용', 'info', 80),
('임플란트 할부 가능한지', 'implant', '비용', 'info', 70),

-- 수술 과정/통증 질문
('임플란트 수술 시간 얼마나', 'implant', '과정', 'info', 85),
('임플란트 마취 안 풀렸을 때', 'implant', '회복', 'info', 75),
('임플란트 수술 후 피 멈추는 법', 'implant', '회복', 'info', 80),
('임플란트 후 라면 먹어도 되나요', 'implant', '회복', 'info', 75),
('임플란트 후 술 언제부터', 'implant', '회복', 'info', 80),
('임플란트 후 운동 언제부터', 'implant', '회복', 'info', 75),
('임플란트 후 담배 피면', 'implant', '회복', 'info', 80),
('임플란트 2차 수술 아픈가요', 'implant', '과정', 'info', 75),
('임플란트 뼈이식 안 하면', 'implant', '과정', 'info', 80),
('임플란트 뼈이식 후 붓기', 'implant', '회복', 'info', 75),
('임플란트 실패 확률', 'implant', '위험', 'info', 80),
('임플란트 실패 증상', 'implant', '위험', 'info', 85),
('임플란트 흔들리면', 'implant', '문제', 'info', 85),
('임플란트 주위염 증상', 'implant', '문제', 'info', 80),
('임플란트 주위염 치료', 'implant', '문제', 'info', 80),
('임플란트 냄새 나는 이유', 'implant', '문제', 'info', 70),
('임플란트 나사 풀림', 'implant', '문제', 'info', 75),

-- 선택/비교
('임플란트 vs 브릿지 뭐가 좋나요', 'implant', '비교', 'comparison', 85),
('임플란트 vs 틀니 장단점', 'implant', '비교', 'comparison', 85),
('오스템 vs 스트라우만 차이', 'implant', '비교', 'comparison', 80),
('임플란트 브랜드 중요한가요', 'implant', '선택', 'info', 75),
('치과마다 임플란트 가격 다른 이유', 'implant', '비용', 'info', 80),
('임플란트 잘하는 치과 고르는 법', 'implant', '선택', 'info', 85),

-- 특수 상황
('당뇨 환자 임플란트 가능', 'implant', '특수', 'info', 80),
('고혈압 임플란트 위험', 'implant', '특수', 'info', 75),
('골다공증 임플란트', 'implant', '특수', 'info', 75),
('흡연자 임플란트 성공률', 'implant', '특수', 'info', 75),
('20대 임플란트 해도 되나요', 'implant', '특수', 'info', 70),
('70대 임플란트 괜찮을까', 'implant', '특수', 'info', 75),
('앞니 임플란트 티 나나요', 'implant', '심미', 'info', 80),
('임플란트 크라운 종류', 'implant', '보철', 'info', 75),
('지르코니아 크라운 수명', 'implant', '보철', 'info', 75),

-- 관리/수명
('임플란트 관리 방법', 'implant', '관리', 'info', 80),
('임플란트 칫솔질 방법', 'implant', '관리', 'info', 75),
('임플란트 치간칫솔 사용법', 'implant', '관리', 'info', 70),
('임플란트 정기검진 주기', 'implant', '관리', 'info', 70),
('임플란트 10년 후', 'implant', '수명', 'info', 80),
('임플란트 재수술 비용', 'implant', '비용', 'info', 75),

-- 불안/공포
('임플란트 무섭다', 'implant', '불안', 'info', 80),
('임플란트 수술 안 아픈가요', 'implant', '불안', 'info', 85),
('임플란트 마취 방법', 'implant', '과정', 'info', 75),
('수면 임플란트 비용', 'implant', '과정', 'info', 80),
('치과 공포증 임플란트', 'implant', '불안', 'info', 75),

-- 충청권 지역 롱테일
('대전 임플란트 잘하는 곳', 'implant', '지역', 'local', 85),
('세종시 임플란트 추천', 'implant', '지역', 'local', 80),
('청주 임플란트 가격', 'implant', '지역', 'local', 80),
('천안 임플란트 후기', 'implant', '지역', 'local', 75),
('아산 임플란트 비용', 'implant', '지역', 'local', 70),

-- 디지털/네비게이션
('네비게이션 임플란트', 'implant', '기술', 'info', 70),
('디지털 가이드 임플란트', 'implant', '기술', 'info', 65),
('즉시 임플란트 장단점', 'implant', '과정', 'info', 75),
('무절개 임플란트', 'implant', '과정', 'info', 75),
('원데이 임플란트 후기', 'implant', '과정', 'info', 70);

-- ===== orthodontics (교정) — 45개 =====
INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority) VALUES
('투명교정 vs 일반교정', 'orthodontics', '비교', 'comparison', 85),
('인비절라인 가격 2026', 'orthodontics', '비용', 'info', 85),
('투명교정 효과 없다는데', 'orthodontics', '불안', 'info', 80),
('성인교정 30대 늦은가요', 'orthodontics', '연령', 'info', 80),
('40대 치아교정 후회', 'orthodontics', '연령', 'info', 75),
('교정 발치 꼭 해야하나요', 'orthodontics', '과정', 'info', 85),
('교정 발치 4개 아프나요', 'orthodontics', '불안', 'info', 80),
('교정 중 음식 뭐 먹나요', 'orthodontics', '생활', 'info', 75),
('교정 중 양치 방법', 'orthodontics', '관리', 'info', 75),
('교정 중 충치 생기면', 'orthodontics', '문제', 'info', 70),
('교정 유지장치 꼭 해야하나요', 'orthodontics', '관리', 'info', 80),
('교정 후 유지장치 기간', 'orthodontics', '관리', 'info', 75),
('교정 후 치아 다시 벌어지면', 'orthodontics', '문제', 'info', 80),
('교정 비용 분할 납부', 'orthodontics', '비용', 'info', 70),
('교정 기간 단축 방법', 'orthodontics', '과정', 'info', 75),
('급속교정 부작용', 'orthodontics', '위험', 'info', 70),
('설측교정 장단점', 'orthodontics', '비교', 'info', 75),
('세라믹교정 착색', 'orthodontics', '관리', 'info', 65),
('교정 중 얼굴형 변화', 'orthodontics', '결과', 'info', 80),
('교정하면 주걱턱 나을까', 'orthodontics', '결과', 'info', 70),
('돌출입 교정 비용', 'orthodontics', '비용', 'info', 80),
('앞니 벌어짐 교정', 'orthodontics', '증상', 'info', 75),
('덧니 교정 방법', 'orthodontics', '과정', 'info', 75),
('앞니 삐뚤어짐 교정 비용', 'orthodontics', '비용', 'info', 75),
('교정 상담 뭘 물어봐야 하나요', 'orthodontics', '선택', 'info', 70),
('교정과 전문의 vs 일반치과', 'orthodontics', '선택', 'comparison', 75),

-- 라미네이트/미백 추가
('라미네이트 수명 몇 년', 'orthodontics', '심미', 'info', 80),
('라미네이트 가격 앞니 6개', 'orthodontics', '비용', 'info', 75),
('라미네이트 후회하는 사람', 'orthodontics', '불안', 'info', 75),
('라미네이트 vs 교정 뭐가 나을까', 'orthodontics', '비교', 'comparison', 80),
('치아 미백 집에서 하는 법', 'orthodontics', '미백', 'info', 75),
('미백 후 시린 이유', 'orthodontics', '미백', 'info', 70),
('전문가 미백 vs 자가 미백', 'orthodontics', '비교', 'comparison', 70),
('누런 이 하얗게 하는 법', 'orthodontics', '미백', 'info', 80),

-- 소아교정
('아이 교정 몇 살부터', 'orthodontics', '소아', 'info', 80),
('초등학생 교정 시기', 'orthodontics', '소아', 'info', 80),
('아이 교정 비용', 'orthodontics', '소아', 'info', 75),
('소아교정 vs 성인교정 차이', 'orthodontics', '소아', 'comparison', 70),

-- 지역
('대전 교정 잘하는 곳', 'orthodontics', '지역', 'local', 80),
('세종시 투명교정', 'orthodontics', '지역', 'local', 70),
('청주 치아교정 비용', 'orthodontics', '지역', 'local', 70),

-- 교정 불안
('교정 아프면 어떡하나요', 'orthodontics', '불안', 'info', 75),
('교정 장치 삼켰을 때', 'orthodontics', '응급', 'info', 65),
('교정 와이어 찔릴 때 응급처치', 'orthodontics', '응급', 'info', 70),
('교정 중 입냄새 심해요', 'orthodontics', '문제', 'info', 65);

-- ===== general (일반치과) — 55개 =====
INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority) VALUES
-- 충치 질문형
('충치 방치하면 어떻게 되나요', 'general', '충치', 'info', 85),
('충치 초기 증상', 'general', '충치', 'info', 85),
('충치 자연치유 가능한가요', 'general', '충치', 'info', 80),
('충치 치료 안 하면', 'general', '충치', 'info', 80),
('충치 치료 비용 2026', 'general', '충치', 'info', 80),
('이가 시리면 충치인가요', 'general', '충치', 'info', 85),
('어금니 충치 심하면', 'general', '충치', 'info', 75),

-- 신경치료
('신경치료 후 이가 아파요', 'general', '신경치료', 'info', 85),
('신경치료 몇 번 가야하나요', 'general', '신경치료', 'info', 80),
('신경치료 후 크라운 꼭 해야하나요', 'general', '신경치료', 'info', 85),
('신경치료 후 밥 언제 먹나요', 'general', '신경치료', 'info', 75),
('신경치료 실패 증상', 'general', '신경치료', 'info', 75),
('재신경치료 비용', 'general', '신경치료', 'info', 70),

-- 사랑니
('사랑니 꼭 빼야 하나요', 'general', '발치', 'info', 90),
('사랑니 발치 후 음식', 'general', '발치', 'info', 85),
('사랑니 발치 후 피 안 멈춤', 'general', '발치', 'info', 80),
('사랑니 발치 다음날 출근', 'general', '발치', 'info', 80),
('매복 사랑니 발치 비용', 'general', '발치', 'info', 80),
('사랑니 4개 한번에 발치', 'general', '발치', 'info', 75),
('사랑니 발치 후 건조 소켓', 'general', '발치', 'info', 75),
('사랑니 발치 후 노란색', 'general', '발치', 'info', 65),

-- 잇몸
('잇몸에서 피 나는 이유', 'general', '잇몸', 'info', 85),
('잇몸 내려앉음 치료', 'general', '잇몸', 'info', 80),
('치주염 증상 자가진단', 'general', '잇몸', 'info', 80),
('치주염 vs 치은염 차이', 'general', '잇몸', 'comparison', 75),
('잇몸 수술 비용', 'general', '잇몸', 'info', 75),
('잇몸 뼈 녹으면 치료', 'general', '잇몸', 'info', 75),
('치석 제거 후 이가 시려요', 'general', '잇몸', 'info', 80),

-- 크라운/보철
('크라운 씌우는 이유', 'general', '보철', 'info', 80),
('크라운 종류 비교', 'general', '보철', 'comparison', 75),
('크라운 탈락 응급처치', 'general', '보철', 'info', 80),
('크라운 안에 충치', 'general', '보철', 'info', 75),
('금 크라운 가격 2026', 'general', '보철', 'info', 75),
('지르코니아 크라운 장단점', 'general', '보철', 'info', 75),
('인레이 vs 크라운 차이', 'general', '보철', 'comparison', 75),

-- 통증/응급
('치통 응급처치 방법', 'general', '응급', 'info', 90),
('밤에 이가 아플 때 대처법', 'general', '응급', 'info', 90),
('이 부러졌을 때 응급처치', 'general', '응급', 'info', 85),
('치아 빠졌을 때 보관법', 'general', '응급', 'info', 80),
('턱관절 통증 원인', 'general', '턱관절', 'info', 80),
('턱관절 소리 괜찮은가요', 'general', '턱관절', 'info', 75),
('이갈이 원인과 치료', 'general', '턱관절', 'info', 75),

-- 보험/비용
('치과 건강보험 적용 항목', 'general', '보험', 'info', 85),
('치과 비급여 항목 정리', 'general', '보험', 'info', 80),
('치과 실비 청구 가능한 것', 'general', '보험', 'info', 80),

-- 기타 일반
('치과 마취 부작용', 'general', '마취', 'info', 75),
('치과 수면치료 비용', 'general', '마취', 'info', 75),
('웃을 때 잇몸 많이 보이는 거니 스마일', 'general', '심미', 'info', 70),
('치아 갈라짐 치료', 'general', '증상', 'info', 75),
('치아 변색 원인', 'general', '심미', 'info', 70),
('혀 갈라짐 원인', 'general', '기타', 'info', 60),
('구강 궤양 안 낫는 이유', 'general', '기타', 'info', 60),
('입안 하얀 덩어리', 'general', '기타', 'info', 60),
('양치 후에도 입냄새', 'general', '증상', 'info', 75);

-- ===== prevention (예방치과) — 25개 =====
INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority) VALUES
('올바른 칫솔질 방법', 'prevention', '구강위생', 'info', 80),
('전동칫솔 vs 일반칫솔', 'prevention', '구강위생', 'comparison', 75),
('치실 사용법 쉽게', 'prevention', '구강위생', 'info', 75),
('치간칫솔 사이즈 고르는 법', 'prevention', '구강위생', 'info', 70),
('워터픽 효과 있나요', 'prevention', '구강위생', 'info', 70),
('불소 도포 효과', 'prevention', '예방', 'info', 70),
('실란트 몇 살까지', 'prevention', '소아', 'info', 75),
('아이 첫 치과 검진 시기', 'prevention', '소아', 'info', 80),
('유치 충치 치료 꼭 해야하나요', 'prevention', '소아', 'info', 85),
('아이 이 닦기 싫어할 때', 'prevention', '소아', 'info', 70),
('스케일링 아프나요', 'prevention', '스케일링', 'info', 80),
('스케일링 후 주의사항', 'prevention', '스케일링', 'info', 80),
('스케일링 보험 적용 횟수', 'prevention', '스케일링', 'info', 85),
('잇몸 건강 음식', 'prevention', '영양', 'info', 65),
('치아에 좋은 음식 나쁜 음식', 'prevention', '영양', 'info', 70),
('탄산음료 치아 영향', 'prevention', '영양', 'info', 65),
('치아 건강 영양제', 'prevention', '영양', 'info', 65),
('임산부 치과 치료 시기', 'prevention', '특수', 'info', 80),
('임산부 스케일링 가능', 'prevention', '특수', 'info', 75),
('당뇨 환자 잇몸 관리', 'prevention', '특수', 'info', 70),
('치과 정기검진 주기', 'prevention', '검진', 'info', 75),
('파노라마 엑스레이 방사선 괜찮나요', 'prevention', '검진', 'info', 70),
('구강검진 뭘 보나요', 'prevention', '검진', 'info', 65),
('치과 무서워서 안 가는 사람', 'prevention', '불안', 'info', 75),
('치과 공포증 극복 방법', 'prevention', '불안', 'info', 80);

-- ===== local (지역) — 25개 =====
INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority) VALUES
('대전 치과 추천', 'local', '대전', 'local', 90),
('세종시 치과 잘하는 곳', 'local', '세종', 'local', 85),
('청주 치과 추천 2026', 'local', '청주', 'local', 85),
('천안 치과 야간진료', 'local', '천안', 'local', 80),
('아산 치과 주말진료', 'local', '아산', 'local', 75),
('대전 야간 치과 어디', 'local', '대전', 'local', 80),
('대전 주말 치과', 'local', '대전', 'local', 80),
('세종시 소아치과 추천', 'local', '세종', 'local', 80),
('대전 소아치과 잘하는 곳', 'local', '대전', 'local', 80),
('청주 교정 잘하는 치과', 'local', '청주', 'local', 75),
('대전 충치치료 잘하는 곳', 'local', '대전', 'local', 75),
('세종 임플란트 가격', 'local', '세종', 'local', 80),
('대전 스케일링 보험', 'local', '대전', 'local', 70),
('천안 사랑니 발치', 'local', '천안', 'local', 70),
('논산 치과', 'local', '논산', 'local', 65),
('공주 치과 추천', 'local', '공주', 'local', 65),
('서산 치과', 'local', '서산', 'local', 60),
('당진 치과 추천', 'local', '당진', 'local', 60),
('홍성 치과', 'local', '홍성', 'local', 55),
('충주 치과 추천', 'local', '충주', 'local', 60),
('제천 치과', 'local', '제천', 'local', 55),
('보령 치과', 'local', '보령', 'local', 55),
('치과 고르는 기준', 'local', '선택', 'info', 80),
('좋은 치과 구별법', 'local', '선택', 'info', 80),
('치과 상담 시 체크리스트', 'local', '선택', 'info', 75);
