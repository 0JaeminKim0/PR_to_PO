import { Hono } from 'hono'
import { cors } from 'hono/cors'

// 데이터 임포트
import { prData } from './pr-data.js'
import { reviewData } from './review-data.js'
import { priceTableRaw, priceCodeList } from './price-table.js'
import { drawingMapping } from './drawing-mapping.js'

type Bindings = {
  ANTHROPIC_API_KEY?: string
}

// 제작사-도장사 매핑 테이블
const PAINTING_COMPANY_MAP: Record<string, string> = {
  "세창앰앤이(주)": "대림에스엔피",
  "(주)케이이엠": "진명에프앤피",
  "(주)동진테크": "피에스산업",
  "한빛이엔지": "성원기업",
  "한덕": "대림에스엔피"
}

// Sub Process 결과 타입
type SubProcessResult = {
  status: 'pending' | 'processing' | 'completed' | 'error'
  input?: Record<string, any>
  logic?: string
  output?: Record<string, any>
  error?: string
  processingTime?: number
}

// Phase 1 분석 결과 타입
type Phase1Result = {
  prNo: number
  status: 'pending' | 'analyzing' | 'completed' | 'error'
  subProcesses: {
    contractPrice: SubProcessResult      // Process 1
    typeCodeValidation: SubProcessResult // Process 2
    paintingRoute: SubProcessResult      // Process 3 (신규)
    orderDecision: SubProcessResult      // Process 4
  }
  finalResult?: {
    최종분류: string
    물량검토필요: string
  }
  error?: string
  totalProcessingTime?: number
}

// Phase 2 검증 결과 타입
type Phase2Result = {
  prNo: number
  status: 'pending' | 'verifying' | 'completed' | 'error'
  검토구분: string
  process5: SubProcessResult
  finalResult?: {
    검증결과: string
    권장조치: string
    검증근거: string
  }
  error?: string
  totalProcessingTime?: number
}

// 분석 결과 저장소
const phase1Results = new Map<number, Phase1Result>()
const phase2Results = new Map<number, Phase2Result>()

const app = new Hono<{ Bindings: Bindings }>()

// CORS 설정
app.use('/api/*', cors())

// ============================================================================
// Phase 1 API: PR 분석
// ============================================================================

// API: PR 목록 가져오기
app.get('/api/pr-list', (c) => {
  const prList = (prData as any[]).map((pr, index) => {
    const prNo = pr['대표PR']
    const result = phase1Results.get(prNo)
    return {
      index: index + 1,
      prNo,
      자재번호: pr['자재번호'],
      자재내역: pr['자재내역'],
      자재속성: pr['자재속성'],
      업체명: pr['업체명'],
      철의장유형코드: pr['철의장유형코드'],
      status: result?.status || 'pending',
      최종분류: result?.finalResult?.최종분류 || null
    }
  })
  return c.json({ total: prList.length, data: prList })
})

// API: 단건 PR 상세 정보
app.get('/api/pr/:prNo', (c) => {
  const prNo = parseInt(c.req.param('prNo'))
  const pr = (prData as any[]).find(p => p['대표PR'] === prNo)
  
  if (!pr) {
    return c.json({ error: 'PR not found' }, 404)
  }
  
  const result = phase1Results.get(prNo)
  
  return c.json({
    prNo: pr['대표PR'],
    자재번호: pr['자재번호'],
    자재내역: pr['자재내역'],
    자재속성: pr['자재속성'],
    재질: pr['재질'],
    도면번호: pr['도면번호'],
    철의장유형코드: pr['철의장유형코드'],
    업체명: pr['업체명'],
    도장사경유여부: pr['도장사경유여부'],
    외부도장: pr['외부도장'],
    부적정_권장코드: pr['부적정_권장코드'],
    부적정_사유: pr['부적정_사유'],
    analysis: result || null
  })
})

// API: 단가테이블 정보
app.get('/api/price-table', (c) => {
  return c.json({
    total: priceTableRaw.length,
    codes: priceCodeList,
    data: priceTableRaw.slice(0, 20) // 샘플만 반환
  })
})

// API: Phase 1 통계
app.get('/api/statistics/phase1', (c) => {
  const total = (prData as any[]).length
  let analyzed = 0
  let 물량검토 = 0
  let 견적대상 = 0
  let HITL필요 = 0
  let 유형코드부적정 = 0
  let 도장사경유 = 0
  
  for (const [_, result] of phase1Results) {
    if (result.status === 'completed' && result.finalResult) {
      analyzed++
      const 분류 = result.finalResult.최종분류
      if (분류?.includes('물량검토')) 물량검토++
      else if (분류?.includes('견적')) 견적대상++
      else HITL필요++
      
      // 유형코드 부적정 카운트
      if (result.subProcesses.typeCodeValidation?.output?.적정성 === '부적합') {
        유형코드부적정++
      }
      
      // 도장사 경유 카운트
      if (result.subProcesses.paintingRoute?.output?.도장사경유 === 'Y') {
        도장사경유++
      }
    }
  }
  
  const 자동처리 = 물량검토 + 견적대상
  
  return c.json({
    total,
    analyzed,
    물량검토,
    견적대상,
    HITL필요,
    유형코드부적정,
    도장사경유,
    자동처리율: analyzed > 0 ? ((자동처리 / analyzed) * 100).toFixed(1) : '0.0'
  })
})

// ============================================================================
// Phase 1: LLM 프롬프트 빌더
// ============================================================================

// Process 1: 계약단가 존재 확인
function buildProcess1SystemPrompt() {
  return `당신은 조선소 철의장재 구매 업무를 지원하는 AI Agent입니다.

## 역할
PR(구매요청)의 자재속성과 단가테이블을 비교하여 계약단가 존재 여부를 판단합니다.

## 판단 기준
- 자재속성이 단가테이블의 철의장상세구분 코드 목록에 해당하는 유형이면 "Y"
- 단가테이블 코드: ${priceCodeList.join(', ')}
- 자재속성 앞 1자리가 위 코드 중 하나면 해당 단가 계약 존재

## 응답 형식
반드시 아래 JSON 형식으로만 응답하세요.
\`\`\`json
{
    "계약단가존재": "Y 또는 N",
    "판단근거": "판단 이유",
    "추론과정": "어떻게 판단했는지 설명"
}
\`\`\``
}

function buildProcess1UserPrompt(pr: any) {
  return `## 검토 대상 PR
- 자재속성: ${pr['자재속성'] || '없음'}
- 자재내역: ${pr['자재내역'] || '없음'}

## 단가테이블 철의장상세구분 코드 목록
${priceCodeList.join(', ')}

위 자재속성이 단가테이블에 존재하는지 확인하세요.`
}

// Process 2: 철의장유형코드 검증
function buildProcess2SystemPrompt() {
  return `당신은 조선소 철의장재 구매 업무를 지원하는 AI Agent입니다.

## 역할
PR의 자재속성(철의장상세구분 코드)이 자재 특성에 적합한지 검증합니다.

## 철의장유형코드 정의
- B: 기본 상선 (Angle + Plate 단순 조합, PIPE SUPPORT 포함)
- G: BENDING류/COVER류/BOX류 (밴딩, 커버, 박스, COAMING 형태)
- I: PIPE/SQ.TUBE/BEAM TYPE (파이프 피스, 튜브 포함)
- N: CHECK PLATE 소요
- A: SUS304L - ANGLE/PLATE (재질 SUS304, STS304)
- S: SUS316L - ANGLE/PLATE (재질 SUS316, STS316)
- M: SUS316L - PIPE
- E: COAMING (SUS316L) - PQPC 전용

## 검증 기준
1. 자재속성 코드 앞 1자리가 유형코드
2. 자재내역, 재질 정보와 유형코드가 일치하는지 확인:
   - "PIPE PIECE" 또는 "PIPE("가 포함되면 → I (PIPE TYPE)
   - "COAMING", "COVER", "BOX", "BENDING"이 포함되면 → G
   - "PIPE SUPPORT"만 있으면 → B (기본)
   - 재질이 SUS304, STS304면 → A
   - 재질이 SUS316, STS316면 → S 또는 M(파이프)

## 응답 형식
\`\`\`json
{
    "현재유형코드": "추출된 유형코드",
    "적정여부": "적합 / 부적합 / 검토필요",
    "권장코드": "부적합 시 권장 코드 (적합이면 빈 문자열)",
    "판단근거": "판단 이유",
    "추론과정": "어떻게 판단했는지 설명"
}
\`\`\``
}

function buildProcess2UserPrompt(pr: any) {
  return `## 검토 대상 PR
- 자재속성: ${pr['자재속성'] || '없음'}
- 자재내역: ${pr['자재내역'] || '없음'}
- 재질: ${pr['재질'] || '없음'}
- 철의장유형코드: ${pr['철의장유형코드'] || '없음'}

자재속성에서 유형코드를 추출하고, 자재내역/재질과 비교하여 적합한지 검증하세요.`
}

// Process 3: 도장사 경유 및 지정
function buildProcess3SystemPrompt() {
  return `당신은 조선소 철의장재 구매 업무를 지원하는 AI Agent입니다.

## 역할
PR의 도장 정보를 확인하여 도장사 경유 여부를 판단합니다.

## 도장사 경유 판단 기준
- 도장사경유여부가 "Y"이면: 경유 Y (도장 필요)
- 도장사경유여부가 "N"이거나 공란이면: 경유 N (도장 불필요)
- 외부도장 값이 "N0"이면: 경유 N (도장 불필요)

## 응답 형식
\`\`\`json
{
    "도장사경유": "Y 또는 N",
    "판단근거": "판단 이유",
    "추론과정": "어떻게 판단했는지 설명"
}
\`\`\``
}

