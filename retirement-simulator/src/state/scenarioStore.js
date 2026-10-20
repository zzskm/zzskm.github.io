import { KR_DEFAULTS, SCENARIO_COLORS } from "../model/defaults.js";
import { normalizeInput } from "./migration.js";

const LS_KEY = "retirement-sim-v5";
const LEGACY_LS_KEYS = ["retirement-sim-v4", "retirement-sim-v3-stepwise", "retirement-sim-v2"];

function uid() { return Math.random().toString(36).slice(2, 9); }

function makeScenario(name, input, colorIdx) {
  return {
    id: uid(),
    name,
    color: SCENARIO_COLORS[colorIdx % SCENARIO_COLORS.length],
    input: normalizeInput(input),
  };
}

function loadInitial(storage) {
  let storageError = false;
  let warning = null;
  try { storage ??= globalThis.localStorage; } catch { storageError = true; warning = '브라우저 저장소에 접근할 수 없습니다. 이 탭의 변경사항은 새로고침 후 사라질 수 있습니다.'; }
  for (const key of [LS_KEY, ...LEGACY_LS_KEYS]) {
    try {
      const raw = storage?.getItem(key);
      if (!raw) continue;
      const obj = JSON.parse(raw);
      if (!Array.isArray(obj.scenarios) || !obj.scenarios.length) throw new Error('Invalid scenarios');
      const scenarios = obj.scenarios.map((s, idx) => {
        if (!s?.input || typeof s.input !== 'object') throw new Error('Invalid scenario');
        return { ...s, id: s.id || uid(), color: s.color || SCENARIO_COLORS[idx % SCENARIO_COLORS.length], input: normalizeInput(s.input) };
      });
      return { scenarios, activeId: scenarios.some(s=>s.id===obj.activeId)?obj.activeId:scenarios[0].id,
        isNew: false, storageError, warning, wasLegacyMigrated: key === 'retirement-sim-v4' };
    } catch {
      if (key === LS_KEY) storageError = true;
      warning = '읽을 수 없는 저장 데이터가 있어 원본을 유지했습니다. 백업 파일로 복원하거나 다른 저장 설정을 확인해주세요.';
    }
  }
  const base = makeScenario(`퇴직 ${KR_DEFAULTS.retireAge}세`, KR_DEFAULTS, 0);
  return { scenarios: [base], activeId: base.id, isNew: true, storageError, warning };
}
function saveScenarios(scenarios, activeId, storage) {
  try {
    storage ??= globalThis.localStorage;
    const raw = storage.getItem(LS_KEY);
    // Keep the exact pre-refactor payload before the first write. Do not replace it later.
    if (raw && !storage.getItem('retirement-sim-recovery-v5')) storage.setItem('retirement-sim-recovery-v5', raw);
    storage.setItem(LS_KEY, JSON.stringify({ scenarios, activeId }));
    return true;
  } catch { return false; }
}

const ADV_KEY = "retirement-sim-advanced";
const VERSION_KEY = "retirement-sim-assumptions-version";
const WIZARD_KEY = "retirement-sim-wizard-seen";
const AUTO_NAME_RE = /^퇴직 \d+세$/;   // 자동 생성 이름만 퇴직 나이 변경 시 따라 바뀐다 (사용자가 붙인 이름은 보존)

function readFlag(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeFlag(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// 시나리오 이름 인라인 편집 (Esc 취소 / Enter·포커스 이탈 확정)

export { LS_KEY, LEGACY_LS_KEYS, uid, makeScenario, loadInitial, saveScenarios, ADV_KEY, VERSION_KEY, WIZARD_KEY, AUTO_NAME_RE, readFlag, writeFlag };
