// Replay the production pure engine, not a Python copy of its decisions.
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const current=require('../alarm.js');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const reference=input.referenceEngine ? require(input.referenceEngine) : current;
const output=[];
for(const c of input.cases){
  const engine=c.reference ? reference : current;
  let ledger=engine.emptyLedger(), prev=null, latest=null, i=0;
  const actions=[];
  for(let now=c.startMs;now<=c.endMs;now+=c.tickMs||1000){
    while(i<c.events.length && c.events[i].atMs<=now) latest=c.events[i++].status;
    if((c.pauses||[]).some(p=>now>=p[0] && now<p[1])) continue;
    // Same persistent reservation/ledger contract as a page reload.
    if((c.reloads||[]).includes(now)) prev=JSON.parse(JSON.stringify(prev));
    const snap=engine.assessStatus(latest,now,{safetyMode:c.safetyMode,maxAgeMin:c.safetyMode?3:13});
    const out=engine.evaluate({cfg:c.cfg,snap,ledger,prevTarget:prev,nowMs:now,
                              walkMinutes:c.walkMinutes,marginSec:c.marginSec});
    ledger=out.ledger;prev=out.prevTarget;
    for(const action of out.actions) actions.push({atMs:now,pollMs:out.view.target?.pollMs||snap.pollMs,action});
  }
  output.push({id:c.id,actions});
}
process.stdout.write(JSON.stringify(output));