function buildProcess3UserPrompt(pr: any) {
  return `## 검토 대상 PR
- 도장사경유여부: ${pr['도장사경유여부'] || '없음'}
- 외부도장: ${pr['외부도장'] || '없음'}
- 업체명(제작사): ${pr['업체명'] || '없음'}

도장 정보를 확인하여 도장사 경유 여부를 판단하세요.`
}

// Process 4: 발주 방식 결정
function buildProcess4SystemPrompt() {
  return `당신은 조선소 철의장재 구매 업무를 지원하는 AI Agent입니다.

## 역할
이전 프로세스 결과를 종합하여 발주 방식을 결정합니다.

## 최종 분류 기준
1. 계약단가 미존재 → "견적대상" (물량검토 불필요)
2. 계약단가 존재 → "물량검토대상" (공급사 물량검토 필요)

## 응답 형식
\`\`\`json
{
    "최종분류": "견적대상 / 물량검토대상",
    "물량검토필요": "Y 또는 N",
    "판단근거": "판단 이유",
    "비고": "추가 참고사항 (유형코드 부적정 시 권장코드 안내 등)",
    "추론과정": "어떻게 판단했는지 설명"
}
\`\`\``
}

function buildProcess4UserPrompt(pr: any, p1: any, p2: any, p3: any) {
  return `## 검토 대상 PR
- 자재번호: ${pr['자재번호'] || '없음'}
- 자재내역: ${(pr['자재내역'] || '').substring(0, 50)}...

## 이전 프로세스 결과
[Process 1 - 계약단가]
- 계약단가존재: ${p1?.계약단가존재 || 'N/A'}

[Process 2 - 유형코드]
- 현재유형코드: ${p2?.현재유형코드 || 'N/A'}
- 적정여부: ${p2?.적정여부 || 'N/A'}
- 권장코드: ${p2?.권장코드 || '-'}

[Process 3 - 도장사]
- 도장사경유: ${p3?.도장사경유 || 'N/A'}
- 도장사: ${p3?.도장사 || '-'}

위 결과를 종합하여 최종 분류와 발주 방식을 결정하세요.`
}

// ============================================================================
// Phase 1 API: 분석 실행
// ============================================================================

