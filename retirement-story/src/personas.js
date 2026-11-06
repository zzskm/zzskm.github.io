import {HOUSEHOLD_PRESETS,createHouseholdPresetInput} from '../../retirement-simulator/src/features/comparison/householdPresets.js';

// These are fictional household *situations*, not psychological profiles.
// Monetary values come from existing starter scenarios, not inferred from avatar styling.
export const PERSONAS=Object.freeze([
 {id:'solo',title:'나만의 탐험가',short:'솔로',caption:'내 시간과 생활을 설계하는 1인 가구',accent:'#b88555',outfit:'#b67b52',hair:'#4b3a30'},
 {id:'couple',title:'함께 걷는 동반자',short:'무자녀 부부',caption:'두 사람의 은퇴 시계를 맞추는 부부',accent:'#748c75',outfit:'#688c83',hair:'#554036'},
 {id:'one-child',title:'한 아이의 길잡이',short:'1자녀',caption:'나의 노후와 아이의 미래를 함께 준비',accent:'#cb8d7d',outfit:'#cd8175',hair:'#453b3c'},
 {id:'two-children',title:'두 아이의 항해자',short:'2자녀',caption:'교육비와 은퇴자금 사이의 균형',accent:'#667fa4',outfit:'#7388aa',hair:'#413b38'},
 {id:'three-children',title:'세 아이의 설계자',short:'3자녀',caption:'긴 양육기와 은퇴 전환을 함께 계획',accent:'#a28b65',outfit:'#9f876c',hair:'#514036'},
].map(meta=>Object.freeze({...meta,household:HOUSEHOLD_PRESETS.find(h=>h.id===meta.id)})));

export function getPersona(id) {return PERSONAS.find(p=>p.id===id)??null;}
export function inferPersonaId(input) {
 const kids=Array.isArray(input?.children)?input.children.length:0;
 if(input?.spouseEnabled===false)return 'solo';
 return ['couple','one-child','two-children','three-children'][Math.min(3,kids)];
}
export function createPersonaInput(id) {return createHouseholdPresetInput(id);}
