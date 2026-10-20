import { ASSUMPTIONS } from "./assumptions.js";
import { calculateScenario } from "./cashflow.js";

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runMonteCarlo(input, assumptions = ASSUMPTIONS, opts = {}) {
  const mc = assumptions.monteCarlo;
  const runs = opts.runs ?? mc.runs;
  const mean = input.investmentReturnRate;
  const vol  = input.returnVolatility ?? mc.defaultVolatility;
  const inflRate = input.inflationRate / 100;
  // 입력 수익률은 연복리(중앙값) 수익률로 해석한다: (1+R)이 로그정규분포, 중앙값 = 1+r.
  // → 중간 시나리오(고정 수익률) 경로가 몬테카를로의 중앙 경로와 일치하고, 수익률이 −100% 아래로 내려가지 않는다.
  const growth = 1 + mean / 100;
  const cv = vol / 100 / growth;
  const sigma = Math.sqrt(Math.log(1 + cv * cv));
  const mu = Math.log(growth);
  let success = 0;
  const depletionAges = [];
  const finalAssets = [];
  for (let i = 0; i < runs; i++) {
    const rand = mulberry32(0x51ab1e + i * 7919);
    const normal = () => {
      const u1 = Math.max(rand(), 1e-9), u2 = rand();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const rateFn = () => Math.exp(mu + sigma * normal()) / (1 + inflRate) - 1;
    const res = calculateScenario(input, rateFn, assumptions, { lite: true });
    if (res.depletionAge === null) success++;
    else depletionAges.push(res.depletionAge);
    finalAssets.push(res.yearlyAssetFlow[res.yearlyAssetFlow.length - 1]?.financialAssets ?? 0);
  }
  depletionAges.sort((a, b) => a - b);
  finalAssets.sort((a, b) => a - b);
  const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
  return {
    runs,
    successRate: Math.round((success / runs) * 100),
    medianDepletionAge: pct(depletionAges, 0.5),
    p10Final: pct(finalAssets, 0.10),
    p50Final: pct(finalAssets, 0.50),
    p90Final: pct(finalAssets, 0.90),
  };
}


export { mulberry32, runMonteCarlo };
