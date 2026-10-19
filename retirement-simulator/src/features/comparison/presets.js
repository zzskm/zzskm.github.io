

const EXPLORE_PRESETS = [
  {
    id: "retire-age", label: "은퇴 시점 비교",
    description: "은퇴 나이를 ±3·5년 변경하면 어떻게 될까?",
    generate: (base) => [
      { suffix: `퇴직 ${Math.max(40, base.retireAge - 3)}세`, patch: { retireAge: Math.max(40, base.retireAge - 3) } },
      { suffix: `퇴직 ${Math.min(75, base.retireAge + 3)}세`, patch: { retireAge: Math.min(75, base.retireAge + 3) } },
      { suffix: `퇴직 ${Math.min(75, base.retireAge + 5)}세`, patch: { retireAge: Math.min(75, base.retireAge + 5) } },
    ]
  },
  {
    id: "living-cost", label: "생활비 비교",
    description: "월 ±50만원이면 결과가 얼마나 달라질까?",
    generate: (base) => [
      { suffix: "절약형(−50)", patch: {
        bridgeLivingCost: Math.max(50, base.bridgeLivingCost - 50),
        retirementLivingCost: Math.max(50, base.retirementLivingCost - 50) }},
      { suffix: "여유형(+50)", patch: {
        bridgeLivingCost: base.bridgeLivingCost + 50,
        retirementLivingCost: base.retirementLivingCost + 50 }},
    ]
  },
  {
    id: "savings", label: "근로기 절약 비교",
    description: "지금부터 생활비를 월 30·60만 줄여 저축한다면?",
    generate: (base) => [
      { suffix: "생활비 −30", patch: { workingLivingCost: Math.max(50, (base.workingLivingCost ?? 300) - 30) } },
      { suffix: "생활비 −60", patch: { workingLivingCost: Math.max(50, (base.workingLivingCost ?? 300) - 60) } },
    ]
  },
  {
    id: "stress", label: "위기 대응 비교",
    description: "시장 충격이 왔을 때 어떻게 될까?",
    generate: (base) => [
      { suffix: "경미 충격",     patch: { stressTest: "mild" } },
      { suffix: "심각 충격",     patch: { stressTest: "severe" } },
      { suffix: "2008 시나리오", patch: { stressTest: "2008" } },
    ]
  },
];


export { EXPLORE_PRESETS };
