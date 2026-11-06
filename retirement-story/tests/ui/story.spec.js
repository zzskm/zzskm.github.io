import {test,expect} from '@playwright/test';
import {KR_DEFAULTS} from '../../../retirement-simulator/src/model/defaults.js';

test('demo journey renders with a real projection and navigable age controls',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');
 await expect(page.getByRole('heading',{name:/나의 은퇴 연대기/})).toBeVisible();
 await expect(page.getByRole('region',{name:'은퇴 후 선택지 비교'})).toBeVisible();
 await expect(page.getByText('노후 준비율',{exact:false}).first()).toBeVisible();
 await expect(page.getByLabel('이야기 연령 이동')).toHaveValue(String(KR_DEFAULTS.currentAge));
 await page.getByRole('button',{name:'다음 중요 이벤트'}).click();
 await expect(page.getByLabel('이야기 연령 이동')).not.toHaveValue(String(KR_DEFAULTS.currentAge));
 await page.getByRole('button',{name:'재생',exact:true}).click();
 await expect(page.getByRole('button',{name:'일시정지',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'일시정지',exact:true}).click();
 await page.getByRole('button',{name:'월 생활비를 30만 줄인다'}).click();
 await expect(page.getByText('기준 계획 대비 변화')).toBeVisible();
 expect(errors).toEqual([]);
});
test('privacy toggle hides balances and reset restores original path',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'금액 숨기기'}).click();
 await expect(page.getByRole('button',{name:'금액 보기'})).toBeVisible();
 await expect(page.getByText('금액 숨김',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'대출 적극 상환'}).click();
 await expect(page.getByRole('button',{name:'기준 계획 복원'})).toBeVisible();
 await page.getByRole('button',{name:'기준 계획 복원'}).click();
 await expect(page.getByText('기준 계획 대비 변화')).toHaveCount(0);
});
test('saved local scenario is loaded only when explicitly requested',async({page})=>{
 await page.addInitScript(input=>localStorage.setItem('retirement-sim-v5',JSON.stringify({
   scenarios:[{id:'my',name:'개인 계획',input:{...input,retireAge:63}}],activeId:'my'
 })),KR_DEFAULTS);
 await page.goto('/');
 await expect(page.locator('#plan-select')).toHaveValue('demo');
 await page.getByRole('button',{name:'저장된 계획 불러오기'}).click();
 await expect(page.locator('#plan-select')).not.toHaveValue('demo');
 await expect(page.locator('#plan-select')).toContainText('개인 계획');
 await expect(page.getByText('63세, 은퇴')).toBeVisible();
});
test('small viewport does not overflow document horizontally',async({page})=>{
 await page.goto('/');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
});

test('story uses a single light theme without an OS dark-mode variant',async({page})=>{
 await page.emulateMedia({colorScheme:'dark'});
 await page.goto('/');
 const theme=await page.evaluate(()=>({
  scheme:getComputedStyle(document.documentElement).colorScheme,
  header:getComputedStyle(document.querySelector('.topbar')).backgroundColor,
  body:getComputedStyle(document.querySelector('.site')).backgroundColor,
 }));
 expect(theme.scheme).toBe('light');
 expect(theme.header).toMatch(/rgba?\(255, 255, 255/);
 await expect(page.getByRole('region',{name:'내 캐릭터 만들기'})).toBeVisible();
});

test('five persona cards update the draft and not the active story until submitted',async({page})=>{
 await page.goto('/');
 const setup=page.getByRole('region',{name:'내 캐릭터 만들기'});
 const cards=setup.locator('.persona-card');
 await expect(cards).toHaveCount(5);
 await expect(page.getByLabel('이야기 연령 이동')).toHaveValue(String(KR_DEFAULTS.currentAge));
 await setup.getByRole('button',{name:/나만의 탐험가/}).click();
 await expect(setup.getByLabel('배우자 세후 월급')).toHaveCount(0);
 await setup.getByRole('button',{name:/세 아이의 설계자/}).click();
 await expect(setup.getByLabel('배우자 세후 월급')).toBeVisible();
 await expect(page.getByLabel('이야기 연령 이동')).toHaveValue(String(KR_DEFAULTS.currentAge));
 await setup.getByRole('button',{name:/주거·가족·은퇴 후 생활비 자세히 설정/}).click();
 await expect(setup.getByLabel('자녀 수')).toHaveValue('3');
 await setup.getByLabel('현재 나이',{exact:true}).fill('43');
 await setup.getByLabel('목표 은퇴 나이',{exact:true}).fill('52');
 await setup.getByLabel('내 캐릭터 이름').fill('미래 여행자');
 await setup.getByRole('button',{name:/이 설정으로 스토리 시작/}).click();
 await expect(setup).toHaveCount(0);
 await expect(page.getByLabel('이야기 연령 이동')).toHaveValue('43');
 await expect(page.getByText('미래 여행자 · 세 아이의 설계자')).toBeVisible();
 await page.getByRole('button',{name:'캐릭터·정보 수정'}).click();
 await expect(page.getByRole('region',{name:'내 캐릭터 만들기'}).getByLabel('현재 나이',{exact:true})).toHaveValue('43');
});

test('invalid quick form blocks changes, cancel preserves the active scenario',async({page})=>{
 await page.goto('/');
 const setup=page.getByRole('region',{name:'내 캐릭터 만들기'});
 const current=String(KR_DEFAULTS.currentAge);
 await setup.getByLabel('목표 은퇴 나이',{exact:true}).fill(current);
 await setup.getByRole('button',{name:/이 설정으로 스토리 시작/}).click();
 await expect(setup.getByRole('alert')).toContainText('은퇴 나이');
 await expect(page.getByLabel('이야기 연령 이동')).toHaveValue(current);
 await setup.getByRole('button',{name:/나만의 탐험가/}).click();
 await setup.getByRole('button',{name:'취소',exact:true}).click();
 await expect(page.getByText('나 · 한 아이의 길잡이')).toBeVisible();
 await expect(page.getByLabel('이야기 연령 이동')).toHaveValue(current);
});
