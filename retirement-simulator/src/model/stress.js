// 스트레스 프리셋을 age → realRate 함수로 변환
function buildStressRateFn(stressKey, r, retireAge, inflRate) {
  const baseReal  = (1 + r / 100) / (1 + inflRate) - 1;
  if (!stressKey || stressKey === "none") return () => baseReal;

  if (stressKey === "mild") {
    const shockReal = (1 + Math.max(-30, r - 5) / 100) / (1 + inflRate) - 1;
    return (age) => (age >= retireAge && age < retireAge + 3) ? shockReal : baseReal;
  }
  if (stressKey === "severe") {
    const shockReal = (1 + Math.max(-30, r - 10) / 100) / (1 + inflRate) - 1;
    return (age) => (age >= retireAge && age < retireAge + 5) ? shockReal : baseReal;
  }
  if (stressKey === "2008") {
    const crashReal   = (1 + Math.max(-50, r - 30) / 100) / (1 + inflRate) - 1;
    const recovReal   = (1 + (r + 10) / 100) / (1 + inflRate) - 1;
    return (age) => {
      if (age === retireAge)                          return crashReal;   // 첫해 폭락
      if (age > retireAge && age <= retireAge + 2)   return recovReal;   // 2년 반등
      return baseReal;
    };
  }
  return () => baseReal;
}

export { buildStressRateFn };
