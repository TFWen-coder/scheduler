import { generateSchedule } from './scheduler.js';
const scenarios = [
  { label: '2026/8 無休假', y: 2026, m: 8, vac: {} },
  { label: '2026/9 無休假', y: 2026, m: 9, vac: {} },
  { label: '2026/8 一般休假', y: 2026, m: 8, vac: {
    '雅卉': [3,4,5], '慈顯': [10,11], '仕賢': [20,21,22], '怡庭': [1,2], '莉婷': [15,16],
  } },
  { label: '2026/9 密集休假', y: 2026, m: 9, vac: {
    '雅卉': [7,8,9,10], '樂樂': [7,8,9], '毛毛': [8,9,10], '仕賢': [1,2,3], '彤彤': [25,26,27], 'Erin': [20,21],
  } },
];
for (const s of scenarios) {
  const r = generateSchedule(s.y, s.m, s.vac, { timeLimitMs: 15000 });
  const byRule = {};
  for (const v of r.hardViolations) byRule[v.ruleId] = (byRule[v.ruleId] ?? 0) + 1;
  console.log(`═══ ${s.label} ═══`);
  console.log(`硬違反 ${r.hardViolations.length} ${JSON.stringify(byRule)} | 軟提醒 ${r.softViolations.length} | 缺口 ${r.unfilled.length}（共缺 ${r.unfilled.reduce((a,u)=>a+u.shortBy,0)} 人次）`);
  if (process.env.VERBOSE) {
    for (const v of r.hardViolations.slice(0,15)) console.log(`  [${v.ruleId}] ${v.message}`);
    console.log('  缺口:', r.unfilled.map(u=>`${u.day}日${u.position}缺${u.shortBy}`).join(', '));
  }
  console.log('工作天數:', JSON.stringify(r.workdayCount));
}
