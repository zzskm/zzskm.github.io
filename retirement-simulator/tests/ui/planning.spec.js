import {test,expect} from '@playwright/test';
import {KR_DEFAULTS} from '../../src/model/defaults.js';
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
 await page.reload();await inputPanel(page);await expect(page.getByLabel('퇴직 나이',{exact:true})).toHaveValue('62');
});
test('money precision and 억원 units round trip without slider-step rounding',async({page})=>{
 await page.goto('/retirement-simulator/');await inputPanel(page);
 const section=page.locator('#inputs-panel details').filter({has:page.locator('summary').filter({hasText:/자산/})}).first();
 await section.locator(':scope > summary').click();
 const money=page.getByLabel('저축성 자산 (예금·MMF 등)',{exact:true});
 await money.fill('1234.56');await money.press('Enter');
 await expect.poll(async()=>(await stored(page)).scenarios[0].input.savingsBalance).toBe(1234.56);
 await page.getByLabel('저축성 자산 (예금·MMF 등) 금액 단위').selectOption('10000');await money.fill('.5');await money.press('Enter');
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
 await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
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
