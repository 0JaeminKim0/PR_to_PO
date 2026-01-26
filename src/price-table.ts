// 단가테이블 데이터 - 자동 생성됨
export const priceTable = {
  "PQPA": {
    "name": "PIPE SUPPORT ACCOMM. AREA",
    "codes": [
      {"code": "B", "name": "상선 기본(SS400)"},
      {"code": "A", "name": "SUS304L(ANGLE, PLATE)"},
      {"code": "G", "name": "BENDING류(COVER류, BOX류)"},
      {"code": "I", "name": "PIPE, SQ. TUBE, BEAM TYPE"},
      {"code": "S", "name": "SUS316L(ANGLE, PLATE)"},
      {"code": "M", "name": "SUS316L(PIPE)"},
      {"code": "N", "name": "CHECK PLATE 소요"}
    ]
  },
  "PQPD": {
    "name": "PIPE SUPPORT HULL AREA",
    "codes": [
      {"code": "B", "name": "상선 기본(SS400)"},
      {"code": "A", "name": "SUS304L(ANGLE, PLATE)"},
      {"code": "G", "name": "BENDING류(COVER류, BOX류)"},
      {"code": "I", "name": "PIPE, SQ. TUBE, BEAM TYPE"},
      {"code": "S", "name": "SUS316L(ANGLE, PLATE)"},
      {"code": "M", "name": "SUS316L(PIPE)"},
      {"code": "N", "name": "CHECK PLATE 소요"}
    ]
  },
  "PQPG": {
    "name": "PIPE SUPPORT FOR GRE/GRP",
    "codes": [
      {"code": "B", "name": "상선 기본(SS400)"},
      {"code": "A", "name": "SUS304L(ANGLE, PLATE)"},
      {"code": "G", "name": "BENDING류(COVER류, BOX류)"},
      {"code": "I", "name": "PIPE, SQ. TUBE, BEAM TYPE"},
      {"code": "S", "name": "SUS316L(ANGLE, PLATE)"},
      {"code": "M", "name": "SUS316L(PIPE)"},
      {"code": "N", "name": "CHECK PLATE 소요"}
    ]
  },
  "PQPM": {
    "name": "PIPE SUPPORT MACHINERY AREA",
    "codes": [
      {"code": "B", "name": "상선 기본(SS400)"},
      {"code": "A", "name": "SUS304L(ANGLE, PLATE)"},
      {"code": "G", "name": "BENDING류(COVER류, BOX류)"},
      {"code": "I", "name": "PIPE, SQ. TUBE, BEAM TYPE"},
      {"code": "S", "name": "SUS316L(ANGLE, PLATE)"},
      {"code": "M", "name": "SUS316L(PIPE)"},
      {"code": "N", "name": "CHECK PLATE 소요"}
    ]
  },
  "PQPS": {
    "name": "PIPE SUPPORT",
    "codes": [
      {"code": "B", "name": "상선 기본(SS400)"},
      {"code": "A", "name": "SUS304L(ANGLE, PLATE)"},
      {"code": "G", "name": "BENDING류(COVER류, BOX류)"},
      {"code": "I", "name": "PIPE, SQ. TUBE, BEAM TYPE"},
      {"code": "S", "name": "SUS316L(ANGLE, PLATE)"},
      {"code": "M", "name": "SUS316L(PIPE)"},
      {"code": "N", "name": "CHECK PLATE 소요"}
    ]
  },
  "PQPU": {
    "name": "PIPE SUPPORT FOR UNIT",
    "codes": [
      {"code": "B", "name": "상선 기본(SS400)"},
      {"code": "A", "name": "SUS304L(ANGLE, PLATE)"},
      {"code": "G", "name": "BENDING류(COVER류, BOX류)"},
      {"code": "I", "name": "PIPE, SQ. TUBE, BEAM TYPE"},
      {"code": "S", "name": "SUS316L(ANGLE, PLATE)"},
      {"code": "M", "name": "SUS316L(PIPE)"},
      {"code": "N", "name": "CHECK PLATE 소요"}
    ]
  },
  "PQPC": {
    "name": "PIPE COAMING",
    "codes": [
      {"code": "E", "name": "COAMING (SUS316L(ANGLE, PLATE))"},
      {"code": "G", "name": "COAMING 기본TYPE"}
    ]
  }
} as const;

export type PriceTable = typeof priceTable;
