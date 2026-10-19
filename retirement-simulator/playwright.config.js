import {defineConfig} from '@playwright/test';
export default defineConfig({
 testDir:'./tests/ui',timeout:30000,expect:{timeout:15000},fullyParallel:true,
 use:{baseURL:'http://127.0.0.1:4173',trace:'retain-on-failure'},
 projects:[{name:'desktop',use:{browserName:'chromium',viewport:{width:1440,height:1000}}},{name:'mobile',use:{browserName:'chromium',viewport:{width:390,height:844},isMobile:true,hasTouch:true}},{name:'tablet',use:{browserName:'chromium',viewport:{width:768,height:1024}}}],
 webServer:{command:'npm run serve:test',url:'http://127.0.0.1:4173/retirement-simulator/',reuseExistingServer:!process.env.CI},
});