app.post('/api/phase1/analyze/:prNo', async (c) => {
  const prNo = parseInt(c.req.param('prNo'))
  const pr = (prData as any[]).find(p => p['대표PR'] === prNo)
  
  if (!pr) {
    return c.json({ error: 'PR not found' }, 404)
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || c.env?.ANTHROPIC_API_KEY
  if (!apiKey) {
    return c.json({ 
      error: 'ANTHROPIC_API_KEY not configured',
      message: '환경 변수에 ANTHROPIC_API_KEY를 설정해주세요.'
    }, 500)
  }

  const startTime = Date.now()
  
  // 초기 상태 설정
  const initialResult: Phase1Result = {
    prNo,
    status: 'analyzing',
    subProcesses: {
      contractPrice: { status: 'processing' },
      typeCodeValidation: { status: 'pending' },
      paintingRoute: { status: 'pending' },
      orderDecision: { status: 'pending' }
    }
  }
  phase1Results.set(prNo, initialResult)

  try {
    // Process 1: 계약단가 존재 확인
    const p1Response = await callClaude(apiKey, buildProcess1SystemPrompt(), buildProcess1UserPrompt(pr))
    const p1Result = parseJsonResponse(p1Response)
    
    // Process 2: 철의장유형코드 검증
    const p2Response = await callClaude(apiKey, buildProcess2SystemPrompt(), buildProcess2UserPrompt(pr))
    const p2Result = parseJsonResponse(p2Response)
    
    // Process 3: 도장사 경유 및 지정
    const p3Response = await callClaude(apiKey, buildProcess3SystemPrompt(), buildProcess3UserPrompt(pr))
    const p3Result = parseJsonResponse(p3Response)
    
    // 도장사 지정 (경유 Y인 경우)
    let 도장사 = ""
    if (p3Result?.도장사경유 === "Y") {
      const 제작사 = pr['업체명'] || ''
      도장사 = PAINTING_COMPANY_MAP[제작사] || "미지정"
    }
    p3Result.도장사 = 도장사
    
    // Process 4: 발주 방식 결정
    const p4Response = await callClaude(apiKey, buildProcess4SystemPrompt(), buildProcess4UserPrompt(pr, p1Result, p2Result, p3Result))
    const p4Result = parseJsonResponse(p4Response)

    const totalProcessingTime = Date.now() - startTime

    // 결과 구조화
    const finalResult: Phase1Result = {
      prNo,
      status: 'completed',
      subProcesses: {
        contractPrice: {
          status: 'completed',
          input: {
            prNo: pr['대표PR'],
            자재속성: pr['자재속성'],
            자재내역: pr['자재내역']
          },
          logic: p1Result?.추론과정 || '',
          output: {
            계약단가존재: p1Result?.계약단가존재,
            판단근거: p1Result?.판단근거
          }
        },
        typeCodeValidation: {
          status: 'completed',
          input: {
            자재속성: pr['자재속성'],
            자재내역: pr['자재내역'],
            재질: pr['재질'],
            철의장유형코드: pr['철의장유형코드']
          },
          logic: p2Result?.추론과정 || '',
          output: {
            현재유형코드: p2Result?.현재유형코드,
            적정여부: p2Result?.적정여부,
            권장코드: p2Result?.권장코드,
            판단근거: p2Result?.판단근거
          }
        },
        paintingRoute: {
          status: 'completed',
          input: {
            도장사경유여부: pr['도장사경유여부'],
            외부도장: pr['외부도장'],
            업체명: pr['업체명']
          },
          logic: p3Result?.추론과정 || '',
          output: {
            도장사경유: p3Result?.도장사경유,
            도장사: p3Result?.도장사,
            판단근거: p3Result?.판단근거
          }
        },
        orderDecision: {
          status: 'completed',
          input: {
            계약단가존재: p1Result?.계약단가존재,
            유형코드적정성: p2Result?.적정여부,
            도장사경유: p3Result?.도장사경유
          },
          logic: p4Result?.추론과정 || '',
          output: {
            최종분류: p4Result?.최종분류,
            물량검토필요: p4Result?.물량검토필요,
            비고: p4Result?.비고,
            판단근거: p4Result?.판단근거
          }
        }
      },
      finalResult: {
        최종분류: p4Result?.최종분류 || '견적대상',
        물량검토필요: p4Result?.물량검토필요 || 'N'
      },
      totalProcessingTime
    }
    
    phase1Results.set(prNo, finalResult)

    return c.json({
      success: true,
      prNo,
      result: finalResult,
      processingTime: totalProcessingTime
    })

  } catch (error: any) {
    const totalProcessingTime = Date.now() - startTime
    const errorResult: Phase1Result = {
      prNo,
      status: 'error',
      subProcesses: {
        contractPrice: { status: 'error', error: error.message },
        typeCodeValidation: { status: 'error' },
        paintingRoute: { status: 'error' },
        orderDecision: { status: 'error' }
      },
      error: error.message,
      totalProcessingTime
    }
    phase1Results.set(prNo, errorResult)
    
    return c.json({ 
      success: false, 
      error: error.message,
      processingTime: totalProcessingTime 
    }, 500)
  }
})

// ============================================================================
// Phase 2 API: 물량검토 결과 검증
// ============================================================================

// API: 물량검토 결과 목록 가져오기
app.get('/api/review-list', (c) => {
  const reviewList = (reviewData as any[]).map((review, index) => {
    const prNo = review['PR']
    const result = phase2Results.get(prNo)
    return {
      index: index + 1,
      prNo,
      자재번호: review['자재번호'],
      자재내역: review['자재내역'],
      검토구분: review['검토구분'],
      변경유형코드: review['변경유형코드'],
      변경요청단가: review['변경요청단가'],
      status: result?.status || 'pending',
      검증결과: result?.finalResult?.검증결과 || null,
      권장조치: result?.finalResult?.권장조치 || null
    }
  })
  return c.json({ total: reviewList.length, data: reviewList })
})

// API: 단건 물량검토 결과 상세
app.get('/api/review/:prNo', (c) => {
  const prNo = parseInt(c.req.param('prNo'))
  const review = (reviewData as any[]).find(r => r['PR'] === prNo)
  
  if (!review) {
    return c.json({ error: 'Review not found' }, 404)
  }
  
  const result = phase2Results.get(prNo)
  
  return c.json({
    prNo: review['PR'],
    자재번호: review['자재번호'],
    자재내역: review['자재내역'],
    자재속성: review['자재속성'],
    재질: review['재질'],
    도면번호: review['도면번호'],
    철의장유형코드: review['철의장유형코드'],
    업체명: review['업체명'],
    검토구분: review['검토구분'],
    변경유형코드: review['변경유형코드'],
    변경유형코드명: review['변경유형코드명'],
    변경요청단가: review['변경요청단가'],
    verification: result || null
  })
})

// API: Phase 2 통계
app.get('/api/statistics/phase2', (c) => {
  const total = (reviewData as any[]).length
  let verified = 0
  let 자동확정 = 0
  let HITL = 0
  let 검토취소 = 0
  
  for (const [_, result] of phase2Results) {
    if (result.status === 'completed' && result.finalResult) {
      verified++
      const 조치 = result.finalResult.권장조치
      if (조치 === '확정') 자동확정++
      else if (조치 === 'HITL') HITL++
      else if (조치 === '검토취소') 검토취소++
    }
  }
  
  const 자동처리 = 자동확정 + 검토취소
  
  return c.json({
    total,
    verified,
    자동확정,
    HITL,
    검토취소,
    자동처리율: verified > 0 ? ((자동처리 / verified) * 100).toFixed(1) : '0.0'
  })
})

// Process 5: 물량검토 결과 검증 (Vision 포함)
function buildProcess5SystemPrompt() {
  return `당신은 조선소 철의장재 도면을 분석하여 단가유형을 판단하는 AI Agent입니다.

## 역할
공급사가 제출한 물량검토 결과(검토구분)의 적절성을 검증합니다.

## 단가유형별 판단 기준
- B (기본 상선): 단순 Angle + Plate 조합 구조, 재질 SS400, Carbon Steel
- G (BENDING류/COVER류/BOX류): 점선으로 밴딩 표기, 커버/박스류 형태, 재질 SS400
- I (PIPE/SQ.TUBE/BEAM TYPE): 원형 파이프 단면 표기, PIPE 명기, 재질 SS400
- N (CHECK PLATE 소요): CHECK PLATE 텍스트 표기, 재질 SS400
- A (SUS304L): SUS 304 또는 STS304 재질 명기
- S (SUS316L): SUS 316L 또는 STS316L 재질 명기

## 응답 형식
\`\`\`json
{
    "추론_단가유형": "B / G / I / N / A / S 중 하나",
    "신뢰도": "높음 / 중간 / 낮음",
    "판단근거": ["근거1", "근거2", "근거3"],
    "추론과정": "어떻게 판단했는지 설명"
}
\`\`\``
}

function buildProcess5UserPrompt(review: any, drawingInfo: any) {
  const currentType = review['철의장유형코드'] || ''
  const changeType = review['변경유형코드'] || ''
  
  return `## 검증 대상 (공급사 물량검토 결과)

| 항목 | 값 |
|------|-----|
| 도면번호 | ${review['도면번호']} |
| 자재내역 | ${review['자재내역']} |
| 현재 유형코드 | ${currentType} |
| 공급사 변경 유형코드 | ${changeType} |
| 변경유형코드명 | ${review['변경유형코드명']} |

## 도면 정보
${drawingInfo ? JSON.stringify(drawingInfo, null, 2) : '도면 정보 없음'}

공급사가 제출한 변경유형코드 '${changeType}'이 적절한지 검증해주세요.`
}

// API: Phase 2 검증 실행
app.post('/api/phase2/verify/:prNo', async (c) => {
  const prNo = parseInt(c.req.param('prNo'))
  const review = (reviewData as any[]).find(r => r['PR'] === prNo)
  
  if (!review) {
    return c.json({ error: 'Review not found' }, 404)
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || c.env?.ANTHROPIC_API_KEY
  if (!apiKey) {
    return c.json({ 
      error: 'ANTHROPIC_API_KEY not configured',
      message: '환경 변수에 ANTHROPIC_API_KEY를 설정해주세요.'
    }, 500)
  }

  const startTime = Date.now()
  const 검토구분 = review['검토구분'] || ''
  
  // 초기 상태 설정
  const initialResult: Phase2Result = {
    prNo,
    status: 'verifying',
    검토구분,
    process5: { status: 'processing' }
  }
  phase2Results.set(prNo, initialResult)

  try {
    let finalResult: { 검증결과: string; 권장조치: string; 검증근거: string }
    let logic = ''

    // 검토구분별 처리
    if (검토구분 === '단가유형미변경') {
      // 자동 확정
      logic = '공급사 검토 결과: 단가유형 미변경. 기존 단가유형 그대로 적용 가능하여 자동 확정 처리합니다.'
      finalResult = {
        검증결과: '적합',
        권장조치: '확정',
        검증근거: '공급사 검토 결과: 단가유형 미변경. 자동 확정 처리'
      }
    } else if (검토구분 === '제작불가') {
      // 자동 검토취소
      logic = '공급사 검토 결과: 제작불가. 해당 자재는 제작이 불가능하여 검토 취소 처리합니다.'
      finalResult = {
        검증결과: '해당없음',
        권장조치: '검토취소',
        검증근거: '공급사 검토 결과: 제작불가. 자동 검토취소 처리'
      }
    } else if (검토구분 === '협상필요') {
      // HITL
      const requestPrice = review['변경요청단가'] || 0
      logic = `공급사 검토 결과: 협상필요. 요청단가 ${requestPrice.toLocaleString()}원. 담당자가 직접 협상을 진행해야 합니다.`
      finalResult = {
        검증결과: '검토필요',
        권장조치: 'HITL',
        검증근거: `공급사 검토 결과: 협상필요. 요청단가 ${requestPrice.toLocaleString()}원. 담당자 검토 필요`
      }
    } else if (검토구분 === '단가유형변경') {
      // Vision 검증 또는 텍스트 기반 검증
      const dwgFull = review['도면번호'] || ''
      const dwgNo = dwgFull.length > 4 ? dwgFull.substring(4) : dwgFull
      const drawingInfo = (drawingMapping as any).index?.[dwgNo]
      
      if (drawingInfo) {
        // 도면 정보가 있으면 LLM 검증
        const p5Response = await callClaude(apiKey, buildProcess5SystemPrompt(), buildProcess5UserPrompt(review, drawingInfo))
        const p5Result = parseJsonResponse(p5Response)
        
        const llmType = p5Result?.추론_단가유형 || ''
        const confidence = p5Result?.신뢰도 || ''
        const changeType = review['변경유형코드'] || ''
        
        logic = p5Result?.추론과정 || `LLM Vision 분석 결과: ${llmType} (신뢰도: ${confidence})`
        
        if (changeType === llmType) {
          if (confidence === '높음' || confidence === '중간') {
            finalResult = {
              검증결과: '적합',
              권장조치: '확정',
              검증근거: `공급사 변경유형코드 '${changeType}'이 Vision 분석 결과와 일치 (신뢰도: ${confidence})`
            }
          } else {
            finalResult = {
              검증결과: '검토필요',
              권장조치: 'HITL',
              검증근거: `공급사 변경유형코드 일치하나 신뢰도 낮음. 담당자 확인 필요`
            }
          }
        } else {
          finalResult = {
            검증결과: '부적합',
            권장조치: 'HITL',
            검증근거: `공급사 '${changeType}' ≠ Vision 분석 '${llmType}'. 담당자 검토 필요`
          }
        }
      } else {
        // 도면 정보 없음 - 텍스트 기반 검증
        const currentType = review['철의장유형코드'] || ''
        const changeType = review['변경유형코드'] || ''
        
        if (currentType === changeType) {
          logic = `유형코드 동일 (${currentType}). 세부 유형 변경으로 판단되어 자동 확정 처리합니다.`
          finalResult = {
            검증결과: '적합',
            권장조치: '확정',
            검증근거: `유형코드 동일 (${currentType}). 세부 유형 변경으로 자동 확정`
          }
        } else {
          logic = `유형코드 변경 (${currentType} → ${changeType}). 도면 확인이 필요하여 담당자 검토 요청합니다.`
          finalResult = {
            검증결과: '검토필요',
            권장조치: 'HITL',
            검증근거: `유형코드 변경 (${currentType} → ${changeType}). 도면 확인 필요`
          }
        }
      }
    } else {
      // 알 수 없는 검토구분
      logic = `알 수 없는 검토구분: ${검토구분}. 담당자 검토가 필요합니다.`
      finalResult = {
        검증결과: '검토필요',
        권장조치: 'HITL',
        검증근거: `알 수 없는 검토구분: ${검토구분}`
      }
    }

    const totalProcessingTime = Date.now() - startTime

    // 결과 구조화
    const result: Phase2Result = {
      prNo,
      status: 'completed',
      검토구분,
      process5: {
        status: 'completed',
        input: {
          검토구분,
          자재내역: review['자재내역'],
          철의장유형코드: review['철의장유형코드'],
          변경유형코드: review['변경유형코드'],
          변경유형코드명: review['변경유형코드명'],
          변경요청단가: review['변경요청단가']
        },
        logic,
        output: finalResult
      },
      finalResult,
      totalProcessingTime
    }
    
    phase2Results.set(prNo, result)

    return c.json({
      success: true,
      prNo,
      result,
      processingTime: totalProcessingTime
    })

  } catch (error: any) {
    const totalProcessingTime = Date.now() - startTime
    const errorResult: Phase2Result = {
      prNo,
      status: 'error',
      검토구분,
      process5: { status: 'error', error: error.message },
      error: error.message,
      totalProcessingTime
    }
    phase2Results.set(prNo, errorResult)
    
    return c.json({ 
      success: false, 
      error: error.message,
      processingTime: totalProcessingTime 
    }, 500)
  }
})

// ============================================================================
// 공통 API
// ============================================================================

// API: 전체 초기화
app.post('/api/reset', (c) => {
  phase1Results.clear()
  phase2Results.clear()
  return c.json({ success: true, message: '모든 분석 결과가 초기화되었습니다.' })
})

// API: Phase 1 초기화
app.post('/api/reset/phase1', (c) => {
  phase1Results.clear()
  return c.json({ success: true, message: 'Phase 1 분석 결과가 초기화되었습니다.' })
})

// API: Phase 2 초기화
app.post('/api/reset/phase2', (c) => {
  phase2Results.clear()
  return c.json({ success: true, message: 'Phase 2 검증 결과가 초기화되었습니다.' })
})

// ============================================================================
// 헬퍼 함수
// ============================================================================

async function callClaude(apiKey: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`API Error: ${response.status} - ${errorText}`)
  }

  const data = await response.json() as any
  return data.content[0].text
}

