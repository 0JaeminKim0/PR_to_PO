// 도면 매핑 데이터 (drawing_mapping_v2.json.txt)
export const drawingMapping = {
  "pages": {
    "page_1": {
      "file": "drawing_page_1.png",
      "drawings": [
        {
          "dwg_no": "DN572P137",
          "material_no": "2590TPQPD701C572",
          "correct_type": "G",
          "criteria": [
            "메인 도면에 점선으로 밴딩 표기됨",
            "ISO View 형상이 커버/박스류 형태",
            "Description 표에 PL (Plate) 다수 조합",
            "재질 SS400 (Carbon Steel)"
          ]
        },
        {
          "dwg_no": "DN512P137",
          "material_no": "2589TPQPD303A512",
          "correct_type": "I",
          "criteria": [
            "메인 도면에 원형 파이프 단면 표기 (지름 치수 있음)",
            "파이프 벽면 두께가 점선으로 표기됨",
            "Description 표에 PIPE 명기",
            "재질 SS400 (Carbon Steel)"
          ]
        },
        {
          "dwg_no": "DN212P137",
          "material_no": "2589TPQPD131C212",
          "correct_type": "B",
          "criteria": [
            "메인 도면 및 ISO View가 단순 파이프 서포트 형태",
            "Angle + Plate 기본 조합",
            "밴딩/커버/파이프 특수 형상 없음",
            "Description 표에 EQ. ANGLE, PL 기본 부재만 있음",
            "재질 SS400 (Carbon Steel)"
          ]
        }
      ]
    },
    "page_2": {
      "file": "drawing_page_2.png",
      "drawings": [
        {
          "dwg_no": "DN501P137",
          "material_no": "2590TPQPD304A501",
          "correct_type": "N",
          "criteria": [
            "도면에 CHECK PLATE 텍스트 직접 표기됨",
            "ISO View가 Plate 조합 형태",
            "Description 표에 CHECK PLATE 명기",
            "재질 SS400 (Carbon Steel)"
          ]
        },
        {
          "dwg_no": "DN507P145",
          "material_no": "2589TPQPS780P507",
          "correct_type": "A",
          "criteria": [
            "Description 표에 SUS 304 또는 STS304 재질 명기",
            "Angle/Plate 형상",
            "재질 기준으로 A 분류"
          ]
        },
        {
          "dwg_no": "DN502P137",
          "material_no": "2589TPQPD252P502",
          "correct_type": "S",
          "criteria": [
            "Description 표에 SUS 316L 또는 STS316L 재질 명기",
            "Angle 형상",
            "재질 기준으로 S 분류"
          ]
        }
      ]
    }
  },
  "index": {
    "DN572P137": {
      "page": "page_1",
      "file": "drawing_page_1.png",
      "dwg_no": "DN572P137",
      "material_no": "2590TPQPD701C572",
      "correct_type": "G",
      "criteria": [
        "메인 도면에 점선으로 밴딩 표기됨",
        "ISO View 형상이 커버/박스류 형태",
        "Description 표에 PL (Plate) 다수 조합",
        "재질 SS400 (Carbon Steel)"
      ]
    },
    "DN512P137": {
      "page": "page_1",
      "file": "drawing_page_1.png",
      "dwg_no": "DN512P137",
      "material_no": "2589TPQPD303A512",
      "correct_type": "I",
      "criteria": [
        "메인 도면에 원형 파이프 단면 표기 (지름 치수 있음)",
        "파이프 벽면 두께가 점선으로 표기됨",
        "Description 표에 PIPE 명기",
        "재질 SS400 (Carbon Steel)"
      ]
    },
    "DN212P137": {
      "page": "page_1",
      "file": "drawing_page_1.png",
      "dwg_no": "DN212P137",
      "material_no": "2589TPQPD131C212",
      "correct_type": "B",
      "criteria": [
        "메인 도면 및 ISO View가 단순 파이프 서포트 형태",
        "Angle + Plate 기본 조합",
        "밴딩/커버/파이프 특수 형상 없음",
        "Description 표에 EQ. ANGLE, PL 기본 부재만 있음",
        "재질 SS400 (Carbon Steel)"
      ]
    },
    "DN501P137": {
      "page": "page_2",
      "file": "drawing_page_2.png",
      "dwg_no": "DN501P137",
      "material_no": "2590TPQPD304A501",
      "correct_type": "N",
      "criteria": [
        "도면에 CHECK PLATE 텍스트 직접 표기됨",
        "ISO View가 Plate 조합 형태",
        "Description 표에 CHECK PLATE 명기",
        "재질 SS400 (Carbon Steel)"
      ]
    },
    "DN507P145": {
      "page": "page_2",
      "file": "drawing_page_2.png",
      "dwg_no": "DN507P145",
      "material_no": "2589TPQPS780P507",
      "correct_type": "A",
      "criteria": [
        "Description 표에 SUS 304 또는 STS304 재질 명기",
        "Angle/Plate 형상",
        "재질 기준으로 A 분류"
      ]
    },
    "DN502P137": {
      "page": "page_2",
      "file": "drawing_page_2.png",
      "dwg_no": "DN502P137",
      "material_no": "2589TPQPD252P502",
      "correct_type": "S",
      "criteria": [
        "Description 표에 SUS 316L 또는 STS316L 재질 명기",
        "Angle 형상",
        "재질 기준으로 S 분류"
      ]
    }
  }
};
