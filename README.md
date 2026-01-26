# 철의장재 PR 분석 AI Agent

## 프로젝트 개요
- **Name**: 철의장재 PR 분석 AI Agent (PoC Demo)
- **Goal**: AI Agent의 PR 분석 과정을 시각적으로 보여주는 데모 UI
- **Client**: 세창앰앤이 단가계약

## 주요 기능

### 1. PR 목록 관리
- 81건의 PR 데이터 표시
- 분석 상태별 표시 (미분석/분석중/완료/오류)
- 최종분류 결과 배지 표시

### 2. 3단계 분석 과정 시각화
- **STEP 1 (Input)**: PR 기본 정보 표시
  - PR No, 자재내역, 자재속성, 재질 등
  - 현재/SYS/PR 유형코드 비교
  
- **STEP 2 (AI Agent 추론)**: Claude API 호출 과정
  - System Prompt 요약
  - User Prompt 요약
  - 처리 상태 및 소요 시간

- **STEP 3 (Output)**: 분석 결과
  - 단가존재여부 + 근거
  - 유형코드 검증 결과
  - 최종분류 및 종합의견

### 3. 통계 대시보드
- 총 분석 건수
- 물량검토 / 견적대상 / HITL필요 분류
- 자동처리율 계산

### 4. 분석 실행
- 단건 분석: 선택된 PR 1건 분석
- 전체 분석: 모든 PR 순차 분석
- 초기화: 분석 결과 리셋

## 기술 스택
- **Backend**: Hono (TypeScript)
- **Frontend**: TailwindCSS (CDN), Vanilla JavaScript
- **AI**: Claude API (claude-sonnet-4-20250514)
- **Deployment**: Cloudflare Pages

## API Endpoints

| Endpoint | Method | 설명 |
|----------|--------|------|
| `/api/pr-list` | GET | PR 목록 조회 |
| `/api/pr/:prNo` | GET | PR 상세 정보 |
| `/api/price-table` | GET | 단가테이블 정보 |
| `/api/statistics` | GET | 통계 정보 |
| `/api/prompts/:prNo` | GET | System/User Prompt |
| `/api/analyze/:prNo` | POST | 단건 분석 실행 |
| `/api/reset` | POST | 분석 결과 초기화 |

## 로컬 개발

```bash
# 의존성 설치
npm install

# 빌드
npm run build

# 개발 서버 (PM2)
pm2 start ecosystem.config.cjs

# 테스트
curl http://localhost:3000/api/pr-list
```

## 환경 변수

| 변수 | 설명 |
|------|------|
| `ANTHROPIC_API_KEY` | Claude API 키 (필수) |

## Cloudflare 배포

```bash
# 빌드 및 배포
npm run build
npx wrangler pages deploy dist --project-name pr-analysis-agent

# Secret 설정
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name pr-analysis-agent
```

## 데이터 구조

### PR 데이터 (81건)
- 대표PR, 자재내역, 자재속성, 재질, 철의장유형코드 등

### 단가테이블 (7개 자재속성그룹)
- PQPA: PIPE SUPPORT ACCOMM. AREA
- PQPD: PIPE SUPPORT HULL AREA
- PQPG: PIPE SUPPORT FOR GRE/GRP
- PQPM: PIPE SUPPORT MACHINERY AREA
- PQPS: PIPE SUPPORT
- PQPU: PIPE SUPPORT FOR UNIT
- PQPC: PIPE COAMING

### 철의장상세구분 코드
- B: 상선 기본(SS400)
- A: SUS304L(ANGLE, PLATE)
- S: SUS316L(ANGLE, PLATE)
- G: BENDING류(COVER류, BOX류)
- I: PIPE, SQ. TUBE, BEAM TYPE
- M: SUS316L(PIPE)
- N: CHECK PLATE 소요
- E: COAMING (SUS316L) - PQPC 전용

## 배포 상태
- **Platform**: Cloudflare Pages
- **Status**: 개발 완료
- **Last Updated**: 2026-01-26
