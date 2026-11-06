import {defineConfig} from '@playwright/test';
export default defineConfig({
 testDir:'./tests/ui',timeout:30000,expect:{timeout:15000},
 use:{baseURL:'http://127.0.0.1:4175',trace:'retain-on-failure'},
 projects:[
  {name:'desktop',use:{browserName:'chromium',viewport:{width:1440,height:960}}},
  {name:'mobile',use:{browserName:'chromium',viewport:{width:390,height:844},isMobile:true,hasTouch:true}},
 ],
 webServer:{command:'npm run preview -- --host 127.0.0.1 --port 4175 --strictPort',url:'http://127.0.0.1:4175/',reuseExistingServer:!process.env.CI},
});
