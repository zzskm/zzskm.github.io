import { ASSUMPTIONS } from '../model/assumptions.js';
import { KR_DEFAULTS, UI_RANGES, SCENARIO_COLORS } from '../model/defaults.js';
import { normalizeInput } from './migration.js';
import { validateInput } from '../model/validation.js';
export const BACKUP_FORMAT = 'retirement-simulator';
export function serializeBackup(scenarios, activeId) {
  return JSON.stringify({format:BACKUP_FORMAT,version:1,assumptionVersion:ASSUMPTIONS.version,exportedAt:new Date().toISOString(),activeId,scenarios},null,2);
}
export function parseBackup(text) {
  if (text.length > 2_000_000) throw new Error('백업 파일은 2MB 이하여야 합니다.');
  const obj=JSON.parse(text);
  if (!obj || typeof obj !== 'object' || (obj.format && obj.format!==BACKUP_FORMAT) || (obj.version && obj.version!==1)) throw new Error('지원하지 않는 백업 형식입니다.');
  if (!Array.isArray(obj.scenarios) || !obj.scenarios.length || obj.scenarios.length>12) throw new Error('시나리오는 한 번에 12개까지 가져올 수 있습니다.');
  const ids=new Set();
  const scenarios=obj.scenarios.map((s,idx)=>{
    if (!s || typeof s.input!=='object' || !s.input || Array.isArray(s.input)) throw new Error('시나리오 입력이 없습니다.');
    if (Array.isArray(s.input.children) && s.input.children.length>5) throw new Error('자녀는 시나리오마다 5명까지 입력할 수 있습니다.');
    const input=normalizeInput(s.input);
    for(const [key,def] of Object.entries(KR_DEFAULTS)) {
      if(typeof def==='number' && (typeof input[key]!=='number'||!Number.isFinite(input[key]))) throw new Error(`${key}: 숫자가 필요합니다.`);
      if(typeof def==='boolean' && typeof input[key]!=='boolean') throw new Error(`${key}: 선택값을 확인해주세요.`);
    }
    for(const [key,range] of Object.entries(UI_RANGES)) {
      const v=input[key], hi=Math.max(range.max,range.typedMax??range.max);
      // Accept existing ages and zero living costs from legacy versions, but bound imported work.
      if(v < (['workingLivingCost','bridgeLivingCost','retirementLivingCost'].includes(key)?0:range.min) || v > hi) throw new Error(`${key}: 허용 범위를 벗어났습니다.`);
    }
    const enums={housingMode:['own','jeonse','monthly_rent'],withdrawalStrategy:['bucket','4pct','vpw'],stressTest:['none','mild','severe','2008'],housingInflationScenario:['stable','realistic','stress'],selfNpInputMode:['auto','manual'],spouseNpInputMode:['auto','manual'],selfSalaryBasis:['gross','net'],spouseSalaryBasis:['gross','net']};
    for(const [k,values] of Object.entries(enums)) if(!values.includes(input[k])) throw new Error(`${k}: 지원하지 않는 선택값입니다.`);
    if(input.selfLifeExpectancy<=input.currentAge || (input.spouseEnabled && input.spouseLifeExpectancy<=input.spouseCurrentAge)) throw new Error('계획 수명은 현재 나이보다 커야 합니다.');
    const invalid=validateInput(input).find(w=>w.level==='error');
    if(invalid) throw new Error(invalid.msg);
    if(input.children.some(c=>!Number.isInteger(c.birthYear)||c.birthYear<1900||c.birthYear>2100)) throw new Error('자녀 출생 연도를 확인해주세요.');
    const id=typeof s.id==='string'&&s.id&&!ids.has(s.id)?s.id:`import-${idx}`;ids.add(id);
    return {...s,id,name:String(s.name||`시나리오 ${idx+1}`).slice(0,80),color:SCENARIO_COLORS[idx%SCENARIO_COLORS.length],input};
  });
  return {scenarios,activeId:scenarios.some(s=>s.id===obj.activeId)?obj.activeId:scenarios[0].id};
}