function parseJsonResponse(text: string): any {
  let jsonStr = text
  if (text.includes('```json')) {
    jsonStr = text.split('```json')[1].split('```')[0]
  } else if (text.includes('```')) {
    jsonStr = text.split('```')[1].split('```')[0]
  }
  return JSON.parse(jsonStr.trim())
}

// ============================================================================
// 메인 페이지 - HTML UI
// ============================================================================

app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>철의장재 PR-to-PO AI Agent PoC</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        .process-box { transition: all 0.2s; border: 2px solid transparent; }
        .process-box:hover { border-color: #818CF8; }
        .process-box.selected { border-color: #4F46E5; background-color: #EEF2FF; }
        .process-box.disabled { opacity: 0.5; cursor: not-allowed; }
        .process-box.completed { border-color: #10B981; }
        .process-box.processing { border-color: #F59E0B; }
        
        .arrow-down { 
            width: 0; height: 0; 
            border-left: 8px solid transparent; 
            border-right: 8px solid transparent; 
            border-top: 10px solid #CBD5E1; 
            margin: 4px auto;
        }
        
        .badge-물량검토 { background-color: #10B981; color: white; }
        .badge-견적대상 { background-color: #3B82F6; color: white; }
        .badge-HITL { background-color: #F59E0B; color: white; }
        .badge-확정 { background-color: #10B981; color: white; }
        .badge-검토취소 { background-color: #6B7280; color: white; }
        
        .section-card { background: white; border-radius: 8px; border: 1px solid #E5E7EB; }
        .section-header { background: #F9FAFB; padding: 12px 16px; border-bottom: 1px solid #E5E7EB; font-weight: 600; }
        .section-content { padding: 16px; }
        
        .scrollbar-thin::-webkit-scrollbar { width: 6px; }
        .scrollbar-thin::-webkit-scrollbar-track { background: #f1f1f1; }
        .scrollbar-thin::-webkit-scrollbar-thumb { background: #c1c1c1; border-radius: 3px; }
        
        .tab-btn { transition: all 0.2s; }
        .tab-btn.active { background-color: #4F46E5; color: white; }
        
        .simulation-box { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 12px;
            padding: 24px;
            color: white;
        }
    </style>
</head>
<body class="bg-gray-100 h-screen flex flex-col">
    <!-- Header -->
    <header class="bg-indigo-700 text-white px-6 py-3 shadow-lg flex-shrink-0">
        <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
                <i class="fas fa-robot text-2xl"></i>
                <div>
                    <h1 class="text-lg font-bold">철의장재 PR-to-PO AI Agent</h1>
                    <p class="text-indigo-200 text-xs">PoC Demo v4 - PIPE SUPPORT 단가계약</p>
                </div>
            </div>
            <!-- Phase 탭 -->
            <div class="flex items-center space-x-2">
                <button id="tab-phase1" class="tab-btn active px-4 py-2 rounded-lg text-sm font-medium">
                    <i class="fas fa-search mr-1"></i> Phase 1: PR 분석
                </button>
                <button id="tab-phase2" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-500">
                    <i class="fas fa-check-double mr-1"></i> Phase 2: 결과 검증
                </button>
            </div>
        </div>
    </header>
    
    <!-- Phase 1 컨텐츠 -->
    <div id="phase1-content">
        <!-- 통계 대시보드 + PR 선택 -->
        <div class="bg-white border-b px-6 py-3 flex-shrink-0">
            <div class="flex items-center justify-between">
                <!-- PR 선택 및 버튼 -->
                <div class="flex items-center space-x-4">
                    <div class="flex items-center space-x-2">
                        <label class="text-sm font-medium text-gray-700">PR 선택</label>
                        <select id="pr-select" class="border rounded-lg px-3 py-2 text-sm w-72 focus:ring-2 focus:ring-indigo-500">
                            <option value="">-- PR을 선택하세요 --</option>
                        </select>
                    </div>
                    <button id="btn-analyze" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition flex items-center space-x-2 disabled:opacity-50" disabled>
                        <i class="fas fa-play"></i>
                        <span>분석 실행</span>
                    </button>
                    <button id="btn-analyze-all" class="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition flex items-center space-x-2">
                        <i class="fas fa-forward"></i>
                        <span>전체 실행</span>
                    </button>
                    <button id="btn-reset-p1" class="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition flex items-center space-x-2">
                        <i class="fas fa-redo"></i>
                        <span>초기화</span>
                    </button>
                </div>
                
                <!-- Phase 1 통계 -->
                <div class="flex items-center space-x-6">
                    <div class="text-center">
                        <div class="text-xl font-bold text-gray-700" id="p1-stat-analyzed">0</div>
                        <div class="text-xs text-gray-500">분석완료</div>
                    </div>
                    <div class="text-center">
                        <div class="text-xl font-bold text-green-600" id="p1-stat-물량검토">0</div>
                        <div class="text-xs text-gray-500">물량검토</div>
                    </div>
                    <div class="text-center">
                        <div class="text-xl font-bold text-blue-600" id="p1-stat-견적대상">0</div>
                        <div class="text-xs text-gray-500">견적대상</div>
                    </div>
                    <div class="text-center">
                        <div class="text-xl font-bold text-red-600" id="p1-stat-유형부적정">0</div>
                        <div class="text-xs text-gray-500">유형부적정</div>
                    </div>
                    <div class="text-center">
                        <div class="text-xl font-bold text-purple-600" id="p1-stat-도장경유">0</div>
                        <div class="text-xs text-gray-500">도장경유</div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Main Content: 3컬럼 -->
        <div class="flex flex-1 overflow-hidden" style="height: calc(100vh - 140px);">
            <!-- Main Process 패널 -->
            <div class="w-56 bg-gray-50 border-r p-4 flex-shrink-0 overflow-y-auto">
                <h3 class="text-sm font-semibold text-gray-600 mb-3">Main Process</h3>
                <div class="space-y-2">
                    <div id="mp-phase1" class="process-box selected rounded-lg p-3 cursor-pointer bg-white">
                        <div class="flex items-center justify-between">
                            <span class="text-sm font-medium">PR 검토 및 발주 방식 판단</span>
                        </div>
                        <span class="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded mt-1 inline-block">Phase 1</span>
                    </div>
                    <div class="arrow-down"></div>
                    <div class="process-box disabled rounded-lg p-3 bg-white">
                        <span class="text-sm font-medium text-gray-400">협력사 물량 검토 자동 요청</span>
                        <div class="text-xs text-gray-400 mt-1">미구현</div>
                    </div>
                    <div class="arrow-down"></div>
                    <div id="mp-phase2" class="process-box rounded-lg p-3 cursor-pointer bg-white">
                        <div class="flex items-center justify-between">
                            <span class="text-sm font-medium">협력사 물량 검토 결과 검증/지원</span>
                        </div>
                        <span class="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded mt-1 inline-block">Phase 2</span>
                    </div>
                    <div class="arrow-down"></div>
                    <div class="process-box disabled rounded-lg p-3 bg-white">
                        <span class="text-sm font-medium text-gray-400">물량검토 결과 기반 PO 자동 발행</span>
                        <div class="text-xs text-gray-400 mt-1">미구현</div>
                    </div>
                </div>
            </div>
            
            <!-- Sub Process 패널 (Phase 1) -->
            <div class="w-56 bg-gray-50 border-r p-4 flex-shrink-0 overflow-y-auto">
                <h3 class="text-sm font-semibold text-gray-600 mb-1">Sub Process</h3>
                <p class="text-xs text-gray-400 mb-3">(PR 검토 및 발주 방식 판단)</p>
                <div class="space-y-2">
                    <div id="sp-contract-price" class="process-box selected rounded-lg p-3 cursor-pointer bg-white" data-step="1">
                        <span class="text-sm font-medium">Process 1</span>
                        <div class="text-xs text-gray-600 mt-0.5">PR 자재별 계약 여부 판별</div>
                        <div id="sp-contract-price-status" class="text-xs text-gray-400 mt-1">대기</div>
                    </div>
                    <div class="arrow-down"></div>
                    <div id="sp-type-code" class="process-box rounded-lg p-3 cursor-pointer bg-white" data-step="2">
                        <span class="text-sm font-medium">Process 2</span>
                        <div class="text-xs text-gray-600 mt-0.5">철의장유형코드 검증/수정</div>
                        <div id="sp-type-code-status" class="text-xs text-gray-400 mt-1">대기</div>
                    </div>
                    <div class="arrow-down"></div>
                    <div id="sp-painting" class="process-box rounded-lg p-3 cursor-pointer bg-white" data-step="3">
                        <span class="text-sm font-medium">Process 3</span>
                        <div class="text-xs text-gray-600 mt-0.5">도장사 경유 및 지정</div>
                        <div id="sp-painting-status" class="text-xs text-gray-400 mt-1">대기</div>
                    </div>
                    <div class="arrow-down"></div>
                    <div id="sp-order-decision" class="process-box rounded-lg p-3 cursor-pointer bg-white" data-step="4">
                        <span class="text-sm font-medium">Process 4</span>
                        <div class="text-xs text-gray-600 mt-0.5">발주 방식 결정</div>
                        <div id="sp-order-decision-status" class="text-xs text-gray-400 mt-1">대기</div>
                    </div>
                </div>
            </div>
            
            <!-- 상세 화면 (Phase 1) -->
            <div class="flex-1 p-4 overflow-y-auto scrollbar-thin">
                <div id="p1-detail-content">
                    <!-- 초기 상태 -->
                    <div id="p1-detail-placeholder" class="flex items-center justify-center h-full text-gray-400">
                        <div class="text-center">
                            <i class="fas fa-hand-pointer text-5xl mb-4"></i>
                            <p class="text-lg">PR을 선택하고 분석을 실행해주세요</p>
                        </div>
                    </div>
                    
                    <!-- 상세 내용 -->
                    <div id="p1-detail-view" class="hidden space-y-4">
                        <div class="flex items-center justify-between mb-4">
                            <h2 id="p1-detail-title" class="text-lg font-bold text-gray-800"></h2>
                            <span id="p1-detail-status" class="text-sm px-3 py-1 rounded-full"></span>
                        </div>
                        
                        <!-- Input -->
                        <div class="section-card">
                            <div class="section-header flex items-center">
                                <i class="fas fa-sign-in-alt mr-2 text-indigo-600"></i>
                                Input
                            </div>
                            <div id="p1-detail-input" class="section-content"></div>
                        </div>
                        
                        <!-- Logic -->
                        <div class="section-card">
                            <div class="section-header flex items-center">
                                <i class="fas fa-cogs mr-2 text-indigo-600"></i>
                                Logic (LLM 추론)
                            </div>
                            <div id="p1-detail-logic" class="section-content"></div>
                        </div>
                        
                        <!-- Output -->
                        <div class="section-card">
                            <div class="section-header flex items-center">
                                <i class="fas fa-sign-out-alt mr-2 text-indigo-600"></i>
                                Output
                            </div>
                            <div id="p1-detail-output" class="section-content"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    
    <!-- Phase 2 컨텐츠 -->
    <div id="phase2-content" class="hidden">
        <!-- 통계 대시보드 + 물량검토 선택 -->
        <div class="bg-white border-b px-6 py-3 flex-shrink-0">
            <div class="flex items-center justify-between">
                <!-- 물량검토 선택 및 버튼 -->
                <div class="flex items-center space-x-4">
                    <div class="flex items-center space-x-2">
                        <label class="text-sm font-medium text-gray-700">물량검토 결과 선택</label>
                        <select id="review-select" class="border rounded-lg px-3 py-2 text-sm w-72 focus:ring-2 focus:ring-indigo-500">
                            <option value="">-- 물량검토 결과를 선택하세요 --</option>
                        </select>
                    </div>
                    <button id="btn-verify" class="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition flex items-center space-x-2 disabled:opacity-50" disabled>
                        <i class="fas fa-check"></i>
                        <span>검증 실행</span>
                    </button>
                    <button id="btn-verify-all" class="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition flex items-center space-x-2">
                        <i class="fas fa-forward"></i>
                        <span>전체 검증</span>
                    </button>
                    <button id="btn-reset-p2" class="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition flex items-center space-x-2">
                        <i class="fas fa-redo"></i>
                        <span>초기화</span>
                    </button>
                </div>
                
                <!-- Phase 2 통계 -->
                <div class="flex items-center space-x-6">
                    <div class="text-center">
                        <div class="text-xl font-bold text-gray-700" id="p2-stat-verified">0</div>
                        <div class="text-xs text-gray-500">검증완료</div>
                    </div>
                    <div class="text-center">
                        <div class="text-xl font-bold text-green-600" id="p2-stat-확정">0</div>
                        <div class="text-xs text-gray-500">자동확정</div>
                    </div>
                    <div class="text-center">
                        <div class="text-xl font-bold text-yellow-600" id="p2-stat-HITL">0</div>
                        <div class="text-xs text-gray-500">HITL</div>
                    </div>
                    <div class="text-center">
                        <div class="text-xl font-bold text-gray-600" id="p2-stat-취소">0</div>
                        <div class="text-xs text-gray-500">검토취소</div>
                    </div>
                    <div class="text-center">
                        <div class="text-xl font-bold text-indigo-600" id="p2-stat-자동처리율">0%</div>
                        <div class="text-xs text-gray-500">자동처리율</div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Main Content: 3컬럼 (Phase 2) -->
        <div class="flex flex-1 overflow-hidden" style="height: calc(100vh - 140px);">
            <!-- Main Process 패널 -->
            <div class="w-56 bg-gray-50 border-r p-4 flex-shrink-0 overflow-y-auto">
                <h3 class="text-sm font-semibold text-gray-600 mb-3">Main Process</h3>
                <div class="space-y-2">
                    <div id="mp-phase1-p2" class="process-box rounded-lg p-3 cursor-pointer bg-white">
                        <span class="text-sm font-medium">PR 검토 및 발주 방식 판단</span>
                        <span class="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded mt-1 inline-block">완료</span>
                    </div>
                    <div class="arrow-down"></div>
                    <div class="process-box disabled rounded-lg p-3 bg-white">
                        <span class="text-sm font-medium text-gray-400">협력사 물량 검토 자동 요청</span>
                        <div class="text-xs text-gray-400 mt-1">미구현</div>
                    </div>
                    <div class="arrow-down"></div>
                    <div id="mp-phase2-p2" class="process-box selected rounded-lg p-3 cursor-pointer bg-white">
                        <div class="flex items-center justify-between">
                            <span class="text-sm font-medium">협력사 물량 검토 결과 검증/지원</span>
                        </div>
                        <span class="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded mt-1 inline-block">Phase 2</span>
                    </div>
                    <div class="arrow-down"></div>
                    <div class="process-box disabled rounded-lg p-3 bg-white">
                        <span class="text-sm font-medium text-gray-400">물량검토 결과 기반 PO 자동 발행</span>
                        <div class="text-xs text-gray-400 mt-1">미구현</div>
                    </div>
                </div>
            </div>
            
            <!-- Sub Process 패널 (Phase 2) -->
            <div class="w-56 bg-gray-50 border-r p-4 flex-shrink-0 overflow-y-auto">
                <h3 class="text-sm font-semibold text-gray-600 mb-1">Sub Process</h3>
                <p class="text-xs text-gray-400 mb-3">(물량검토 결과 검증/지원)</p>
                <div class="space-y-2">
                    <div id="sp-process5" class="process-box selected rounded-lg p-3 cursor-pointer bg-white">
                        <span class="text-sm font-medium">Process 5</span>
                        <div class="text-xs text-gray-600 mt-0.5">공급사 물량검토 결과 검증</div>
                        <div id="sp-process5-status" class="text-xs text-gray-400 mt-1">대기</div>
                    </div>
                </div>
                
                <!-- 검토구분 범례 -->
                <div class="mt-6 p-3 bg-white rounded-lg border">
                    <h4 class="text-xs font-semibold text-gray-600 mb-2">검토구분별 처리</h4>
                    <div class="space-y-1.5 text-xs">
                        <div class="flex items-center">
                            <span class="w-2 h-2 rounded-full bg-green-500 mr-2"></span>
                            <span>단가유형미변경 → 자동확정</span>
                        </div>
                        <div class="flex items-center">
                            <span class="w-2 h-2 rounded-full bg-blue-500 mr-2"></span>
                            <span>단가유형변경 → Vision검증</span>
                        </div>
                        <div class="flex items-center">
                            <span class="w-2 h-2 rounded-full bg-yellow-500 mr-2"></span>
                            <span>협상필요 → HITL</span>
                        </div>
                        <div class="flex items-center">
                            <span class="w-2 h-2 rounded-full bg-gray-500 mr-2"></span>
                            <span>제작불가 → 검토취소</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- 상세 화면 (Phase 2) -->
            <div class="flex-1 p-4 overflow-y-auto scrollbar-thin">
                <div id="p2-detail-content">
                    <!-- 초기 상태: 시뮬레이션 화면 -->
                    <div id="p2-detail-placeholder" class="h-full">
                        <div class="simulation-box mb-6">
                            <div class="flex items-center mb-4">
                                <i class="fas fa-truck text-3xl mr-4"></i>
                                <div>
                                    <h3 class="text-xl font-bold">공급사 물량검토 결과 수신</h3>
                                    <p class="text-indigo-200 text-sm">물량검토 요청 후 공급사가 제출한 결과를 검증합니다</p>
                                </div>
                            </div>
                            <div class="grid grid-cols-4 gap-4 mt-4">
                                <div class="bg-white/20 rounded-lg p-4 text-center">
                                    <div class="text-2xl font-bold">20</div>
                                    <div class="text-sm opacity-80">총 수신건수</div>
                                </div>
                                <div class="bg-white/20 rounded-lg p-4 text-center">
                                    <div class="text-2xl font-bold">15</div>
                                    <div class="text-sm opacity-80">단가유형미변경</div>
                                </div>
                                <div class="bg-white/20 rounded-lg p-4 text-center">
                                    <div class="text-2xl font-bold">3</div>
                                    <div class="text-sm opacity-80">단가유형변경</div>
                                </div>
                                <div class="bg-white/20 rounded-lg p-4 text-center">
                                    <div class="text-2xl font-bold">2</div>
                                    <div class="text-sm opacity-80">기타(협상/불가)</div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="text-center text-gray-400 mt-8">
                            <i class="fas fa-hand-pointer text-5xl mb-4"></i>
                            <p class="text-lg">물량검토 결과를 선택하고 검증을 실행해주세요</p>
                        </div>
                    </div>
                    
                    <!-- 상세 내용 -->
                    <div id="p2-detail-view" class="hidden space-y-4">
                        <div class="flex items-center justify-between mb-4">
                            <h2 id="p2-detail-title" class="text-lg font-bold text-gray-800"></h2>
                            <span id="p2-detail-status" class="text-sm px-3 py-1 rounded-full"></span>
                        </div>
                        
                        <!-- Input -->
                        <div class="section-card">
                            <div class="section-header flex items-center">
                                <i class="fas fa-sign-in-alt mr-2 text-purple-600"></i>
                                Input (공급사 제출 결과)
                            </div>
                            <div id="p2-detail-input" class="section-content"></div>
                        </div>
                        
                        <!-- Logic -->
                        <div class="section-card">
                            <div class="section-header flex items-center">
                                <i class="fas fa-cogs mr-2 text-purple-600"></i>
                                Logic (검증 로직)
                            </div>
                            <div id="p2-detail-logic" class="section-content"></div>
                        </div>
                        
                        <!-- Output -->
                        <div class="section-card">
                            <div class="section-header flex items-center">
                                <i class="fas fa-sign-out-alt mr-2 text-purple-600"></i>
                                Output (검증 결과)
                            </div>
                            <div id="p2-detail-output" class="section-content"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // ====================================================================
        // State
        // ====================================================================
        let currentPhase = 1;
        let prList = [];
        let reviewList = [];
        let selectedPrNo = null;
        let selectedReviewPrNo = null;
        let selectedSubProcess = 'contractPrice';
        let currentP1Analysis = null;
        let currentP2Verification = null;
        let isAnalyzing = false;
        let isVerifying = false;

        // ====================================================================
        // DOM Elements
        // ====================================================================
        const tabPhase1 = document.getElementById('tab-phase1');
        const tabPhase2 = document.getElementById('tab-phase2');
        const phase1Content = document.getElementById('phase1-content');
        const phase2Content = document.getElementById('phase2-content');
        
        // Phase 1 elements
        const prSelect = document.getElementById('pr-select');
        const btnAnalyze = document.getElementById('btn-analyze');
        const btnAnalyzeAll = document.getElementById('btn-analyze-all');
        const btnResetP1 = document.getElementById('btn-reset-p1');
        
        // Phase 2 elements
        const reviewSelect = document.getElementById('review-select');
        const btnVerify = document.getElementById('btn-verify');
        const btnVerifyAll = document.getElementById('btn-verify-all');
        const btnResetP2 = document.getElementById('btn-reset-p2');

        // Sub Process 매핑 (Phase 1)
        const p1SubProcessMap = {
            'contractPrice': { id: 'sp-contract-price', title: 'Process 1: PR 자재별 계약 여부 판별', statusId: 'sp-contract-price-status' },
            'typeCodeValidation': { id: 'sp-type-code', title: 'Process 2: 철의장유형코드 검증/수정', statusId: 'sp-type-code-status' },
            'paintingRoute': { id: 'sp-painting', title: 'Process 3: 도장사 경유 및 지정', statusId: 'sp-painting-status' },
            'orderDecision': { id: 'sp-order-decision', title: 'Process 4: 발주 방식 결정', statusId: 'sp-order-decision-status' }
        };

        // ====================================================================
        // Initialize
        // ====================================================================
        async function init() {
            await loadPrList();
            await loadReviewList();
            await updateP1Statistics();
            await updateP2Statistics();
            setupEventListeners();
        }

        // ====================================================================
        // Event Listeners
        // ====================================================================
        function setupEventListeners() {
            // Phase 탭 전환
            tabPhase1.addEventListener('click', () => switchPhase(1));
            tabPhase2.addEventListener('click', () => switchPhase(2));
            document.getElementById('mp-phase2').addEventListener('click', () => switchPhase(2));
            document.getElementById('mp-phase1-p2').addEventListener('click', () => switchPhase(1));
            
            // Phase 1 이벤트
            prSelect.addEventListener('change', onPrSelect);
            btnAnalyze.addEventListener('click', analyzeP1Single);
            btnAnalyzeAll.addEventListener('click', analyzeP1All);
            btnResetP1.addEventListener('click', resetP1);
            
            // Phase 1 Sub Process 클릭
            Object.keys(p1SubProcessMap).forEach(key => {
                const el = document.getElementById(p1SubProcessMap[key].id);
                el.addEventListener('click', () => selectP1SubProcess(key));
            });
            
            // Phase 2 이벤트
            reviewSelect.addEventListener('change', onReviewSelect);
            btnVerify.addEventListener('click', verifyP2Single);
            btnVerifyAll.addEventListener('click', verifyP2All);
            btnResetP2.addEventListener('click', resetP2);
        }

        // ====================================================================
        // Phase 전환
        // ====================================================================
        function switchPhase(phase) {
            currentPhase = phase;
            
            if (phase === 1) {
                tabPhase1.classList.add('active');
                tabPhase2.classList.remove('active');
                phase1Content.classList.remove('hidden');
                phase2Content.classList.add('hidden');
            } else {
                tabPhase1.classList.remove('active');
                tabPhase2.classList.add('active');
                phase1Content.classList.add('hidden');
                phase2Content.classList.remove('hidden');
            }
        }

        // ====================================================================
        // Phase 1: PR 분석
        // ====================================================================
        async function loadPrList() {
            const response = await fetch('/api/pr-list');
            const data = await response.json();
            prList = data.data;
            
            prSelect.innerHTML = '<option value="">-- PR을 선택하세요 (' + data.total + '건) --</option>';
            prList.forEach(pr => {
                const status = pr.최종분류 ? '[' + pr.최종분류 + ']' : '';
                const option = document.createElement('option');
                option.value = pr.prNo;
                option.textContent = '#' + pr.prNo + ' - ' + pr.자재내역.substring(0, 30) + ' ' + status;
                prSelect.appendChild(option);
            });
        }

        async function onPrSelect() {
            selectedPrNo = prSelect.value ? parseInt(prSelect.value) : null;
            btnAnalyze.disabled = !selectedPrNo;
            
            if (selectedPrNo) {
                const response = await fetch('/api/pr/' + selectedPrNo);
                const data = await response.json();
                currentP1Analysis = data.analysis;
                updateP1SubProcessStatus();
                renderP1Detail();
            } else {
                currentP1Analysis = null;
                resetP1SubProcessStatus();
                showP1Placeholder();
            }
        }

        function selectP1SubProcess(key) {
            selectedSubProcess = key;
            
            Object.keys(p1SubProcessMap).forEach(k => {
                const el = document.getElementById(p1SubProcessMap[k].id);
                el.classList.toggle('selected', k === key);
            });
            
            renderP1Detail();
        }

        function updateP1SubProcessStatus() {
            if (!currentP1Analysis) {
                resetP1SubProcessStatus();
                return;
            }

            const sp = currentP1Analysis.subProcesses;
            
            updateProcessBox('contractPrice', sp.contractPrice?.status, p1SubProcessMap);
            updateProcessBox('typeCodeValidation', sp.typeCodeValidation?.status, p1SubProcessMap);
            updateProcessBox('paintingRoute', sp.paintingRoute?.status, p1SubProcessMap);
            updateProcessBox('orderDecision', sp.orderDecision?.status, p1SubProcessMap);
        }

        function updateProcessBox(key, status, processMap) {
            const el = document.getElementById(processMap[key].id);
            const statusEl = document.getElementById(processMap[key].statusId);
            
            el.classList.remove('completed', 'processing');
            
            if (status === 'completed') {
                el.classList.add('completed');
                statusEl.textContent = '완료';
                statusEl.className = 'text-xs text-green-600 mt-1';
            } else if (status === 'processing') {
                el.classList.add('processing');
                statusEl.textContent = '처리 중...';
                statusEl.className = 'text-xs text-yellow-600 mt-1';
            } else if (status === 'error') {
                statusEl.textContent = '오류';
                statusEl.className = 'text-xs text-red-600 mt-1';
            } else {
                statusEl.textContent = '대기';
                statusEl.className = 'text-xs text-gray-400 mt-1';
            }
        }

        function resetP1SubProcessStatus() {
            Object.keys(p1SubProcessMap).forEach(key => {
                updateProcessBox(key, 'pending', p1SubProcessMap);
            });
        }

        function renderP1Detail() {
            if (!selectedPrNo) {
                showP1Placeholder();
                return;
            }

            document.getElementById('p1-detail-placeholder').classList.add('hidden');
            document.getElementById('p1-detail-view').classList.remove('hidden');
            
            const title = document.getElementById('p1-detail-title');
            const status = document.getElementById('p1-detail-status');
            const inputDiv = document.getElementById('p1-detail-input');
            const logicDiv = document.getElementById('p1-detail-logic');
            const outputDiv = document.getElementById('p1-detail-output');
            
            title.textContent = p1SubProcessMap[selectedSubProcess].title;
            
            const spData = currentP1Analysis?.subProcesses?.[selectedSubProcess];
            
            if (!spData || spData.status === 'pending') {
                status.textContent = '대기';
                status.className = 'text-sm px-3 py-1 rounded-full bg-gray-100 text-gray-600';
                inputDiv.innerHTML = '<p class="text-gray-400">분석 실행 후 표시됩니다</p>';
                logicDiv.innerHTML = '<p class="text-gray-400">분석 실행 후 표시됩니다</p>';
                outputDiv.innerHTML = '<p class="text-gray-400">분석 실행 후 표시됩니다</p>';
                return;
            }

            if (spData.status === 'processing') {
                status.textContent = '처리 중...';
                status.className = 'text-sm px-3 py-1 rounded-full bg-yellow-100 text-yellow-700';
                inputDiv.innerHTML = '<p class="text-yellow-600"><i class="fas fa-spinner fa-spin mr-2"></i>처리 중...</p>';
                logicDiv.innerHTML = '<p class="text-yellow-600"><i class="fas fa-spinner fa-spin mr-2"></i>LLM 추론 중...</p>';
                outputDiv.innerHTML = '<p class="text-gray-400">처리 완료 후 표시됩니다</p>';
                return;
            }

            if (spData.status === 'completed') {
                status.textContent = '완료';
                status.className = 'text-sm px-3 py-1 rounded-full bg-green-100 text-green-700';
                inputDiv.innerHTML = renderInputTable(spData.input);
                logicDiv.innerHTML = renderLogic(spData.logic);
                outputDiv.innerHTML = renderOutputTable(spData.output, selectedSubProcess);
            }

            if (spData.status === 'error') {
                status.textContent = '오류';
                status.className = 'text-sm px-3 py-1 rounded-full bg-red-100 text-red-700';
                inputDiv.innerHTML = '<p class="text-red-600">오류 발생</p>';
                logicDiv.innerHTML = '<p class="text-red-600">' + (spData.error || '알 수 없는 오류') + '</p>';
                outputDiv.innerHTML = '';
            }
        }

        function showP1Placeholder() {
            document.getElementById('p1-detail-placeholder').classList.remove('hidden');
            document.getElementById('p1-detail-view').classList.add('hidden');
        }

        async function updateP1Statistics() {
            const response = await fetch('/api/statistics/phase1');
            const stats = await response.json();
            
            document.getElementById('p1-stat-analyzed').textContent = stats.analyzed;
            document.getElementById('p1-stat-물량검토').textContent = stats.물량검토;
            document.getElementById('p1-stat-견적대상').textContent = stats.견적대상;
            document.getElementById('p1-stat-유형부적정').textContent = stats.유형코드부적정;
            document.getElementById('p1-stat-도장경유').textContent = stats.도장사경유;
        }

        async function analyzeP1Single() {
            if (!selectedPrNo || isAnalyzing) return;
            
            isAnalyzing = true;
            btnAnalyze.disabled = true;
            btnAnalyze.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>분석 중...</span>';
            
            // 상태 초기화
            currentP1Analysis = {
                subProcesses: {
                    contractPrice: { status: 'processing' },
                    typeCodeValidation: { status: 'pending' },
                    paintingRoute: { status: 'pending' },
                    orderDecision: { status: 'pending' }
                }
            };
            updateP1SubProcessStatus();
            selectP1SubProcess('contractPrice');
            renderP1Detail();
            
            try {
                const response = await fetch('/api/phase1/analyze/' + selectedPrNo, { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    currentP1Analysis = result.result;
                    await showP1ProgressiveResults();
                } else {
                    currentP1Analysis = {
                        subProcesses: {
                            contractPrice: { status: 'error', error: result.error },
                            typeCodeValidation: { status: 'error' },
                            paintingRoute: { status: 'error' },
                            orderDecision: { status: 'error' }
                        }
                    };
                }
            } catch (error) {
                currentP1Analysis = {
                    subProcesses: {
                        contractPrice: { status: 'error', error: error.message },
                        typeCodeValidation: { status: 'error' },
                        paintingRoute: { status: 'error' },
                        orderDecision: { status: 'error' }
                    }
                };
            }
            
            updateP1SubProcessStatus();
            renderP1Detail();
            await updateP1Statistics();
            await loadPrList();
            prSelect.value = selectedPrNo;
            
            isAnalyzing = false;
            btnAnalyze.disabled = false;
            btnAnalyze.innerHTML = '<i class="fas fa-play"></i> <span>분석 실행</span>';
        }

        async function showP1ProgressiveResults() {
            // Step 1 완료
            updateProcessBox('contractPrice', 'completed', p1SubProcessMap);
            selectP1SubProcess('contractPrice');
            renderP1Detail();
            await sleep(200);
            
            // Step 2 완료
            updateProcessBox('typeCodeValidation', 'completed', p1SubProcessMap);
            selectP1SubProcess('typeCodeValidation');
            renderP1Detail();
            await sleep(200);
            
            // Step 3 완료
            updateProcessBox('paintingRoute', 'completed', p1SubProcessMap);
            selectP1SubProcess('paintingRoute');
            renderP1Detail();
            await sleep(200);
            
            // Step 4 완료
            updateProcessBox('orderDecision', 'completed', p1SubProcessMap);
            selectP1SubProcess('orderDecision');
            renderP1Detail();
        }

        async function analyzeP1All() {
            if (isAnalyzing) return;
            
            isAnalyzing = true;
            btnAnalyzeAll.disabled = true;
            btnAnalyzeAll.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>분석 중...</span>';
            
            for (const pr of prList) {
                if (pr.최종분류) continue;
                
                selectedPrNo = pr.prNo;
                prSelect.value = pr.prNo;
                
                currentP1Analysis = {
                    subProcesses: {
                        contractPrice: { status: 'processing' },
                        typeCodeValidation: { status: 'pending' },
                        paintingRoute: { status: 'pending' },
                        orderDecision: { status: 'pending' }
                    }
                };
                updateP1SubProcessStatus();
                selectP1SubProcess('contractPrice');
                renderP1Detail();
                
                try {
                    const response = await fetch('/api/phase1/analyze/' + pr.prNo, { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        currentP1Analysis = result.result;
                        await showP1ProgressiveResults();
                    }
                } catch (error) {
                    console.error('Error analyzing PR:', pr.prNo, error);
                }
                
                await updateP1Statistics();
                await sleep(200);
            }
            
            await loadPrList();
            
            isAnalyzing = false;
            btnAnalyzeAll.disabled = false;
            btnAnalyzeAll.innerHTML = '<i class="fas fa-forward"></i> <span>전체 실행</span>';
        }

        async function resetP1() {
            if (isAnalyzing) return;
            
            await fetch('/api/reset/phase1', { method: 'POST' });
            selectedPrNo = null;
            currentP1Analysis = null;
            prSelect.value = '';
            btnAnalyze.disabled = true;
            
            resetP1SubProcessStatus();
            showP1Placeholder();
            await loadPrList();
            await updateP1Statistics();
        }

        // ====================================================================
        // Phase 2: 물량검토 결과 검증
        // ====================================================================
        async function loadReviewList() {
            const response = await fetch('/api/review-list');
            const data = await response.json();
            reviewList = data.data;
            
            reviewSelect.innerHTML = '<option value="">-- 물량검토 결과를 선택하세요 (' + data.total + '건) --</option>';
            reviewList.forEach(review => {
                const status = review.권장조치 ? '[' + review.권장조치 + ']' : '';
                const option = document.createElement('option');
                option.value = review.prNo;
                option.textContent = '#' + review.prNo + ' [' + review.검토구분 + '] - ' + review.자재내역.substring(0, 25) + ' ' + status;
                reviewSelect.appendChild(option);
            });
        }

        async function onReviewSelect() {
            selectedReviewPrNo = reviewSelect.value ? parseInt(reviewSelect.value) : null;
            btnVerify.disabled = !selectedReviewPrNo;
            
            if (selectedReviewPrNo) {
                const response = await fetch('/api/review/' + selectedReviewPrNo);
                const data = await response.json();
                currentP2Verification = data.verification;
                updateP2SubProcessStatus();
                renderP2Detail();
            } else {
                currentP2Verification = null;
                resetP2SubProcessStatus();
                showP2Placeholder();
            }
        }

        function updateP2SubProcessStatus() {
            const statusEl = document.getElementById('sp-process5-status');
            const el = document.getElementById('sp-process5');
            
            el.classList.remove('completed', 'processing');
            
            if (!currentP2Verification) {
                statusEl.textContent = '대기';
                statusEl.className = 'text-xs text-gray-400 mt-1';
                return;
            }
            
            const status = currentP2Verification.process5?.status;
            
            if (status === 'completed') {
                el.classList.add('completed');
                statusEl.textContent = '완료';
                statusEl.className = 'text-xs text-green-600 mt-1';
            } else if (status === 'processing') {
                el.classList.add('processing');
                statusEl.textContent = '검증 중...';
                statusEl.className = 'text-xs text-yellow-600 mt-1';
            } else if (status === 'error') {
                statusEl.textContent = '오류';
                statusEl.className = 'text-xs text-red-600 mt-1';
            } else {
                statusEl.textContent = '대기';
                statusEl.className = 'text-xs text-gray-400 mt-1';
            }
        }

        function resetP2SubProcessStatus() {
            const statusEl = document.getElementById('sp-process5-status');
            const el = document.getElementById('sp-process5');
            el.classList.remove('completed', 'processing');
            statusEl.textContent = '대기';
            statusEl.className = 'text-xs text-gray-400 mt-1';
        }

        function renderP2Detail() {
            if (!selectedReviewPrNo) {
                showP2Placeholder();
                return;
            }

            document.getElementById('p2-detail-placeholder').classList.add('hidden');
            document.getElementById('p2-detail-view').classList.remove('hidden');
            
            const title = document.getElementById('p2-detail-title');
            const status = document.getElementById('p2-detail-status');
            const inputDiv = document.getElementById('p2-detail-input');
            const logicDiv = document.getElementById('p2-detail-logic');
            const outputDiv = document.getElementById('p2-detail-output');
            
            title.textContent = 'Process 5: 공급사 물량검토 결과 검증';
            
            const p5Data = currentP2Verification?.process5;
            
            if (!p5Data || p5Data.status === 'pending') {
                status.textContent = '대기';
                status.className = 'text-sm px-3 py-1 rounded-full bg-gray-100 text-gray-600';
                inputDiv.innerHTML = '<p class="text-gray-400">검증 실행 후 표시됩니다</p>';
                logicDiv.innerHTML = '<p class="text-gray-400">검증 실행 후 표시됩니다</p>';
                outputDiv.innerHTML = '<p class="text-gray-400">검증 실행 후 표시됩니다</p>';
                return;
            }

            if (p5Data.status === 'processing') {
                status.textContent = '검증 중...';
                status.className = 'text-sm px-3 py-1 rounded-full bg-yellow-100 text-yellow-700';
                inputDiv.innerHTML = '<p class="text-yellow-600"><i class="fas fa-spinner fa-spin mr-2"></i>검증 중...</p>';
                logicDiv.innerHTML = '<p class="text-yellow-600"><i class="fas fa-spinner fa-spin mr-2"></i>검증 로직 실행 중...</p>';
                outputDiv.innerHTML = '<p class="text-gray-400">검증 완료 후 표시됩니다</p>';
                return;
            }

            if (p5Data.status === 'completed') {
                status.textContent = '완료';
                status.className = 'text-sm px-3 py-1 rounded-full bg-green-100 text-green-700';
                inputDiv.innerHTML = renderInputTable(p5Data.input);
                logicDiv.innerHTML = renderLogic(p5Data.logic);
                outputDiv.innerHTML = renderP2OutputTable(p5Data.output);
            }

            if (p5Data.status === 'error') {
                status.textContent = '오류';
                status.className = 'text-sm px-3 py-1 rounded-full bg-red-100 text-red-700';
                inputDiv.innerHTML = '<p class="text-red-600">오류 발생</p>';
                logicDiv.innerHTML = '<p class="text-red-600">' + (p5Data.error || '알 수 없는 오류') + '</p>';
                outputDiv.innerHTML = '';
            }
        }

        function renderP2OutputTable(output) {
            if (!output) return '<p class="text-gray-400">데이터 없음</p>';
            
            let html = '<table class="w-full text-sm">';
            
            // 검증결과
            let resultClass = '';
            if (output.검증결과 === '적합') resultClass = 'text-green-600';
            else if (output.검증결과 === '부적합') resultClass = 'text-red-600';
            else resultClass = 'text-yellow-600';
            
            html += '<tr class="border-b border-gray-100">';
            html += '<td class="py-2 text-gray-500 w-40">검증결과</td>';
            html += '<td class="py-2 font-bold ' + resultClass + '">' + (output.검증결과 || '-') + '</td>';
            html += '</tr>';
            
            // 권장조치
            let badgeClass = 'badge-HITL';
            if (output.권장조치 === '확정') badgeClass = 'badge-확정';
            else if (output.권장조치 === '검토취소') badgeClass = 'badge-검토취소';
            
            html += '<tr class="border-b border-gray-100">';
            html += '<td class="py-2 text-gray-500 w-40">권장조치</td>';
            html += '<td class="py-2"><span class="px-2 py-1 rounded text-xs font-bold ' + badgeClass + '">' + (output.권장조치 || '-') + '</span></td>';
            html += '</tr>';
            
            // 검증근거
            html += '<tr class="border-b border-gray-100">';
            html += '<td class="py-2 text-gray-500 w-40">검증근거</td>';
            html += '<td class="py-2">' + (output.검증근거 || '-') + '</td>';
            html += '</tr>';
            
            html += '</table>';
            return html;
        }

        function showP2Placeholder() {
            document.getElementById('p2-detail-placeholder').classList.remove('hidden');
            document.getElementById('p2-detail-view').classList.add('hidden');
        }

        async function updateP2Statistics() {
            const response = await fetch('/api/statistics/phase2');
            const stats = await response.json();
            
            document.getElementById('p2-stat-verified').textContent = stats.verified;
            document.getElementById('p2-stat-확정').textContent = stats.자동확정;
            document.getElementById('p2-stat-HITL').textContent = stats.HITL;
            document.getElementById('p2-stat-취소').textContent = stats.검토취소;
            document.getElementById('p2-stat-자동처리율').textContent = stats.자동처리율 + '%';
        }

        async function verifyP2Single() {
            if (!selectedReviewPrNo || isVerifying) return;
            
            isVerifying = true;
            btnVerify.disabled = true;
            btnVerify.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>검증 중...</span>';
            
            currentP2Verification = {
                process5: { status: 'processing' }
            };
            updateP2SubProcessStatus();
            renderP2Detail();
            
            try {
                const response = await fetch('/api/phase2/verify/' + selectedReviewPrNo, { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    currentP2Verification = result.result;
                }
            } catch (error) {
                currentP2Verification = {
                    process5: { status: 'error', error: error.message }
                };
            }
            
            updateP2SubProcessStatus();
            renderP2Detail();
            await updateP2Statistics();
            await loadReviewList();
            reviewSelect.value = selectedReviewPrNo;
            
            isVerifying = false;
            btnVerify.disabled = false;
            btnVerify.innerHTML = '<i class="fas fa-check"></i> <span>검증 실행</span>';
        }

        async function verifyP2All() {
            if (isVerifying) return;
            
            isVerifying = true;
            btnVerifyAll.disabled = true;
            btnVerifyAll.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>검증 중...</span>';
            
            for (const review of reviewList) {
                if (review.권장조치) continue;
                
                selectedReviewPrNo = review.prNo;
                reviewSelect.value = review.prNo;
                
                currentP2Verification = {
                    process5: { status: 'processing' }
                };
                updateP2SubProcessStatus();
                renderP2Detail();
                
                try {
                    const response = await fetch('/api/phase2/verify/' + review.prNo, { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        currentP2Verification = result.result;
                    }
                } catch (error) {
                    console.error('Error verifying review:', review.prNo, error);
                }
                
                updateP2SubProcessStatus();
                renderP2Detail();
                await updateP2Statistics();
                await sleep(200);
            }
            
            await loadReviewList();
            
            isVerifying = false;
            btnVerifyAll.disabled = false;
            btnVerifyAll.innerHTML = '<i class="fas fa-forward"></i> <span>전체 검증</span>';
        }

        async function resetP2() {
            if (isVerifying) return;
            
            await fetch('/api/reset/phase2', { method: 'POST' });
            selectedReviewPrNo = null;
            currentP2Verification = null;
            reviewSelect.value = '';
            btnVerify.disabled = true;
            
            resetP2SubProcessStatus();
            showP2Placeholder();
            await loadReviewList();
            await updateP2Statistics();
        }

        // ====================================================================
        // 공통 헬퍼 함수
        // ====================================================================
        function renderInputTable(input) {
            if (!input) return '<p class="text-gray-400">데이터 없음</p>';
            
            let html = '<table class="w-full text-sm">';
            for (const [key, value] of Object.entries(input)) {
                html += '<tr class="border-b border-gray-100">';
                html += '<td class="py-2 text-gray-500 w-40">' + key + '</td>';
                html += '<td class="py-2 font-medium">' + (value || '-') + '</td>';
                html += '</tr>';
            }
            html += '</table>';
            return html;
        }

        function renderLogic(logic) {
            if (!logic) return '<p class="text-gray-400">추론 과정 없음</p>';
            
            return '<div class="bg-blue-50 rounded-lg p-4">' +
                '<div class="flex items-start">' +
                '<i class="fas fa-brain text-blue-500 mr-3 mt-1"></i>' +
                '<div>' +
                '<p class="text-sm font-medium text-blue-700 mb-1">LLM 추론</p>' +
                '<p class="text-sm text-gray-700">' + logic + '</p>' +
                '</div>' +
                '</div>' +
                '</div>';
        }

        function renderOutputTable(output, subProcess) {
            if (!output) return '<p class="text-gray-400">데이터 없음</p>';
            
            let html = '<table class="w-full text-sm">';
            for (const [key, value] of Object.entries(output)) {
                let valueClass = 'font-medium';
                
                // 특별 스타일링
                if (key === '계약단가존재' || key === '물량검토필요' || key === '도장사경유') {
                    valueClass = value === 'Y' ? 'font-bold text-green-600' : 'font-bold text-red-600';
                } else if (key === '적정여부') {
                    if (value === '적합') valueClass = 'font-bold text-green-600';
                    else if (value === '부적합') valueClass = 'font-bold text-red-600';
                    else valueClass = 'font-bold text-yellow-600';
                } else if (key === '최종분류') {
                    const badge = getBadgeClass(value);
                    html += '<tr class="border-b border-gray-100">';
                    html += '<td class="py-2 text-gray-500 w-40">' + key + '</td>';
                    html += '<td class="py-2"><span class="px-2 py-1 rounded text-xs font-bold ' + badge + '">' + value + '</span></td>';
                    html += '</tr>';
                    continue;
                }
                
                html += '<tr class="border-b border-gray-100">';
                html += '<td class="py-2 text-gray-500 w-40">' + key + '</td>';
                html += '<td class="py-2 ' + valueClass + '">' + (value || '-') + '</td>';
                html += '</tr>';
            }
            html += '</table>';
            return html;
        }

        function getBadgeClass(classification) {
            if (classification?.includes('물량검토')) return 'badge-물량검토';
            if (classification?.includes('견적')) return 'badge-견적대상';
            return 'badge-HITL';
        }

        function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        // Initialize
        init();
    </script>
</body>
</html>
  `)
})

export default app
