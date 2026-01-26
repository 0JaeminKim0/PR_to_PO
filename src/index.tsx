import { Hono } from 'hono'
import { cors } from 'hono/cors'

// PR 데이터 및 단가테이블 (TypeScript 모듈로 포함)
import { prData } from './pr-data.js'
import { priceTable } from './price-table.js'

type Bindings = {
  ANTHROPIC_API_KEY?: string
}

type SubProcessResult = {
  status: 'pending' | 'processing' | 'completed' | 'error'
  input?: Record<string, any>
  logic?: string
  output?: Record<string, any>
  error?: string
  processingTime?: number
}

type AnalysisResult = {
  prNo: number
  status: 'pending' | 'analyzing' | 'completed' | 'error'
  subProcesses: {
    contractPrice: SubProcessResult
    typeCodeValidation: SubProcessResult
    reviewDecision: SubProcessResult
  }
  finalResult?: {
    최종분류: string
    물량검토대상: string
  }
  error?: string
  totalProcessingTime?: number
}

// 분석 결과 저장소 (메모리)
const analysisResults = new Map<number, AnalysisResult>()

const app = new Hono<{ Bindings: Bindings }>()

// CORS 설정
app.use('/api/*', cors())

// API: PR 목록 가져오기 (드롭다운용)
app.get('/api/pr-list', (c) => {
  const prList = (prData as any[]).map((pr, index) => {
    const prNo = pr['대표PR']
    const result = analysisResults.get(prNo)
    return {
      index: index + 1,
      prNo,
      자재내역: pr['자재내역'],
      자재속성: pr['자재속성'],
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
  
  const result = analysisResults.get(prNo)
  
  return c.json({
    prNo: pr['대표PR'],
    자재내역: pr['자재내역'],
    자재속성: pr['자재속성'],
    자재속성_4자리: pr['자재속성_4자리'],
    자재그룹: pr['자재그룹'],
    재질: pr['재질'],
    재질내역: pr['재질내역'],
    상세사양: pr['상세사양'],
    철의장유형코드: pr['철의장유형코드'],
    SYS철의장유형코드: pr['SYS철의장유형코드'],
    PR철의장유형코드: pr['PR철의장유형코드'],
    호선: pr['호선'],
    BLOCK: pr['BLOCK'],
    단가테이블매칭: pr['단가테이블매칭'],
    analysis: result || null
  })
})

// API: 단가테이블 정보
app.get('/api/price-table', (c) => {
  return c.json(priceTable)
})

// API: 통계 정보
app.get('/api/statistics', (c) => {
  const total = (prData as any[]).length
  let analyzed = 0
  let 물량검토 = 0
  let 견적대상 = 0
  let HITL필요 = 0
  
  for (const [_, result] of analysisResults) {
    if (result.status === 'completed' && result.finalResult) {
      analyzed++
      const 분류 = result.finalResult.최종분류
      if (분류.includes('물량검토')) 물량검토++
      else if (분류.includes('견적')) 견적대상++
      else HITL필요++
    }
  }
  
  const 자동처리 = 물량검토 + 견적대상
  
  return c.json({
    total,
    analyzed,
    물량검토,
    견적대상,
    HITL필요,
    자동처리율: analyzed > 0 ? ((자동처리 / analyzed) * 100).toFixed(1) : '0.0'
  })
})

// System Prompt 생성
function buildSystemPrompt() {
  let priceContext = `
## 계약 단가테이블 정보

### 등록된 자재속성그룹
`
  const groups = Object.keys(priceTable)
  priceContext += groups.join(', ') + '\n\n'
  
  for (const [group, info] of Object.entries(priceTable as Record<string, any>)) {
    priceContext += `**${group}** (${info.name})\n`
    for (const code of info.codes) {
      priceContext += `  - ${code.code}: ${code.name}\n`
    }
    priceContext += '\n'
  }

  return `당신은 조선소 철의장재 구매 업무를 지원하는 AI Agent입니다.

## 역할
PR(구매요청) 데이터를 분석하여 3단계로 판단합니다:
1. 계약단가 존재 확인
2. 철의장유형코드 적정성 검증  
3. 물량검토 대상 여부 결정

${priceContext}

### 판단 기준
- 자재속성(앞 4자리)이 위 테이블에 존재하면 → 단가계약 존재
- 자재속성이 미존재하면 → 견적 대상

### 철의장상세구분 코드 의미
- B: 상선 기본 (SS400, Carbon Steel)
- A: SUS304L (ANGLE, PLATE)
- S: SUS316L (ANGLE, PLATE)
- G: BENDING류 (COVER류, BOX류)
- I: PIPE, SQ.TUBE, BEAM TYPE
- M: SUS316L (PIPE)
- N: CHECK PLATE 소요
- E: COAMING (SUS316L) - PQPC 전용

## 응답 형식
반드시 아래 JSON 형식으로만 응답하세요.

\`\`\`json
{
    "step1_계약단가확인": {
        "단가존재여부": "Y 또는 N",
        "근거": "판단 근거",
        "추론과정": "LLM이 어떻게 판단했는지 설명"
    },
    "step2_유형코드검증": {
        "현재유형코드": "현재 코드",
        "적정유형코드": "추천 코드",
        "적정성": "적합 / 부적합 / 검토필요",
        "근거": "판단 근거",
        "추론과정": "LLM이 어떻게 판단했는지 설명"
    },
    "step3_물량검토결정": {
        "물량검토대상": "Y 또는 N",
        "최종분류": "물량검토 / 견적대상 / HITL필요",
        "종합의견": "전체 분석 의견",
        "추론과정": "LLM이 어떻게 판단했는지 설명"
    }
}
\`\`\`

## 판단 시 고려사항
1. 자재내역 키워드: BENDING, COVER, BOX → G코드, PIPE, TUBE, BEAM → I코드
2. 재질 해석: CS=Carbon Steel(B), S4=SUS304(A), S6=SUS316(S,M)
3. 확신이 낮으면 "검토필요" 또는 "HITL필요"로 분류
`
}

// User Prompt 생성
function buildUserPrompt(pr: any) {
  const safeStr = (val: any) => val === '' || val === null || val === undefined ? '없음' : String(val)
  
  return `## 분석 대상 PR

| 항목 | 값 |
|------|-----|
| PR No | ${pr.prNo} |
| 자재내역 | ${safeStr(pr.자재내역)} |
| 자재속성 | ${safeStr(pr.자재속성)} |
| 자재그룹 | ${safeStr(pr.자재그룹)} |
| 재질 | ${safeStr(pr.재질)} |
| 재질내역 | ${safeStr(pr.재질내역)} |
| 상세사양 | ${safeStr(pr.상세사양)} |
| 현재 철의장유형코드 | ${safeStr(pr.철의장유형코드)} |
| SYS 철의장유형코드 | ${safeStr(pr.SYS철의장유형코드)} |
| PR 철의장유형코드 | ${safeStr(pr.PR철의장유형코드)} |

위 PR을 3단계로 분석하고 JSON 형식으로 응답하세요.
`
}

// API: 단건 분석 실행
app.post('/api/analyze/:prNo', async (c) => {
  const prNo = parseInt(c.req.param('prNo'))
  const pr = (prData as any[]).find(p => p['대표PR'] === prNo)
  
  if (!pr) {
    return c.json({ error: 'PR not found' }, 404)
  }

  // API Key 확인
  const apiKey = process.env.ANTHROPIC_API_KEY || c.env?.ANTHROPIC_API_KEY
  if (!apiKey) {
    return c.json({ 
      error: 'ANTHROPIC_API_KEY not configured',
      message: '환경 변수에 ANTHROPIC_API_KEY를 설정해주세요.'
    }, 500)
  }

  const startTime = Date.now()
  
  // 초기 상태 설정
  const initialResult: AnalysisResult = {
    prNo,
    status: 'analyzing',
    subProcesses: {
      contractPrice: { status: 'processing' },
      typeCodeValidation: { status: 'pending' },
      reviewDecision: { status: 'pending' }
    }
  }
  analysisResults.set(prNo, initialResult)

  try {
    const prInput = {
      prNo: pr['대표PR'],
      자재내역: pr['자재내역'],
      자재속성: pr['자재속성'],
      자재그룹: pr['자재그룹'],
      재질: pr['재질'],
      재질내역: pr['재질내역'],
      상세사양: pr['상세사양'],
      철의장유형코드: pr['철의장유형코드'],
      SYS철의장유형코드: pr['SYS철의장유형코드'],
      PR철의장유형코드: pr['PR철의장유형코드']
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: buildSystemPrompt(),
        messages: [
          { role: 'user', content: buildUserPrompt(prInput) }
        ]
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`API Error: ${response.status} - ${errorText}`)
    }

    const data = await response.json() as any
    const responseText = data.content[0].text

    // JSON 추출
    let jsonStr = responseText
    if (responseText.includes('```json')) {
      jsonStr = responseText.split('```json')[1].split('```')[0]
    } else if (responseText.includes('```')) {
      jsonStr = responseText.split('```')[1].split('```')[0]
    }

    const result = JSON.parse(jsonStr.trim())
    const totalProcessingTime = Date.now() - startTime

    // 결과 구조화
    const finalResult: AnalysisResult = {
      prNo,
      status: 'completed',
      subProcesses: {
        contractPrice: {
          status: 'completed',
          input: {
            prNo: prInput.prNo,
            자재속성: prInput.자재속성,
            자재내역: prInput.자재내역
          },
          logic: result.step1_계약단가확인?.추론과정 || '',
          output: {
            단가존재여부: result.step1_계약단가확인?.단가존재여부,
            근거: result.step1_계약단가확인?.근거
          }
        },
        typeCodeValidation: {
          status: 'completed',
          input: {
            자재내역: prInput.자재내역,
            재질: prInput.재질,
            재질내역: prInput.재질내역,
            현재유형코드: prInput.철의장유형코드,
            SYS유형코드: prInput.SYS철의장유형코드,
            PR유형코드: prInput.PR철의장유형코드
          },
          logic: result.step2_유형코드검증?.추론과정 || '',
          output: {
            현재유형코드: result.step2_유형코드검증?.현재유형코드,
            적정유형코드: result.step2_유형코드검증?.적정유형코드,
            적정성: result.step2_유형코드검증?.적정성,
            근거: result.step2_유형코드검증?.근거
          }
        },
        reviewDecision: {
          status: 'completed',
          input: {
            단가존재여부: result.step1_계약단가확인?.단가존재여부,
            유형코드적정성: result.step2_유형코드검증?.적정성
          },
          logic: result.step3_물량검토결정?.추론과정 || '',
          output: {
            물량검토대상: result.step3_물량검토결정?.물량검토대상,
            최종분류: result.step3_물량검토결정?.최종분류,
            종합의견: result.step3_물량검토결정?.종합의견
          }
        }
      },
      finalResult: {
        최종분류: result.step3_물량검토결정?.최종분류,
        물량검토대상: result.step3_물량검토결정?.물량검토대상
      },
      totalProcessingTime
    }
    
    analysisResults.set(prNo, finalResult)

    return c.json({
      success: true,
      prNo,
      result: finalResult,
      processingTime: totalProcessingTime
    })

  } catch (error: any) {
    const totalProcessingTime = Date.now() - startTime
    const errorResult: AnalysisResult = {
      prNo,
      status: 'error',
      subProcesses: {
        contractPrice: { status: 'error', error: error.message },
        typeCodeValidation: { status: 'error' },
        reviewDecision: { status: 'error' }
      },
      error: error.message,
      totalProcessingTime
    }
    analysisResults.set(prNo, errorResult)
    
    return c.json({ 
      success: false, 
      error: error.message,
      processingTime: totalProcessingTime 
    }, 500)
  }
})

// API: 분석 결과 초기화
app.post('/api/reset', (c) => {
  analysisResults.clear()
  return c.json({ success: true, message: '분석 결과가 초기화되었습니다.' })
})

// 메인 페이지 - HTML 렌더링
app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>철의장재 PR 분석 AI Agent PoC</title>
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
        .badge-HITL필요 { background-color: #F59E0B; color: white; }
        
        .section-card { background: white; border-radius: 8px; border: 1px solid #E5E7EB; }
        .section-header { background: #F9FAFB; padding: 12px 16px; border-bottom: 1px solid #E5E7EB; font-weight: 600; }
        .section-content { padding: 16px; }
        
        .scrollbar-thin::-webkit-scrollbar { width: 6px; }
        .scrollbar-thin::-webkit-scrollbar-track { background: #f1f1f1; }
        .scrollbar-thin::-webkit-scrollbar-thumb { background: #c1c1c1; border-radius: 3px; }
    </style>
</head>
<body class="bg-gray-100 h-screen flex flex-col">
    <!-- Header -->
    <header class="bg-indigo-700 text-white px-6 py-3 shadow-lg flex-shrink-0">
        <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
                <i class="fas fa-robot text-2xl"></i>
                <div>
                    <h1 class="text-lg font-bold">철의장재 PR 분석 AI Agent</h1>
                    <p class="text-indigo-200 text-xs">PoC Demo - 세창앰앤이 단가계약</p>
                </div>
            </div>
        </div>
    </header>
    
    <!-- 통계 대시보드 + PR 선택 -->
    <div class="bg-white border-b px-6 py-3 flex-shrink-0">
        <div class="flex items-center justify-between">
            <!-- PR 선택 및 버튼 -->
            <div class="flex items-center space-x-4">
                <div class="flex items-center space-x-2">
                    <label class="text-sm font-medium text-gray-700">PR 선택</label>
                    <select id="pr-select" class="border rounded-lg px-3 py-2 text-sm w-64 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500">
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
                <button id="btn-reset" class="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition flex items-center space-x-2">
                    <i class="fas fa-redo"></i>
                    <span>초기화</span>
                </button>
            </div>
            
            <!-- 통계 -->
            <div class="flex items-center space-x-6">
                <div class="text-center">
                    <div class="text-xl font-bold text-gray-700" id="stat-total">0</div>
                    <div class="text-xs text-gray-500">총 분석</div>
                </div>
                <div class="text-center">
                    <div class="text-xl font-bold text-green-600" id="stat-물량검토">0</div>
                    <div class="text-xs text-gray-500">물량검토</div>
                </div>
                <div class="text-center">
                    <div class="text-xl font-bold text-blue-600" id="stat-견적대상">0</div>
                    <div class="text-xs text-gray-500">견적대상</div>
                </div>
                <div class="text-center">
                    <div class="text-xl font-bold text-yellow-600" id="stat-HITL">0</div>
                    <div class="text-xs text-gray-500">HITL필요</div>
                </div>
                <div class="text-center">
                    <div class="text-xl font-bold text-indigo-600" id="stat-자동처리율">0%</div>
                    <div class="text-xs text-gray-500">자동처리율</div>
                </div>
            </div>
        </div>
    </div>
    
    <!-- Main Content: 3컬럼 -->
    <div class="flex flex-1 overflow-hidden">
        <!-- Main Process 패널 -->
        <div class="w-48 bg-gray-50 border-r p-4 flex-shrink-0">
            <h3 class="text-sm font-semibold text-gray-600 mb-3">Main Process</h3>
            <div class="space-y-2">
                <div id="mp-pr-receipt" class="process-box selected rounded-lg p-3 cursor-pointer bg-white">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">PR 검토 및 발주 방식 판단</span>
                        <span class="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">PoC</span>
                    </div>
                </div>
                <div class="arrow-down"></div>
                <div class="process-box disabled rounded-lg p-3 bg-white">
                    <span class="text-sm font-medium text-gray-400">협력사 물량 검토 자동 요청</span>
                    <div class="text-xs text-gray-400 mt-1">미구현</div>
                </div>
                <div class="arrow-down"></div>
                <div class="process-box disabled rounded-lg p-3 bg-white">
                    <span class="text-sm font-medium text-gray-400">협력사 물량 검토 제출 결과 검증/지원</span>
                    <div class="text-xs text-gray-400 mt-1">미구현</div>
                </div>
                <div class="arrow-down"></div>
                <div class="process-box disabled rounded-lg p-3 bg-white">
                    <span class="text-sm font-medium text-gray-400">물량검토 결과 기반 PO 자동 발행</span>
                    <div class="text-xs text-gray-400 mt-1">미구현</div>
                </div>
            </div>
        </div>
        
        <!-- Sub Process 패널 -->
        <div class="w-52 bg-gray-50 border-r p-4 flex-shrink-0">
            <h3 class="text-sm font-semibold text-gray-600 mb-1">Sub Process</h3>
            <p class="text-xs text-gray-400 mb-3">(PR 검토 및 발주 방식 판단)</p>
            <div class="space-y-2">
                <div id="sp-contract-price" class="process-box selected rounded-lg p-3 cursor-pointer bg-white" data-step="1">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">PR 자재별 계약 여부 판별</span>
                    </div>
                    <div id="sp-contract-price-status" class="text-xs text-gray-400 mt-1">대기</div>
                </div>
                <div class="arrow-down"></div>
                <div id="sp-type-code" class="process-box rounded-lg p-3 cursor-pointer bg-white" data-step="2">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">철의장유형코드 검증/수정</span>
                    </div>
                    <div id="sp-type-code-status" class="text-xs text-gray-400 mt-1">대기</div>
                </div>
                <div class="arrow-down"></div>
                <div id="sp-review-decision" class="process-box rounded-lg p-3 cursor-pointer bg-white" data-step="3">
                    <div class="flex items-center justify-between">
                        <span class="text-sm font-medium">발주 방식 결정</span>
                    </div>
                    <div id="sp-review-decision-status" class="text-xs text-gray-400 mt-1">대기</div>
                </div>
            </div>
        </div>
        
        <!-- 상세 화면 -->
        <div class="flex-1 p-4 overflow-y-auto scrollbar-thin">
            <div id="detail-content">
                <!-- 초기 상태 -->
                <div id="detail-placeholder" class="flex items-center justify-center h-full text-gray-400">
                    <div class="text-center">
                        <i class="fas fa-hand-pointer text-5xl mb-4"></i>
                        <p class="text-lg">PR을 선택하고 분석을 실행해주세요</p>
                    </div>
                </div>
                
                <!-- 상세 내용 (동적 렌더링) -->
                <div id="detail-view" class="hidden space-y-4">
                    <div class="flex items-center justify-between mb-4">
                        <h2 id="detail-title" class="text-lg font-bold text-gray-800"></h2>
                        <span id="detail-status" class="text-sm px-3 py-1 rounded-full"></span>
                    </div>
                    
                    <!-- Input -->
                    <div class="section-card">
                        <div class="section-header flex items-center">
                            <i class="fas fa-sign-in-alt mr-2 text-indigo-600"></i>
                            Input
                        </div>
                        <div id="detail-input" class="section-content"></div>
                    </div>
                    
                    <!-- Logic -->
                    <div class="section-card">
                        <div class="section-header flex items-center">
                            <i class="fas fa-cogs mr-2 text-indigo-600"></i>
                            Logic (LLM 추론)
                        </div>
                        <div id="detail-logic" class="section-content"></div>
                    </div>
                    
                    <!-- Output -->
                    <div class="section-card">
                        <div class="section-header flex items-center">
                            <i class="fas fa-sign-out-alt mr-2 text-indigo-600"></i>
                            Output
                        </div>
                        <div id="detail-output" class="section-content"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // State
        let prList = [];
        let selectedPrNo = null;
        let selectedSubProcess = 'contractPrice';
        let currentAnalysis = null;
        let isAnalyzing = false;

        // DOM Elements
        const prSelect = document.getElementById('pr-select');
        const btnAnalyze = document.getElementById('btn-analyze');
        const btnAnalyzeAll = document.getElementById('btn-analyze-all');
        const btnReset = document.getElementById('btn-reset');

        // Sub Process 매핑
        const subProcessMap = {
            'contractPrice': { id: 'sp-contract-price', title: 'PR 자재별 계약 여부 판별', statusId: 'sp-contract-price-status' },
            'typeCodeValidation': { id: 'sp-type-code', title: '철의장유형코드 검증/수정', statusId: 'sp-type-code-status' },
            'reviewDecision': { id: 'sp-review-decision', title: '발주 방식 결정', statusId: 'sp-review-decision-status' }
        };

        // Initialize
        async function init() {
            await loadPrList();
            await updateStatistics();
            setupEventListeners();
        }

        // Load PR List
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

        // Setup Event Listeners
        function setupEventListeners() {
            prSelect.addEventListener('change', onPrSelect);
            btnAnalyze.addEventListener('click', analyzeSingle);
            btnAnalyzeAll.addEventListener('click', analyzeAll);
            btnReset.addEventListener('click', reset);
            
            // Sub Process 클릭
            Object.keys(subProcessMap).forEach(key => {
                const el = document.getElementById(subProcessMap[key].id);
                el.addEventListener('click', () => selectSubProcess(key));
            });
        }

        // PR 선택
        async function onPrSelect() {
            selectedPrNo = prSelect.value ? parseInt(prSelect.value) : null;
            btnAnalyze.disabled = !selectedPrNo;
            
            if (selectedPrNo) {
                const response = await fetch('/api/pr/' + selectedPrNo);
                const data = await response.json();
                currentAnalysis = data.analysis;
                updateSubProcessStatus();
                renderDetail();
            } else {
                currentAnalysis = null;
                resetSubProcessStatus();
                showPlaceholder();
            }
        }

        // Sub Process 선택
        function selectSubProcess(key) {
            selectedSubProcess = key;
            
            // 선택 상태 업데이트
            Object.keys(subProcessMap).forEach(k => {
                const el = document.getElementById(subProcessMap[k].id);
                el.classList.toggle('selected', k === key);
            });
            
            renderDetail();
        }

        // Sub Process 상태 업데이트
        function updateSubProcessStatus() {
            if (!currentAnalysis) {
                resetSubProcessStatus();
                return;
            }

            const sp = currentAnalysis.subProcesses;
            
            updateProcessBox('contractPrice', sp.contractPrice?.status);
            updateProcessBox('typeCodeValidation', sp.typeCodeValidation?.status);
            updateProcessBox('reviewDecision', sp.reviewDecision?.status);
        }

        function updateProcessBox(key, status) {
            const el = document.getElementById(subProcessMap[key].id);
            const statusEl = document.getElementById(subProcessMap[key].statusId);
            
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

        function resetSubProcessStatus() {
            Object.keys(subProcessMap).forEach(key => {
                updateProcessBox(key, 'pending');
            });
        }

        // 상세 화면 렌더링
        function renderDetail() {
            if (!selectedPrNo) {
                showPlaceholder();
                return;
            }

            document.getElementById('detail-placeholder').classList.add('hidden');
            document.getElementById('detail-view').classList.remove('hidden');
            
            const title = document.getElementById('detail-title');
            const status = document.getElementById('detail-status');
            const inputDiv = document.getElementById('detail-input');
            const logicDiv = document.getElementById('detail-logic');
            const outputDiv = document.getElementById('detail-output');
            
            title.textContent = subProcessMap[selectedSubProcess].title;
            
            // 분석 결과가 있는지 확인
            const spData = currentAnalysis?.subProcesses?.[selectedSubProcess];
            
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
                
                // Input 렌더링
                inputDiv.innerHTML = renderInputTable(spData.input);
                
                // Logic 렌더링
                logicDiv.innerHTML = renderLogic(spData.logic);
                
                // Output 렌더링
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
                if (key === '단가존재여부' || key === '물량검토대상') {
                    valueClass = value === 'Y' ? 'font-bold text-green-600' : 'font-bold text-red-600';
                } else if (key === '적정성') {
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
            return 'badge-HITL필요';
        }

        function showPlaceholder() {
            document.getElementById('detail-placeholder').classList.remove('hidden');
            document.getElementById('detail-view').classList.add('hidden');
        }

        // 통계 업데이트
        async function updateStatistics() {
            const response = await fetch('/api/statistics');
            const stats = await response.json();
            
            document.getElementById('stat-total').textContent = stats.analyzed;
            document.getElementById('stat-물량검토').textContent = stats.물량검토;
            document.getElementById('stat-견적대상').textContent = stats.견적대상;
            document.getElementById('stat-HITL').textContent = stats.HITL필요;
            document.getElementById('stat-자동처리율').textContent = stats.자동처리율 + '%';
        }

        // 단건 분석
        async function analyzeSingle() {
            if (!selectedPrNo || isAnalyzing) return;
            
            isAnalyzing = true;
            btnAnalyze.disabled = true;
            btnAnalyze.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>분석 중...</span>';
            
            // Sub Process 상태 초기화 및 순차 표시
            currentAnalysis = {
                subProcesses: {
                    contractPrice: { status: 'processing' },
                    typeCodeValidation: { status: 'pending' },
                    reviewDecision: { status: 'pending' }
                }
            };
            updateSubProcessStatus();
            selectSubProcess('contractPrice');
            renderDetail();
            
            try {
                const response = await fetch('/api/analyze/' + selectedPrNo, { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    currentAnalysis = result.result;
                    
                    // 순차적으로 완료 표시 (시뮬레이션)
                    await showProgressiveResults();
                } else {
                    currentAnalysis = {
                        subProcesses: {
                            contractPrice: { status: 'error', error: result.error },
                            typeCodeValidation: { status: 'error' },
                            reviewDecision: { status: 'error' }
                        }
                    };
                }
            } catch (error) {
                currentAnalysis = {
                    subProcesses: {
                        contractPrice: { status: 'error', error: error.message },
                        typeCodeValidation: { status: 'error' },
                        reviewDecision: { status: 'error' }
                    }
                };
            }
            
            updateSubProcessStatus();
            renderDetail();
            await updateStatistics();
            await loadPrList(); // PR 목록 새로고침 (상태 표시 업데이트)
            
            // 현재 선택 유지
            prSelect.value = selectedPrNo;
            
            isAnalyzing = false;
            btnAnalyze.disabled = false;
            btnAnalyze.innerHTML = '<i class="fas fa-play"></i> <span>분석 실행</span>';
        }

        async function showProgressiveResults() {
            // Step 1 완료 표시
            updateProcessBox('contractPrice', 'completed');
            selectSubProcess('contractPrice');
            renderDetail();
            await sleep(300);
            
            // Step 2 진행 및 완료
            updateProcessBox('typeCodeValidation', 'processing');
            await sleep(200);
            updateProcessBox('typeCodeValidation', 'completed');
            selectSubProcess('typeCodeValidation');
            renderDetail();
            await sleep(300);
            
            // Step 3 진행 및 완료
            updateProcessBox('reviewDecision', 'processing');
            await sleep(200);
            updateProcessBox('reviewDecision', 'completed');
            selectSubProcess('reviewDecision');
            renderDetail();
        }

        function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        // 전체 분석
        async function analyzeAll() {
            if (isAnalyzing) return;
            
            isAnalyzing = true;
            btnAnalyzeAll.disabled = true;
            btnAnalyzeAll.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>분석 중...</span>';
            
            for (const pr of prList) {
                if (pr.최종분류) continue; // 이미 분석됨
                
                selectedPrNo = pr.prNo;
                prSelect.value = pr.prNo;
                
                // 현재 PR 분석
                currentAnalysis = {
                    subProcesses: {
                        contractPrice: { status: 'processing' },
                        typeCodeValidation: { status: 'pending' },
                        reviewDecision: { status: 'pending' }
                    }
                };
                updateSubProcessStatus();
                selectSubProcess('contractPrice');
                renderDetail();
                
                try {
                    const response = await fetch('/api/analyze/' + pr.prNo, { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        currentAnalysis = result.result;
                        await showProgressiveResults();
                    }
                } catch (error) {
                    console.error('Error analyzing PR:', pr.prNo, error);
                }
                
                updateSubProcessStatus();
                renderDetail();
                await updateStatistics();
                
                // 딜레이
                await sleep(300);
            }
            
            await loadPrList();
            
            isAnalyzing = false;
            btnAnalyzeAll.disabled = false;
            btnAnalyzeAll.innerHTML = '<i class="fas fa-forward"></i> <span>전체 실행</span>';
        }

        // 초기화
        async function reset() {
            if (isAnalyzing) return;
            
            await fetch('/api/reset', { method: 'POST' });
            selectedPrNo = null;
            currentAnalysis = null;
            prSelect.value = '';
            btnAnalyze.disabled = true;
            
            resetSubProcessStatus();
            showPlaceholder();
            await loadPrList();
            await updateStatistics();
        }

        // Initialize
        init();
    </script>
</body>
</html>
  `)
})

export default app
