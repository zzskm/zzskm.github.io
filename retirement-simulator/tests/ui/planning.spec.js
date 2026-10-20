import {test,expect} from '@playwright/test';
import {KR_DEFAULTS} from '../../src/model/defaults.js';
import {normalizeInput} from '../../src/state/migration.js';
import {runScenarioBand} from '../../src/model/scenarios.js';
import {runMonteCarlo} from '../../src/model/monteCarlo.js';
import {ASSUMPTIONS} from '../../src/model/assumptions.js';
const base={id:'base',name:'기본 계획',color:'#3b82f6',input:KR_DEFAULTS};
test.beforeEach(async({page})=>{
 await page.addInitScript(({base,version})=>{
  if(!localStorage.getItem('retirement-sim-v5'))localStorage.setItem('retirement-sim-v5',JSON.stringify({scenarios:[base],activeId:'base'}));
  localStorage.setItem('retirement-sim-assumptions-version',version);
 },{base,version:ASSUMPTIONS.version});
});
async function inputPanel(page){const tab=page.getByRole('tab',{name:'입력',exact:true});if(await tab.isVisible())await tab.click();}
async function resultsPanel(page){const tab=page.getByRole('tab',{name:'결과',exact:true});if(await tab.isVisible())await tab.click();}
async function stored(page){return page.evaluate(()=>JSON.parse(localStorage.getItem('retirement-sim-v5')));}
test('old URL preserves settings, query and fragment and boots the built app',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/retirement_simulator.html?source=legacy#plan');
 await expect(page).toHaveURL(/retirement-simulator\/\?source=legacy#plan/);
 await expect(page.getByRole('heading',{name:'은퇴 현금흐름 시뮬레이터'})).toBeVisible();
 await expect(page.getByText('이 모델의 표본에서', {exact:false})).toBeVisible();
 expect((await stored(page)).scenarios[0].input.investmentBalance).toBe(5000);
 expect(errors).toEqual([]);
});
test('numeric editing preserves blank draft, Escape cancels, Enter commits and refresh keeps it',async({page})=>{
 await page.goto('/retirement-simulator/');await inputPanel(page);
 const age=page.getByLabel('퇴직 나이',{exact:true});await age.fill('');await expect(age).toHaveValue('');
 expect((await stored(page)).scenarios[0].input.retireAge).toBe(60);
 await age.fill('62');await age.press('Escape');await expect(age).toHaveValue('60');
 await age.fill('62');await age.press('Enter');
 await expect.poll(async()=>(await stored(page)).scenarios[0].input.retireAge).toBe(62);
 await page.reload();await inputPanel(page);
 const profile=page.locator('#inputs-panel details').filter({has:page.locator('summary').filter({hasText:/프로필/})}).first();
 if(!(await profile.locator(':scope > summary').isVisible())) throw new Error('프로필 섹션을 찾을 수 없습니다');
 if(!(await profile.evaluate(el=>el.open))) await profile.locator(':scope > summary').click();
 await expect(page.locator('[data-field-key="retireAge"]')).toHaveValue('62');
});
test('money precision and 억원 units round trip without slider-step rounding',async({page})=>{
 await page.goto('/retirement-simulator/');await inputPanel(page);
 const section=page.locator('#inputs-panel details').filter({has:page.locator('summary').filter({hasText:/자산/})}).first();
 await section.locator(':scope > summary').click();
 const money=page.getByLabel('저축성 자산 (예금·MMF 등)',{exact:true});
 await money.fill('1234.56');await money.press('Enter');
 await expect.poll(async()=>(await stored(page)).scenarios[0].input.savingsBalance).toBe(1234.56);
 await page.locator('[data-unit-key="savingsBalance"]').selectOption('10000');
 const savings=page.locator('[data-field-key="savingsBalance"]');await savings.fill('.5');await savings.press('Enter');
 await expect.poll(async()=>(await stored(page)).scenarios[0].input.savingsBalance).toBe(5000);
});
test('wizard resumes and selectively merges settings without an automatic comparison',async({page})=>{
 await page.goto('/retirement-simulator/');await page.getByRole('button',{name:'🪄 빠른 설정'}).click();
 let dialog=page.getByRole('dialog');await dialog.getByLabel('희망 퇴직 나이',{exact:true}).fill('63');await dialog.getByLabel('희망 퇴직 나이',{exact:true}).press('Enter');
 await dialog.getByRole('button',{name:'다음',exact:true}).click();
 await dialog.getByRole('button',{name:'빠른 설정 닫기'}).click();await page.reload();
 await page.getByRole('button',{name:'🪄 빠른 설정'}).click();dialog=page.getByRole('dialog');await expect(dialog.getByText(/2\/5 · 가구 상황/)).toBeVisible();
 for(let n=0;n<3;n++)await dialog.getByRole('button',{name:'다음',exact:true}).click();
 await dialog.getByRole('button',{name:'계획에 반영'}).click();await expect(dialog).not.toBeVisible();
 await expect.poll(async()=>(await stored(page)).scenarios[0].input.retireAge).toBe(63);
 expect((await stored(page)).scenarios).toHaveLength(1);
 expect((await stored(page)).scenarios[0].input.investmentReturnRate).toBe(6);
});
test('wizard prevents invalid ages and traps keyboard focus',async({page})=>{
 await page.goto('/retirement-simulator/');await page.getByRole('button',{name:'🪄 빠른 설정'}).click();const dialog=page.getByRole('dialog');
 const age=dialog.getByLabel('희망 퇴직 나이',{exact:true});await age.fill('30');await age.press('Enter');
 await expect(dialog.getByRole('button',{name:'다음',exact:true})).toBeDisabled();
 await dialog.getByRole('button',{name:'빠른 설정 닫기'}).focus();await page.keyboard.press('Shift+Tab');
 expect(await page.evaluate(()=>document.activeElement.closest('[role="dialog"]')!==null)).toBe(true);
 await dialog.getByRole('button',{name:'빠른 설정 닫기'}).focus();
 await page.keyboard.press('Escape');
 await expect(dialog).not.toBeVisible();
});
test('JSON import adds a comparison and keeps existing input intact',async({page})=>{
 await page.goto('/retirement-simulator/');
 const imported={scenarios:[{...base,name:'복원 계획',input:{...KR_DEFAULTS,retireAge:64}}]};
 await page.locator('input[type="file"]').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});
 await expect.poll(async()=>(await stored(page)).scenarios.length).toBe(2);
 const plans=(await stored(page)).scenarios;expect(plans[0].input.retireAge).toBe(60);expect(plans[1].input.retireAge).toBe(64);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'JSON 백업 내보내기'}).click();expect((await download).suggestedFilename()).toBe('retirement-scenarios.json');
});
test('diagnosis creates a comparison and stays within the mobile viewport',async({page})=>{
 await page.goto('/retirement-simulator/');await resultsPanel(page);
 const panel=page.getByRole('region',{name:'위험 원인과 조정 범위'});await expect(panel).toBeVisible();
 await panel.getByRole('button',{name:'비교 시나리오 만들기'}).first().click();
 await expect.poll(async()=>(await stored(page)).scenarios.length).toBe(2);
 expect((await stored(page)).scenarios[0].input.retireAge).toBe(60);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
});
test('shock diagnosis creates a comparison whose primary result applies the shock',async({page})=>{
 await page.goto('/retirement-simulator/');await resultsPanel(page);
 const panel=page.getByRole('region',{name:'위험 원인과 조정 범위'}),shock=panel.getByText('퇴직 초기 시장 충격',{exact:true}).locator('..');
 await shock.getByRole('button',{name:'비교 시나리오 만들기'}).click();
 await expect.poll(async()=>(await stored(page)).scenarios[1]?.input.projectionStress).toBe(true);
 expect((await stored(page)).scenarios[0].input.projectionStress).not.toBe(true);
 const input=normalizeInput({...KR_DEFAULTS,projectionStress:true,stressTest:'severe'}),expected=runScenarioBand(input).mid,mc=runMonteCarlo(input);
 await expect(page.getByText(new RegExp(`선택한 시장 충격을 반영한 경로.*준비율 ${expected.readinessRatio}%`))).toBeVisible();
 await expect(page.getByText(/성공확률 —/).locator('..').getByText(`${mc.successRate}%`,{exact:true})).toBeVisible();
 await expect(page.getByText(/기본 결과·그래프·성공 비율에 시장 충격/)).toBeVisible();await page.reload();await expect(page.getByText(/기본 결과·그래프·성공 비율에 시장 충격/)).toBeVisible();
});
test('hidden invalid wizard fields do not block other steps or household choices',async({page})=>{
 await page.goto('/retirement-simulator/');await page.getByRole('button',{name:'🪄 빠른 설정'}).click();
 const dialog=page.getByRole('dialog'),next=dialog.getByRole('button',{name:'다음',exact:true});await next.click();
 const spouse=dialog.getByRole('switch',{name:'배우자 있음'});if(await spouse.getAttribute('aria-checked')==='false')await spouse.click();
 const age=dialog.getByLabel('배우자 퇴직 나이',{exact:true});await age.fill('');await age.press('Tab');await expect(next).toBeDisabled();await expect(age).toHaveValue('');
 await spouse.click();await expect(next).toBeEnabled();await next.click();
 const salary=dialog.getByLabel('본인 소득 연봉',{exact:true});await salary.fill('');await salary.press('Tab');await expect(next).toBeDisabled();
 await dialog.getByRole('button',{name:'이전',exact:true}).click();await expect(next).toBeEnabled();await next.click();await expect(next).toBeEnabled();
 await dialog.getByLabel('국민연금 예상액',{exact:false}).selectOption('manual');
 const pension=dialog.getByLabel('본인 예상 국민연금 (월)',{exact:true});await pension.fill('');await pension.press('Tab');await expect(next).toBeDisabled();
 await dialog.getByLabel('국민연금 예상액',{exact:false}).selectOption('auto');await expect(next).toBeEnabled();
});
test('field and section resets restore default provenance',async({page})=>{
 await page.goto('/retirement-simulator/');await inputPanel(page);
 const age=page.locator('[data-field-key="retireAge"]');await age.fill('63');await age.press('Enter');await expect.poll(async()=>(await stored(page)).scenarios[0].input._sources.retireAge).toBe('user');
 await page.getByRole('button',{name:'퇴직 나이 기본값 복원',exact:true}).click();await expect.poll(async()=>(await stored(page)).scenarios[0].input._sources.retireAge).toBeUndefined();await expect(age).toHaveValue(String(KR_DEFAULTS.retireAge));
 const section=page.locator('#inputs-panel details').filter({has:page.locator('summary').filter({hasText:/자산/})}).first();await section.locator(':scope > summary').click();
 const savings=page.locator('[data-field-key="savingsBalance"]');await savings.fill('1234');await savings.press('Enter');await section.getByRole('button',{name:'자산 기본값 복원',exact:true}).click();
 await expect(savings).toHaveValue(String(KR_DEFAULTS.savingsBalance));await expect.poll(async()=>(await stored(page)).scenarios[0].input._sources.savingsBalance).toBeUndefined();
});
test('repeated imports can be exported and the complete backup restored',async({page})=>{
 await page.goto('/retirement-simulator/');
 const plans=Array.from({length:6},(_,n)=>({...base,id:`import-${n}`,name:`복원 ${n}`})),file={name:'plans.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({scenarios:plans}))};
 await page.locator('input[type="file"]').setInputFiles(file);await expect.poll(async()=>(await stored(page)).scenarios.length).toBe(7);
 await page.locator('input[type="file"]').setInputFiles(file);await expect.poll(async()=>(await stored(page)).scenarios.length).toBe(13);
 const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'JSON 백업 내보내기'}).click();const download=await downloaded,stream=await download.createReadStream(),chunks=[];
 for await(const chunk of stream)chunks.push(chunk);const buffer=Buffer.concat(chunks);expect(JSON.parse(buffer.toString()).scenarios).toHaveLength(13);
 await page.evaluate(()=>{localStorage.removeItem('retirement-sim-v5');});await page.reload();await page.locator('input[type="file"]').setInputFiles({name:'restored.json',mimeType:'application/json',buffer});
 await expect.poll(async()=>(await stored(page)).scenarios.length).toBe(14);
});
