import { runMonteCarlo } from '../../model/monteCarlo.js';
import { findInsights } from '../../insights/recommendations.js';
import { exploreTargets } from '../../insights/targets.js';
export function computeAnalysis(input) {
 const start=performance.now();
 const mc=runMonteCarlo(input);
 const insights=findInsights(input,mc.successRate);
 const targets=exploreTargets(input);
 return {mc,insights,targets,durationMs:Math.round(performance.now()-start)};
}
