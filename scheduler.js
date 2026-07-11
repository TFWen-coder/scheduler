/**
 * @file scheduler.js — 獸醫院排班演算法
 * Phase 3b：修正版純函數演算法，不含 UI 操作、不存 localStorage
 *
 * 兩階段策略：
 *   階段 1 — 逐日貪婪建構（catClinic→pharmacy→counter，配速 + 連班段建構）
 *     - 建構期即強制 [H5]：連班 ≤3、連班後休 ≥2、不產生「上一休一」鋸齒
 *     - 訓練者安插受可用性／工時／連班檢查約束（修正訓練者爆班問題）
 *     - 分層放寬（strict → relaxed → exception）處理人力不足
 *   階段 1.5 — 補位掃描（canInsertDay 前後雙向檢查，不破壞 H5）
 *   階段 2 — Hill Climbing 軟規則優化
 *     - 評分納入硬規則懲罰（-300/條），不會為了軟規則破壞硬規則
 *     - 新增「同日跨位置對換」移動（零 H5 風險，專攻軟規則）
 */

import {
  staff,
  positionRequirements,
  workHoursConfig,
  monthlyConstraints,
} from './data.js';

// ─── JSDoc 型別定義 ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} Assignment
 * @property {number} day
 * @property {'counter'|'pharmacy'|'catClinic'} position
 */

/**
 * @typedef {Object} Violation
 * @property {string}    ruleId
 * @property {string}    message
 * @property {number}    [day]
 * @property {string[]}  [staff]
 */

/**
 * @typedef {Object} ProgressInfo
 * @property {'phase1'|'phase2'|'done'} stage
 * @property {string}  message
 * @property {number}  percent
 */

/**
 * @typedef {Object} ScheduleResult
 * @property {Object<string, Assignment[]>}                      schedule
 * @property {Violation[]}                                       hardViolations
 * @property {Violation[]}                                       softViolations
 * @property {{day:number, position:string, shortBy:number}[]}  unfilled
 * @property {Object<string, number>}                            workdayCount
 * @property {string}                                            summary
 */

// ─── 模組內快取 ───────────────────────────────────────────────────────────────

/** @type {Map<string, import('./data.js').StaffMember>} */
const staffByName = new Map(staff.map(p => [p.name, p]));

const POSITIONS = /** @type {const} */ (['counter', 'pharmacy', 'catClinic']);

// 填位順序：最受限位置優先
const FILL_ORDER = /** @type {const} */ (['catClinic', 'pharmacy', 'counter']);

// ─── 日期工具 ────────────────────────────────────────────────────────────────

function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

function weekdayOf(y, m, d) {
  return new Date(y, m - 1, d).getDay();
}

// ─── 月份前置計算 ─────────────────────────────────────────────────────────────

/**
 * 計算各人員本月可排天數上限（考慮 H8 170h 與 H9 外單位扣時）
 * @param {number} y
 * @param {number} m
 * @returns {Map<string, number>}
 */
function computeMaxWorkdays(y, m) {
  const total = daysInMonth(y, m);
  const result = new Map();
  for (const p of staff) {
    if (p.role === 'flex') { result.set(p.name, Infinity); continue; }
    let extDays = 0;
    if (p.externalDuty) {
      for (let d = 1; d <= total; d++) {
        if (p.externalDuty.weekdays.includes(weekdayOf(y, m, d))) extDays++;
      }
    }
    const extHours = extDays * (p.externalDuty?.hoursPerDay ?? 0);
    const max = Math.floor(
      (workHoursConfig.monthlyHoursLimit.regular - extHours) /
      workHoursConfig.hoursPerDay
    );
    result.set(p.name, max);
  }
  return result;
}

/**
 * 計算各人員本月可上班日集合（排除休假、forbiddenWeekdays、機動平日）
 * @param {number} y
 * @param {number} m
 * @param {Object<string, number[]>} vacations
 * @returns {Map<string, Set<number>>}
 */
function computeAvailableDays(y, m, vacations) {
  const total = daysInMonth(y, m);
  const result = new Map();
  for (const p of staff) {
    const vacSet = new Set(vacations[p.name] ?? []);
    const avail = new Set();
    for (let d = 1; d <= total; d++) {
      const wd = weekdayOf(y, m, d);
      if (vacSet.has(d)) continue;
      if (p.forbiddenWeekdays.includes(wd)) continue;
      if (p.workableDays === 'weekendOnly' && wd !== 0 && wd !== 6) continue;
      avail.add(d);
    }
    result.set(p.name, avail);
  }
  return result;
}

/**
 * 計算各人員本月「目標排班天數」（配速用，非硬限制）
 * 先扣除機動可貢獻人力，再依可排天數上限對常規人員做 waterfill 均分。
 * @param {number} y
 * @param {number} m
 * @param {Map<string, Set<number>>} availMap
 * @param {Map<string, number>} maxWorkdays
 * @returns {Map<string, number>}
 */
function computeTargets(y, m, availMap, maxWorkdays) {
  const total = daysInMonth(y, m);
  const dailyNeed = POSITIONS.reduce((s, p) => s + positionRequirements[p].dailyStaff, 0);
  let remaining = dailyNeed * total;
  const targets = new Map();

  // 機動先扣（每可排日貢獻 countsAs 人力）
  for (const p of staff) {
    if (p.role !== 'flex') continue;
    const days = availMap.get(p.name)?.size ?? 0;
    targets.set(p.name, days);
    remaining -= days * p.countsAs;
  }

  // 常規人員 waterfill
  const regs = staff
    .filter(p => p.role === 'regular')
    .map(p => ({
      name: p.name,
      cap: Math.min(maxWorkdays.get(p.name) ?? 17, availMap.get(p.name)?.size ?? 0),
    }))
    .sort((a, b) => a.cap - b.cap);

  let left = regs.length;
  for (const r of regs) {
    const share = Math.ceil(Math.max(0, remaining) / Math.max(1, left));
    const t = Math.max(1, Math.min(r.cap, share));
    targets.set(r.name, t);
    remaining -= t;
    left--;
  }
  return targets;
}

// ─── 連班工具 ─────────────────────────────────────────────────────────────────

/**
 * 計算某人截至 day（含）的當前連班長度
 */
function currentStreak(name, day, dayMap) {
  let len = 0;
  for (let d = day; d >= 1; d--) {
    if (!isWorking(name, d, dayMap)) break;
    len++;
  }
  return len;
}

function isWorking(name, d, dayMap) {
  const posMap = dayMap.get(d);
  if (!posMap) return false;
  for (const names of posMap.values()) {
    if (names.includes(name)) return true;
  }
  return false;
}

/**
 * 判斷某人員在某星期是否「結構性不可排」（非真休息，不計入連班鋸齒）
 * @param {import('./data.js').StaffMember} person
 * @param {number} weekday  0=Sun … 6=Sat
 * @returns {boolean}
 */
function isUnavailable(person, weekday) {
  if (person.workableDays === 'weekendOnly' && weekday !== 0 && weekday !== 6) return true;
  if (person.forbiddenWeekdays.includes(weekday)) return true;
  return false;
}

// ─── H5 資格分層 ──────────────────────────────────────────────────────────────

const ELIG_NONE      = 0; // 不可排
const ELIG_STRICT    = 1; // 完全符合 H5
const ELIG_RELAXED   = 2; // 前段僅 1 天班、休 1 天（validator 合法，備援用）
const ELIG_EXCEPTION = 3; // 連 4 天例外（每月一次，人力不足時）

/**
 * 判斷某人第 d 天的 H5 排班資格（僅往回看，供逐日貪婪使用）
 * @returns {{ tier:number, continuing:boolean, streak:number }}
 */
function h5Eligibility(p, d, dayMap, y, m, consec) {
  if (p.role !== 'regular') return { tier: ELIG_STRICT, continuing: false, streak: 0 };

  const maxC    = monthlyConstraints.consecutive.maxDays;
  const maxE    = monthlyConstraints.consecutive.exceptionalMaxDays;
  const minRest = monthlyConstraints.consecutive.minRestAfter;

  const streak = currentStreak(p.name, d - 1, dayMap);
  if (streak > 0) {
    // 延續連班段
    if (streak < maxC) return { tier: ELIG_STRICT, continuing: true, streak };
    if (streak < maxE && !consec.usedException) return { tier: ELIG_EXCEPTION, continuing: true, streak };
    return { tier: ELIG_NONE, continuing: false, streak };
  }

  // 起始新連班段：找最近的工作日
  let last = 0;
  for (let dd = d - 1; dd >= 1; dd--) {
    if (isWorking(p.name, dd, dayMap)) { last = dd; break; }
  }
  if (last === 0) return { tier: ELIG_STRICT, continuing: false, streak: 0 }; // 月初尚未上班

  // 真休息天數（跳過結構性不可排日；休假日計入真休息，與 validator 一致）
  let trueRest = 0;
  for (let dd = last + 1; dd < d; dd++) {
    if (!isUnavailable(p, weekdayOf(y, m, dd))) trueRest++;
  }
  // 前段長度
  let segLen = 0;
  for (let dd = last; dd >= 1 && isWorking(p.name, dd, dayMap); dd--) segLen++;

  if (trueRest === 0 || trueRest >= minRest) return { tier: ELIG_STRICT, continuing: false, streak: 0 };
  // 前段僅 1 天班：validator 不要求休 2 天，備援放寬
  if (segLen === 1 && trueRest >= 1) return { tier: ELIG_RELAXED, continuing: false, streak: 0 };
  return { tier: ELIG_NONE, continuing: false, streak: 0 };
}

/**
 * 判斷把某人「插入」第 d 天是否不破壞 H5（前後雙向檢查，供補位掃描使用）
 * @returns {{ ok:boolean, exception:boolean }}
 */
function canInsertDay(p, d, dayMap, y, m, consec) {
  if (p.role !== 'regular') return { ok: true, exception: false };

  const total   = daysInMonth(y, m);
  const maxC    = monthlyConstraints.consecutive.maxDays;
  const maxE    = monthlyConstraints.consecutive.exceptionalMaxDays;
  const minRest = monthlyConstraints.consecutive.minRestAfter;

  // 合併後的連班段
  let back = 0;
  for (let dd = d - 1; dd >= 1 && isWorking(p.name, dd, dayMap); dd--) back++;
  let fwd = 0;
  for (let dd = d + 1; dd <= total && isWorking(p.name, dd, dayMap); dd++) fwd++;
  const segLen = back + 1 + fwd;

  let exception = false;
  if (segLen > maxC) {
    if (segLen <= maxE && !consec.usedException) exception = true;
    else return { ok: false, exception: false };
  }

  const start = d - back;
  const end   = d + fwd;

  // 往前檢查：前一段（若 ≥2 天）之後的真休息是否足夠
  let prevLast = 0;
  for (let dd = start - 1; dd >= 1; dd--) {
    if (isWorking(p.name, dd, dayMap)) { prevLast = dd; break; }
  }
  if (prevLast > 0) {
    let trueRest = 0;
    for (let dd = prevLast + 1; dd < start; dd++) {
      if (!isUnavailable(p, weekdayOf(y, m, dd))) trueRest++;
    }
    let prevLen = 0;
    for (let dd = prevLast; dd >= 1 && isWorking(p.name, dd, dayMap); dd--) prevLen++;
    if (prevLen >= 2 && trueRest > 0 && trueRest < minRest) return { ok: false, exception: false };
  }

  // 往後檢查：合併段（若 ≥2 天）之後的真休息是否足夠
  let nextFirst = 0;
  for (let dd = end + 1; dd <= total; dd++) {
    if (isWorking(p.name, dd, dayMap)) { nextFirst = dd; break; }
  }
  if (nextFirst > 0 && segLen >= 2) {
    let trueRest = 0;
    for (let dd = end + 1; dd < nextFirst; dd++) {
      if (!isUnavailable(p, weekdayOf(y, m, dd))) trueRest++;
    }
    if (trueRest > 0 && trueRest < minRest) return { ok: false, exception: false };
  }

  return { ok: true, exception };
}

// ─── 硬規則：整月驗證 ─────────────────────────────────────────────────────────

/**
 * 驗證整個排班違反的硬規則，回傳所有 Violation
 * @param {Map<number, Map<string, string[]>>} dayMap
 * @param {number} y
 * @param {number} m
 * @param {Map<string, number>} maxWorkdays
 * @returns {Violation[]}
 */
function validateHardRules(dayMap, y, m, maxWorkdays) {
  const violations = [];
  const total = daysInMonth(y, m);
  const workCount = new Map(staff.map(p => [p.name, 0]));

  for (let d = 1; d <= total; d++) {
    const wd = weekdayOf(y, m, d);
    const posMap = dayMap.get(d) ?? new Map();
    const onDuty = new Map(); // name → position

    for (const [pos, names] of posMap.entries()) {
      for (const name of names) {
        onDuty.set(name, pos);
        workCount.set(name, (workCount.get(name) ?? 0) + 1);
      }
    }

    // [H1] 位置能力
    for (const [name, pos] of onDuty) {
      if (!staffByName.get(name)?.positions.includes(pos)) {
        violations.push({ ruleId: 'H1', message: `第${d}天 ${name} 不能排 ${pos}`, day: d, staff: [name] });
      }
    }

    // [H2] catClinic 需有照
    const catNames = posMap.get('catClinic') ?? [];
    if (catNames.length > 0 && !catNames.some(n => staffByName.get(n)?.hasLicense)) {
      violations.push({ ruleId: 'H2', message: `第${d}天 catClinic 缺有照人員`, day: d, staff: catNames });
    }

    // [H3] 訓練配對
    for (const [name, pos] of onDuty) {
      const p = staffByName.get(name);
      if (!p?.needsTraining) continue;
      for (const req of p.needsTraining) {
        if (req.position !== pos) continue;
        if (!req.trainers.some(t => onDuty.get(t) === pos)) {
          violations.push({
            ruleId: 'H3',
            message: `第${d}天 ${name} 在 ${pos} 缺訓練者（需 ${req.trainers.join('/')}）`,
            day: d,
            staff: [name, ...req.trainers],
          });
        }
      }
    }

    // [H4] 禁排星期
    for (const [name] of onDuty) {
      if (staffByName.get(name)?.forbiddenWeekdays.includes(wd)) {
        violations.push({ ruleId: 'H4', message: `第${d}天（週${wd}）${name} 為禁排日`, day: d, staff: [name] });
      }
    }

    // [H6] 機動限週末
    for (const [name] of onDuty) {
      if (staffByName.get(name)?.workableDays === 'weekendOnly' && wd !== 0 && wd !== 6) {
        violations.push({ ruleId: 'H6', message: `第${d}天 ${name} 排在非週末`, day: d, staff: [name] });
      }
    }
  }

  // [H5] 連班規則（逐人全月掃描）
  // isUnavailable 日（forbiddenWeekdays / weekendOnly 平日）視為「結構性不可排」，
  // 不算真休息，但也不延伸連班段長度，不參與鋸齒偵測。
  for (const p of staff) {
    if (p.role !== 'regular') continue;

    // 找出所有連班段
    const segments = [];
    let segStart = -1;
    for (let d = 1; d <= total + 1; d++) {
      const working = d <= total && isWorking(p.name, d, dayMap);
      if (working && segStart === -1) {
        segStart = d;
      } else if (!working && segStart !== -1) {
        segments.push({ start: segStart, end: d - 1, length: d - segStart });
        segStart = -1;
      }
    }

    const maxAllowed = monthlyConstraints.consecutive.exceptionalMaxDays;
    const minRest    = monthlyConstraints.consecutive.minRestAfter;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];

      // 連班超過例外上限
      if (seg.length > maxAllowed) {
        violations.push({
          ruleId: 'H5',
          message: `${p.name} 第${seg.start}-${seg.end}天連班 ${seg.length} 天，超過上限 ${maxAllowed} 天`,
          staff: [p.name],
        });
      }

      // 連班 ≥2 天結束後須有 minRest 天真休息
      if (seg.length >= 2 && i + 1 < segments.length) {
        const gapStart = seg.end + 1;
        const gapEnd   = segments[i + 1].start - 1;
        let trueRest = 0;
        for (let d = gapStart; d <= gapEnd; d++) {
          if (!isUnavailable(p, weekdayOf(y, m, d))) trueRest++;
        }
        if (trueRest > 0 && trueRest < minRest) {
          violations.push({
            ruleId: 'H5',
            message: `${p.name} 第${seg.start}-${seg.end}天連班後僅休 ${trueRest} 天（需 ≥${minRest} 天）`,
            staff: [p.name],
          });
        }
      }
    }

    // 「上一休一」鋸齒模式偵測
    const realDays = [];
    for (let d = 1; d <= total; d++) {
      const wd = weekdayOf(y, m, d);
      if (isUnavailable(p, wd)) continue;
      realDays.push({ day: d, working: isWorking(p.name, d, dayMap) });
    }

    if (realDays.length >= 2) {
      let zigzag = 1;
      let zigzagStart = realDays[0].day;
      let prevW = realDays[0].working;

      for (let i = 1; i < realDays.length; i++) {
        const cur = realDays[i].working;
        if (cur !== prevW) {
          zigzag++;
        } else {
          if (zigzag >= 5) {
            violations.push({
              ruleId: 'H5',
              message: `${p.name} 第${zigzagStart}-${realDays[i - 1].day}天出現 ${zigzag} 次「上一休一」交替模式`,
              staff: [p.name],
            });
          }
          zigzag = 1;
          zigzagStart = realDays[i].day;
        }
        prevW = cur;
      }
      if (zigzag >= 5) {
        violations.push({
          ruleId: 'H5',
          message: `${p.name} 第${zigzagStart}-${realDays[realDays.length - 1].day}天出現 ${zigzag} 次「上一休一」交替模式`,
          staff: [p.name],
        });
      }
    }
  }

  // [H8][H9] 月工時上限
  for (const p of staff) {
    if (p.role === 'flex') continue;
    const count = workCount.get(p.name) ?? 0;
    const max = maxWorkdays.get(p.name) ?? 17;
    if (count > max) {
      violations.push({
        ruleId: p.externalDuty ? 'H9' : 'H8',
        message: `${p.name} 上班 ${count} 天，超過上限 ${max} 天`,
        staff: [p.name],
      });
    }
  }

  return violations;
}

/**
 * 單日快速硬規則驗證（供 hill climbing 內部使用）
 * @param {number} d
 * @param {Map<number, Map<string, string[]>>} dayMap
 * @param {number} y
 * @param {number} m
 * @param {Record<string,number>|null} [minPower]  各位置可接受的最低人力（null 表示嚴格等於需求）
 * @returns {boolean} true 表示合法
 */
function isDayValid(d, dayMap, y, m, minPower = null) {
  const wd = weekdayOf(y, m, d);
  const posMap = dayMap.get(d) ?? new Map();
  const onDuty = new Map();
  for (const [pos, names] of posMap) {
    for (const name of names) onDuty.set(name, pos);
  }

  // H1
  for (const [name, pos] of onDuty) {
    if (!staffByName.get(name)?.positions.includes(pos)) return false;
  }
  // H2
  const catNames = posMap.get('catClinic') ?? [];
  if (catNames.length > 0 && !catNames.some(n => staffByName.get(n)?.hasLicense)) return false;
  // H3
  for (const [name, pos] of onDuty) {
    const p = staffByName.get(name);
    if (!p?.needsTraining) continue;
    for (const req of p.needsTraining) {
      if (req.position !== pos) continue;
      if (!req.trainers.some(t => onDuty.get(t) === pos)) return false;
    }
  }
  // H4
  for (const [name] of onDuty) {
    if (staffByName.get(name)?.forbiddenWeekdays.includes(wd)) return false;
  }
  // H6
  for (const [name] of onDuty) {
    if (staffByName.get(name)?.workableDays === 'weekendOnly' && wd !== 0 && wd !== 6) return false;
  }
  // H7 每日人力需求（允許「等同或改善」：threshold = min(required, minPower)）
  for (const pos of POSITIONS) {
    const req = positionRequirements[pos].dailyStaff;
    const names = posMap.get(pos) ?? [];
    const power = names.reduce((s, n) => s + (staffByName.get(n)?.countsAs ?? 1), 0);
    const threshold = minPower != null ? Math.min(req, minPower[pos] ?? req) : req;
    if (power < threshold) return false;
  }
  return true;
}

// ─── 軟規則評分 ───────────────────────────────────────────────────────────────

/**
 * 計算軟規則總分（越高越好）與違反清單
 * @param {Map<number, Map<string, string[]>>} dayMap
 * @param {number} y
 * @param {number} m
 * @returns {{ score: number, violations: Violation[] }}
 */
function scoreSoftRules(dayMap, y, m) {
  const total = daysInMonth(y, m);
  let score = 0;
  const violations = [];

  // 統計每人每位置天數
  /** @type {Map<string, Record<string,number>>} */
  const posDays = new Map(staff.map(p => [p.name, { counter: 0, pharmacy: 0, catClinic: 0 }]));
  let xiaojiaXiaoyouOverlap = 0;

  for (let d = 1; d <= total; d++) {
    const posMap = dayMap.get(d) ?? new Map();
    const onDuty = new Map(); // name → position

    for (const [pos, names] of posMap) {
      for (const name of names) {
        onDuty.set(name, pos);
        const rec = posDays.get(name);
        if (rec) rec[pos] = (rec[pos] ?? 0) + 1;
      }
    }

    // [S4] 重疊配對同日（依 monthlyConstraints 設定；null = 停用）
    const ocPair = monthlyConstraints.xiaojiaXiaoyouOverlap?.staff;
    if (ocPair && onDuty.has(ocPair[0]) && onDuty.has(ocPair[1])) xiaojiaXiaoyouOverlap++;

    // [S2] avoidWith 違反（-5 分/次）
    const checked = new Set();
    for (const [name, pos] of onDuty) {
      const p = staffByName.get(name);
      if (!p) continue;
      for (const entry of p.avoidWith) {
        if (typeof entry === 'string') {
          const key = [name, entry].sort().join('|');
          if (!checked.has(key) && onDuty.has(entry)) {
            checked.add(key);
            score -= 5;
            violations.push({ ruleId: 'S2', message: `第${d}天 ${name} 與 ${entry} 同班`, day: d, staff: [name, entry] });
          }
        } else {
          // { person, position }
          const key = `${[name, entry.person].sort().join('|')}@${entry.position}@${d}`;
          if (!checked.has(key) && onDuty.get(entry.person) === entry.position && pos === entry.position) {
            checked.add(key);
            score -= 5;
            violations.push({ ruleId: 'S2', message: `第${d}天 ${name} 與 ${entry.person} 同排 ${entry.position}`, day: d, staff: [name, entry.person] });
          }
        }
      }
    }

    // softAvoidPairs（-1 分/天）
    for (const pair of monthlyConstraints.softAvoidPairs) {
      const [a, b] = pair.pair;
      if (onDuty.has(a) && onDuty.has(b)) {
        score -= 1;
        violations.push({ ruleId: 'S2', message: `第${d}天 ${a} 與 ${b} 同班（${pair.reason}）`, day: d, staff: [a, b] });
      }
    }

    // [S6] 雅卉偏好 catClinic
    if (onDuty.has('雅卉') && onDuty.get('雅卉') !== 'catClinic') {
      const liTingPos = onDuty.get('莉婷');
      const leleAt = onDuty.get('樂樂');
      const exceptionA = liTingPos === 'pharmacy' && leleAt !== 'pharmacy';
      const catNamesDay = posMap.get('catClinic') ?? [];
      const exceptionB = catNamesDay.includes('Erin');
      if (!exceptionA && !exceptionB) {
        score -= 2;
        violations.push({ ruleId: 'S6', message: `第${d}天雅卉排 ${onDuty.get('雅卉')} 而非 catClinic（無例外）`, day: d, staff: ['雅卉'] });
      }
    }
  }

  // [S4] 重疊超限（-10/天超出；限制停用時跳過）
  const oc = monthlyConstraints.xiaojiaXiaoyouOverlap;
  if (oc) {
    const overlapExcess = Math.max(0, xiaojiaXiaoyouOverlap - oc.maxDays);
    if (overlapExcess > 0) {
      score -= overlapExcess * 10;
      violations.push({ ruleId: 'S4', message: `${oc.staff[0]}與${oc.staff[1]}同日上班 ${xiaojiaXiaoyouOverlap} 天，超出上限 ${oc.maxDays} 天`, staff: [...oc.staff] });
    }
  }

  // [S5] 仕賢&彤彤 catClinic 天數下限（-3/天差距）
  for (const name of monthlyConstraints.catClinicManagement.staff) {
    const days = posDays.get(name)?.catClinic ?? 0;
    const min = monthlyConstraints.catClinicManagement.minDaysEach;
    if (days < min) {
      score -= (min - days) * 3;
      violations.push({ ruleId: 'S5', message: `${name} catClinic 僅 ${days} 天，未達下限 ${min} 天`, staff: [name] });
    }
  }

  // [S3] preferredExtraDays 達成（+2）
  for (const p of staff) {
    if (!p.preferredExtraDays) continue;
    const rec = posDays.get(p.name);
    const prefDays = rec?.[p.preferredExtraDays.position] ?? 0;
    const totalWork = Object.values(rec ?? {}).reduce((a, b) => a + b, 0);
    const avg = p.positions.length > 0 ? totalWork / p.positions.length : 0;
    if (prefDays >= avg + p.preferredExtraDays.extraDays[0]) score += 2;
  }

  // [S1] 位置分配偏離（-0.5/天偏離；權重低於 S2/S5/S6，避免互相打架）
  for (const p of staff) {
    if (p.positions.length < 2) continue;
    const rec = posDays.get(p.name);
    const counts = p.positions.map(pos => rec?.[pos] ?? 0);
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    score -= counts.reduce((sum, c) => sum + Math.abs(c - avg), 0) * 0.5;
  }

  return { score, violations };
}

// ─── 階段 1：逐日貪婪分配 ────────────────────────────────────────────────────

/**
 * 檢查候選人加入某位置是否觸發 avoidWith 迴避 [S2]
 */
function avoidConflict(p, position, onDuty) {
  for (const entry of p.avoidWith) {
    if (typeof entry === 'string') {
      if (onDuty.has(entry)) return true;
    } else if (entry.position === position && onDuty.get(entry.person) === position) {
      return true;
    }
  }
  return false;
}

/**
 * 檢查候選人是否觸發 softAvoidPairs（怡庭&燕姐儘量錯開）[S2]
 */
function softAvoidHit(p, onDuty) {
  for (const pair of monthlyConstraints.softAvoidPairs) {
    const [a, b] = pair.pair;
    if (p.name === a && onDuty.has(b)) return true;
    if (p.name === b && onDuty.has(a)) return true;
  }
  return false;
}

/**
 * 檢查候選人是否使小加&小柚重疊超過上限 [S4]
 */
function s4Blocked(p, onDuty, ctx) {
  const oc = monthlyConstraints.xiaojiaXiaoyouOverlap;
  if (!oc) return false; // 重疊限制已停用
  const [a, b] = oc.staff;
  const other = p.name === a ? b : p.name === b ? a : null;
  if (!other) return false;
  if (!onDuty.has(other)) return false;
  return ctx.overlapUsed >= monthlyConstraints.xiaojiaXiaoyouOverlap.maxDays;
}

/**
 * 候選人排序 key（越小越優先）
 */
function candKey(c, position, posArr, ctx, counterLeft = Infinity) {
  const p = c.p;
  const target = Math.max(1, ctx.targets.get(p.name) ?? 17);
  let key = (ctx.workCount.get(p.name) ?? 0) / target; // 配速：落後者優先

  // counter 稀缺度保護：counter 只能由 13 人擔任且填位順序最後，
  // 當天 counter 可用人選所剩無幾時，catClinic/pharmacy 不應搶走他們
  if (position !== 'counter' && p.positions.includes('counter')) {
    const need = positionRequirements.counter.dailyStaff; // 3
    if (counterLeft <= need) key += 2.5;
    else if (counterLeft === need + 1) key += 0.8;
    else if (counterLeft === need + 2) key += 0.25;
  }

  // 連班段建構：延續中的段優先完成（2-3 天一段，避免 1 天孤段與鋸齒）
  if (c.elig.continuing) key -= c.elig.streak === 1 ? 0.55 : 0.3;

  // 機動：人力 ×2，週末優先用好用滿。
  // 優先填 pharmacy（一人吃滿 2 人力），把 catClinic 的 4 個位置
  // 留給小加/小柚與其訓練者，避免週末學員被擠出
  if (p.role === 'flex') key -= position === 'pharmacy' ? 3.5 : 0.5;

  // [H2] catClinic 尚無有照者 → 有照者大幅優先
  if (position === 'catClinic' && p.hasLicense &&
      !posArr.some(n => staffByName.get(n)?.hasLicense)) {
    key -= 1.5;
  }

  // [S5] 仕賢/彤彤 catClinic 未達 10 天 → 優先
  if (position === 'catClinic' &&
      monthlyConstraints.catClinicManagement.staff.includes(p.name) &&
      (ctx.catDays.get(p.name) ?? 0) < monthlyConstraints.catClinicManagement.minDaysEach) {
    key -= 0.5;
  }

  // [S3] 管理職偏好位置
  if (p.preferredExtraDays?.position === position) key -= 0.15;

  // [S6] 雅卉偏好 catClinic
  if (p.name === '雅卉') key += position === 'catClinic' ? -0.2 : 0.45;

  // MRV：可排位置少者優先（怡庭/燕姐/小加/小柚/莉婷/俊傑）
  key -= (3 - p.positions.length) * 0.3;

  // 需訓練者略後（等訓練者先就位，可省一次強制安插）
  if (p.needsTraining?.some(r => r.position === position)) key += 0.1;

  // 多重啟隨機擾動（第 2 次以後的重啟）
  if (ctx.jitter) key += (Math.random() - 0.5) * ctx.jitter;

  return key;
}

/**
 * 嘗試填入指定位置至所需人力數（分層放寬 + 訓練配對 + 迴避配對）
 *
 * pass 1：ELIG_STRICT，尊重 avoidWith / softAvoidPairs / S4，
 *         被訓練者僅在訓練者已就位時進場
 * pass 2：ELIG_STRICT，放棄軟性迴避，可主動安插訓練者（訓練者亦須合格）
 * pass 3：加入 ELIG_RELAXED（前段 1 天班休 1 天，validator 合法）
 * pass 4：加入 ELIG_EXCEPTION（連 4 例外，每月一次 → 即 [H5] 人力不足例外）
 */
function fillPosition(position, need, cands, assigned, usedNames, ctx) {
  const posArr = assigned.get(position);
  let remaining = need - posArr.reduce((s, n) => s + (staffByName.get(n)?.countsAs ?? 1), 0);
  if (remaining <= 0) return;

  const buildOnDuty = () => {
    const onDuty = new Map();
    for (const [pos, names] of assigned) {
      for (const n of names) onDuty.set(n, pos);
    }
    return onDuty;
  };

  for (let pass = 1; pass <= 4 && remaining > 0; pass++) {
    // 有人加入後重新掃描整個候選池：
    // 被訓練者（小加/小柚/莉婷）在訓練者就位前會被跳過，
    // 訓練者加入後必須回頭再給他們機會，否則會被永久擠出當日班表。
    let progressed = true;
    while (progressed && remaining > 0) {
      progressed = false;

      // counter 稀缺度：當天尚未用掉、可排 counter 的候選人數
      const counterLeft = cands.filter(c =>
        !usedNames.has(c.p.name) && c.p.positions.includes('counter')
      ).length;

      const pool = cands
        .filter(c => {
          if (usedNames.has(c.p.name)) return false;
          if (!c.p.positions.includes(position)) return false;
          const t = c.elig.tier;
          if (pass <= 2) return t === ELIG_STRICT;
          if (pass === 3) return t === ELIG_STRICT || t === ELIG_RELAXED;
          return t !== ELIG_NONE;
        })
        .sort((a, b) =>
          candKey(a, position, posArr, ctx, counterLeft) -
          candKey(b, position, posArr, ctx, counterLeft));

      for (const c of pool) {
        if (remaining <= 0) break;
        const p = c.p;
        if (usedNames.has(p.name)) continue;

        // 避免超編：countsAs 2 塞進剩 1 人力的缺口（有其他人選時先跳過）
        if (p.countsAs > remaining &&
            pool.some(o => o !== c && !usedNames.has(o.p.name) && o.p.countsAs <= remaining)) {
          continue;
        }

        const onDuty = buildOnDuty();

        // [S4] 小加&小柚重疊上限：pass 1-3 都擋，只有 pass 4 放行
        if (pass <= 3 && s4Blocked(p, onDuty, ctx)) continue;

        if (pass === 1) {
          // [S2] 迴避配對與軟性錯開：第一輪完全尊重
          if (avoidConflict(p, position, onDuty)) continue;
          if (softAvoidHit(p, onDuty)) continue;
        }

        // [H3] 訓練配對：訓練者不在位時，嘗試主動帶訓練者一起進場
        // （訓練者本身也必須通過相同資格檢查，修正爆班 bug）
        if (p.needsTraining) {
          const req = p.needsTraining.find(r => r.position === position);
          if (req) {
            const trainerPresent = req.trainers.some(t => posArr.includes(t));
            if (!trainerPresent) {
              const tCand = pool.find(c2 =>
                c2 !== c &&
                req.trainers.includes(c2.p.name) &&
                !usedNames.has(c2.p.name) &&
                c2.p.positions.includes(position) &&
                c2.elig.tier === ELIG_STRICT &&
                (pass > 1 || (!avoidConflict(c2.p, position, onDuty) && !softAvoidHit(c2.p, onDuty)))
              );
              if (!tCand) continue;
              if (remaining < p.countsAs + tCand.p.countsAs) continue;
              posArr.push(tCand.p.name);
              usedNames.add(tCand.p.name);
              remaining -= tCand.p.countsAs;
            }
          }
        }

        posArr.push(p.name);
        usedNames.add(p.name);
        remaining -= p.countsAs;
        progressed = true;

        if (c.elig.tier === ELIG_EXCEPTION) ctx.consec.usedException = true;

        // 每次成功加入後跳出重掃：讓「因缺訓練者被跳過」的高優先候選
        // 在訓練者就位後能立刻被重新考慮，並依最新狀態重新排序
        break;
      }
    }
  }
}

/**
 * 為單日產生排班方案
 * @returns {Map<string, string[]>}
 */
function assignDay(d, availMap, dayMap, maxWorkdays, ctx, y, m, lockedSet = null) {
  // 建立當日候選（含 H5 資格分層）
  const cands = [];
  for (const p of staff) {
    if (lockedSet?.has(`${p.name}|${d}`)) continue;
    if (!availMap.get(p.name)?.has(d)) continue;
    if (p.role === 'regular' &&
        (ctx.workCount.get(p.name) ?? 0) >= (maxWorkdays.get(p.name) ?? 17)) continue;
    const elig = h5Eligibility(p, d, dayMap, y, m, ctx.consec);
    if (elig.tier === ELIG_NONE) continue;
    cands.push({ p, elig });
  }

  // 初始化：保留預填人員
  const existingPosMap = dayMap.get(d);
  const assigned = new Map([
    ['counter',   [...(existingPosMap?.get('counter')   ?? [])]],
    ['pharmacy',  [...(existingPosMap?.get('pharmacy')  ?? [])]],
    ['catClinic', [...(existingPosMap?.get('catClinic') ?? [])]],
  ]);
  const usedNames = new Set();
  for (const names of assigned.values()) {
    for (const n of names) usedNames.add(n);
  }

  // 填入順序：catClinic（最受限）→ pharmacy → counter
  for (const pos of FILL_ORDER) {
    fillPosition(pos, positionRequirements[pos].dailyStaff, cands, assigned, usedNames, ctx);
  }

  // 即使人力不足也回傳部分解（unfilled 由後續 computeUnfilled 記錄）
  return assigned;
}

// ─── 階段 2：Hill Climbing ────────────────────────────────────────────────────

/**
 * 綜合評分 = 軟規則分數 − 硬規則懲罰（-300/條）− 人力缺口懲罰（-40/人力）
 * 硬規則納入評分後，hill climbing 不會為了軟規則破壞硬規則，
 * 且可主動修復殘餘硬違反。
 */
function computeScore(dayMap, y, m, maxWorkdays) {
  const { score } = scoreSoftRules(dayMap, y, m);
  const unfilled = computeUnfilled(dayMap, y, m);
  const hard = validateHardRules(dayMap, y, m, maxWorkdays);
  // 缺口懲罰以「天」為單位採超線性（40·s + 35·s²，s = 當天總缺額）：
  // 總缺額相同時，集中在少數天（如月底連缺 3 人或同日兩位置各缺 1）
  // 的罰分遠高於平均分散，讓 hill climbing 主動把大缺攤平成偶發缺 1
  const dayShort = new Map();
  for (const u of unfilled) dayShort.set(u.day, (dayShort.get(u.day) ?? 0) + u.shortBy);
  let gapPenalty = 0;
  for (const sTot of dayShort.values()) gapPenalty += sTot * 40 + sTot * sTot * 35;
  return score - hard.length * 300 - gapPenalty;
}

/**
 * 執行一輪 hill climbing：100 次嘗試，含三種移動：
 *   shift   — 把某日某位置的人移至缺口日同位置（填缺口）
 *   swap    — 兩日同位置一人對換（調整工作日分布）
 *   dayswap — 同日跨位置對換（不動任何人的工作日，零 H5 風險，專攻軟規則）
 * @returns {boolean} 是否有改善
 */
function hillClimbStep(dayMap, total, y, m, availMap, maxWorkdays, lockedSet = null) {
  const baseScore = computeScore(dayMap, y, m, maxWorkdays);
  let bestScore = baseScore;
  let bestOp = null;

  // 找出所有人力缺口位置（供 shift 移動優先使用）
  const unfilledSlots = [];
  for (let d = 1; d <= total; d++) {
    for (const pos of POSITIONS) {
      const req = positionRequirements[pos].dailyStaff;
      const names = dayMap.get(d)?.get(pos) ?? [];
      const power = names.reduce((s, n) => s + (staffByName.get(n)?.countsAs ?? 1), 0);
      if (power < req) unfilledSlots.push({ d, pos });
    }
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    const r = Math.random();
    const useInsert  = unfilledSlots.length > 0 && r < 0.35;
    const useShift   = !useInsert && unfilledSlots.length > 0 && r < 0.55;
    const useDaySwap = !useInsert && !useShift && r < 0.75;

    if (useInsert) {
      // ── Insert：把「當天沒上班、還有配額」的人直接插入缺口 ──
      // H5/H8 由 computeScore 的硬規則懲罰把關（變差的插入不會被採納）
      const slot = unfilledSlots[Math.floor(Math.random() * unfilledSlots.length)];
      const { d: d1, pos } = slot;

      const cand = staff[Math.floor(Math.random() * staff.length)];
      if (!cand.positions.includes(pos)) continue;
      if (lockedSet?.has(`${cand.name}|${d1}`)) continue;
      if (!availMap.get(cand.name)?.has(d1)) continue;
      if (isWorking(cand.name, d1, dayMap)) continue;

      const arr1 = dayMap.get(d1).get(pos);
      const prePow1 = {};
      for (const p of POSITIONS) {
        prePow1[p] = (dayMap.get(d1)?.get(p) ?? []).reduce((s, n) => s + (staffByName.get(n)?.countsAs ?? 1), 0);
      }

      arr1.push(cand.name);

      if (isDayValid(d1, dayMap, y, m, prePow1)) {
        const newScore = computeScore(dayMap, y, m, maxWorkdays);
        if (newScore > bestScore) {
          bestScore = newScore;
          bestOp = { type: 'insert', d1, pos, name: cand.name };
        }
      }

      arr1.pop();

    } else if (useShift) {
      // ── Shift：把某日/某位置的人移至缺口日的同位置 ──
      const slot = unfilledSlots[Math.floor(Math.random() * unfilledSlots.length)];
      const { d: d1, pos } = slot;

      let d2 = 1 + Math.floor(Math.random() * total);
      let tries = 0;
      while ((d2 === d1 || (dayMap.get(d2)?.get(pos)?.length ?? 0) === 0) && tries++ < 15) {
        d2 = 1 + Math.floor(Math.random() * total);
      }
      if (d2 === d1 || (dayMap.get(d2)?.get(pos)?.length ?? 0) === 0) continue;

      const names2 = dayMap.get(d2).get(pos);
      const n2 = names2[Math.floor(Math.random() * names2.length)];

      if (lockedSet?.has(`${n2}|${d2}`)) continue;
      if (!availMap.get(n2)?.has(d1)) continue;
      if (isWorking(n2, d1, dayMap)) continue;

      const prePow1 = {}, prePow2 = {};
      for (const p of POSITIONS) {
        prePow1[p] = (dayMap.get(d1)?.get(p) ?? []).reduce((s, n) => s + (staffByName.get(n)?.countsAs ?? 1), 0);
        prePow2[p] = (dayMap.get(d2)?.get(p) ?? []).reduce((s, n) => s + (staffByName.get(n)?.countsAs ?? 1), 0);
      }

      // 執行 shift：n2 從 d2/pos 移至 d1/pos
      const arr1 = dayMap.get(d1).get(pos);
      const idx2 = names2.indexOf(n2);
      arr1.push(n2);
      names2.splice(idx2, 1);

      // d2 允許該位置人力減少（從滿編日調人攤平缺口），
      // 淨效益由 computeScore 的超線性缺口懲罰把關
      const relaxed2 = { ...prePow2 };
      relaxed2[pos] = Math.max(0, (relaxed2[pos] ?? 0) - (staffByName.get(n2)?.countsAs ?? 1));

      if (isDayValid(d1, dayMap, y, m, prePow1) && isDayValid(d2, dayMap, y, m, relaxed2)) {
        const newScore = computeScore(dayMap, y, m, maxWorkdays);
        if (newScore > bestScore) {
          bestScore = newScore;
          bestOp = { type: 'shift', d1, d2, pos, n2, idx2 };
        }
      }

      // 還原
      arr1.splice(arr1.lastIndexOf(n2), 1);
      names2.splice(idx2, 0, n2);

    } else if (useDaySwap) {
      // ── 同日跨位置對換：不改變任何人的工作日，零 H5 風險 ──
      const d1 = 1 + Math.floor(Math.random() * total);
      const posMap = dayMap.get(d1);
      if (!posMap) continue;
      const posA = POSITIONS[Math.floor(Math.random() * POSITIONS.length)];
      const posB = POSITIONS[Math.floor(Math.random() * POSITIONS.length)];
      if (posA === posB) continue;
      const namesA = posMap.get(posA) ?? [];
      const namesB = posMap.get(posB) ?? [];
      if (namesA.length === 0 || namesB.length === 0) continue;

      const n1 = namesA[Math.floor(Math.random() * namesA.length)];
      const n2 = namesB[Math.floor(Math.random() * namesB.length)];
      if (lockedSet?.has(`${n1}|${d1}`) || lockedSet?.has(`${n2}|${d1}`)) continue;

      const p1 = staffByName.get(n1);
      const p2 = staffByName.get(n2);
      if (!p1?.positions.includes(posB) || !p2?.positions.includes(posA)) continue;
      // countsAs 不同者不可跨位置換（機動 ×2 會造成人力不平衡）
      if ((p1.countsAs ?? 1) !== (p2.countsAs ?? 1)) continue;

      const i1 = namesA.indexOf(n1);
      const i2 = namesB.indexOf(n2);
      namesA[i1] = n2;
      namesB[i2] = n1;

      if (isDayValid(d1, dayMap, y, m)) {
        const newScore = computeScore(dayMap, y, m, maxWorkdays);
        if (newScore > bestScore) {
          bestScore = newScore;
          bestOp = { type: 'dayswap', d1, posA, posB, n1, n2 };
        }
      }

      namesA[i1] = n1;
      namesB[i2] = n2;

    } else {
      // ── 兩日同位置一人對換 ──
      const d1 = 1 + Math.floor(Math.random() * total);
      const d2 = 1 + Math.floor(Math.random() * total);
      if (d1 === d2) continue;

      const pos = POSITIONS[Math.floor(Math.random() * POSITIONS.length)];
      const names1 = dayMap.get(d1)?.get(pos) ?? [];
      const names2 = dayMap.get(d2)?.get(pos) ?? [];
      if (names1.length === 0 || names2.length === 0) continue;

      const n1 = names1[Math.floor(Math.random() * names1.length)];
      const n2 = names2[Math.floor(Math.random() * names2.length)];
      if (n1 === n2) continue;
      if (lockedSet?.has(`${n1}|${d1}`) || lockedSet?.has(`${n2}|${d2}`)) continue;
      if (isWorking(n2, d1, dayMap) || isWorking(n1, d2, dayMap)) continue;

      const p1 = staffByName.get(n1);
      const p2 = staffByName.get(n2);
      if (!p1 || !p2) continue;

      if (!p1.positions.includes(pos) || !p2.positions.includes(pos)) continue;
      if (!availMap.get(n2)?.has(d1) || !availMap.get(n1)?.has(d2)) continue;

      const prePow1 = {}, prePow2 = {};
      for (const p of POSITIONS) {
        prePow1[p] = (dayMap.get(d1)?.get(p) ?? []).reduce((s, n) => s + (staffByName.get(n)?.countsAs ?? 1), 0);
        prePow2[p] = (dayMap.get(d2)?.get(p) ?? []).reduce((s, n) => s + (staffByName.get(n)?.countsAs ?? 1), 0);
      }

      swapPersons(dayMap, d1, d2, pos, n1, n2);

      if (isDayValid(d1, dayMap, y, m, prePow1) && isDayValid(d2, dayMap, y, m, prePow2)) {
        const newScore = computeScore(dayMap, y, m, maxWorkdays);
        if (newScore > bestScore) {
          bestScore = newScore;
          bestOp = { type: 'swap', d1, d2, pos, n1, n2 };
        }
      }

      swapPersons(dayMap, d1, d2, pos, n2, n1);
    }
  }

  if (bestOp) {
    if (bestOp.type === 'swap') {
      const { d1, d2, pos, n1, n2 } = bestOp;
      swapPersons(dayMap, d1, d2, pos, n1, n2);
    } else if (bestOp.type === 'insert') {
      dayMap.get(bestOp.d1).get(bestOp.pos).push(bestOp.name);
    } else if (bestOp.type === 'dayswap') {
      const { d1, posA, posB, n1, n2 } = bestOp;
      const namesA = dayMap.get(d1).get(posA);
      const namesB = dayMap.get(d1).get(posB);
      namesA[namesA.indexOf(n1)] = n2;
      namesB[namesB.indexOf(n2)] = n1;
    } else {
      const { d1, d2, pos, n2, idx2 } = bestOp;
      dayMap.get(d1).get(pos).push(n2);
      dayMap.get(d2).get(pos).splice(idx2, 1);
    }
    return true;
  }
  return false;
}

/**
 * 在 dayMap 中將 d1/pos 的 n1 與 d2/pos 的 n2 互換
 */
function swapPersons(dayMap, d1, d2, pos, n1, n2) {
  const arr1 = dayMap.get(d1)?.get(pos);
  const arr2 = dayMap.get(d2)?.get(pos);
  if (!arr1 || !arr2) return;
  const i1 = arr1.indexOf(n1);
  const i2 = arr2.indexOf(n2);
  if (i1 === -1 || i2 === -1) return;
  arr1[i1] = n2;
  arr2[i2] = n1;
}

// ─── 輸出格式轉換 ─────────────────────────────────────────────────────────────

/**
 * 將 dayMap 轉為 ScheduleResult.schedule 格式
 */
function dayMapToSchedule(dayMap) {
  const result = Object.fromEntries(staff.map(p => [p.name, []]));
  for (const [day, posMap] of dayMap) {
    for (const [position, names] of posMap) {
      for (const name of names) {
        result[name]?.push({ day, position });
      }
    }
  }
  for (const arr of Object.values(result)) arr.sort((a, b) => a.day - b.day);
  return result;
}

/**
 * 計算每日人力缺口
 */
function computeUnfilled(dayMap, y, m) {
  const total = daysInMonth(y, m);
  const unfilled = [];
  for (let d = 1; d <= total; d++) {
    const posMap = dayMap.get(d) ?? new Map();
    for (const pos of POSITIONS) {
      const req = positionRequirements[pos].dailyStaff;
      const names = posMap.get(pos) ?? [];
      const power = names.reduce((s, n) => s + (staffByName.get(n)?.countsAs ?? 1), 0);
      if (power < req) unfilled.push({ day: d, position: pos, shortBy: req - power });
    }
  }
  return unfilled;
}

// ─── 主函數 ───────────────────────────────────────────────────────────────────

/**
 * 產生排班結果（純函數）
 *
 * @param {number} year
 * @param {number} month
 * @param {Object<string, number[]>} vacations   {人名: [休假日期]}
 * @param {Object}   [options]
 * @param {number}   [options.timeLimitMs=120000]
 * @param {(p: ProgressInfo) => void} [options.onProgress]
 * @param {Object<string, Object<string, string>>} [prefilled]  {人名: {日期: position|'vacation'}}
 * @returns {ScheduleResult}
 */
export function generateSchedule(year, month, vacations = {}, options = {}, prefilled = {}) {
  const { timeLimitMs = 120000, onProgress } = options;
  const startTime = Date.now();

  const total       = daysInMonth(year, month);
  const maxWorkdays = computeMaxWorkdays(year, month);

  // 將 prefilled 中的 vacation 項目合入 vacations，讓 computeAvailableDays 正確排除
  const vacationsExt = { ...vacations };
  for (const [name, dayValues] of Object.entries(prefilled)) {
    for (const [dayStr, value] of Object.entries(dayValues)) {
      if (value === 'vacation') {
        const day = Number(dayStr);
        if (!vacationsExt[name]) vacationsExt[name] = [];
        if (!vacationsExt[name].includes(day)) vacationsExt[name].push(day);
      }
    }
  }

  const availMap = computeAvailableDays(year, month, vacationsExt);
  const targets  = computeTargets(year, month, availMap, maxWorkdays);

  // ── 預填處理：建立 lockedSet（dayMap 寫入由 buildInitial 處理）──────
  const lockedSet = new Set(); // Set<"name|day">
  for (const [name, dayValues] of Object.entries(prefilled)) {
    for (const dayStr of Object.keys(dayValues)) {
      lockedSet.add(`${name}|${Number(dayStr)}`);
    }
  }

  // ── 階段 1：多次隨機重啟，取綜合評分最佳的初始解 ─────────
  onProgress?.({ stage: 'phase1', message: '階段 1：建構初始可行解…', percent: 0 });
  let lastProgressMs = Date.now();

  const s4pair = monthlyConstraints.xiaojiaXiaoyouOverlap?.staff ?? null;

  const buildInitial = (jitter) => {
    // 全新 dayMap（含預填）
    const dm = new Map();
    for (let d = 1; d <= total; d++) {
      dm.set(d, new Map([['counter', []], ['pharmacy', []], ['catClinic', []]]));
    }
    for (const [name, dayValues] of Object.entries(prefilled)) {
      for (const [dayStr, value] of Object.entries(dayValues)) {
        if (value !== 'vacation' && POSITIONS.includes(value)) {
          const posArr = dm.get(Number(dayStr))?.get(value);
          if (posArr && !posArr.includes(name)) posArr.push(name);
        }
      }
    }

    const c = {
      workCount:   new Map(staff.map(p => [p.name, 0])),
      targets,
      catDays:     new Map(),
      overlapUsed: 0,
      consec:      { usedException: false },
      jitter,
    };
    for (const [name, dayValues] of Object.entries(prefilled)) {
      for (const value of Object.values(dayValues)) {
        if (value !== 'vacation' && POSITIONS.includes(value)) {
          c.workCount.set(name, (c.workCount.get(name) ?? 0) + 1);
        }
      }
    }

    // 逐日貪婪
    for (let d = 1; d <= total; d++) {
      const result = assignDay(d, availMap, dm, maxWorkdays, c, year, month, lockedSet);
      for (const [pos, names] of result) {
        dm.get(d).set(pos, names);
        for (const name of names) {
          if (!lockedSet.has(`${name}|${d}`)) {
            c.workCount.set(name, (c.workCount.get(name) ?? 0) + 1);
          }
        }
      }
      const posMap = dm.get(d);
      const dayNames = new Set();
      for (const names of posMap.values()) for (const n of names) dayNames.add(n);
      if (s4pair && dayNames.has(s4pair[0]) && dayNames.has(s4pair[1])) c.overlapUsed++;
      for (const n of posMap.get('catClinic') ?? []) {
        if (monthlyConstraints.catClinicManagement.staff.includes(n)) {
          c.catDays.set(n, (c.catDays.get(n) ?? 0) + 1);
        }
      }
    }

    // 階段 1.5：補位掃描（canInsertDay 雙向檢查，不破壞 H5）
    for (let d = 1; d <= total; d++) {
      const posMap = dm.get(d);

      for (const pos of POSITIONS) {
        const req = positionRequirements[pos].dailyStaff;
        const names = posMap.get(pos);
        let power = names.reduce((sum, n) => sum + (staffByName.get(n)?.countsAs ?? 1), 0);
        if (power >= req) continue;

        const alreadyOnDay = new Set();
        for (const ns of posMap.values()) for (const n of ns) alreadyOnDay.add(n);

        const fillers = staff
          .filter(p => {
            if (alreadyOnDay.has(p.name)) return false;
            if (lockedSet.has(`${p.name}|${d}`)) return false;
            if (!availMap.get(p.name)?.has(d)) return false;
            if (p.role === 'regular' &&
                (c.workCount.get(p.name) ?? 0) >= (maxWorkdays.get(p.name) ?? 17)) return false;
            if (!p.positions.includes(pos)) return false;
            return canInsertDay(p, d, dm, year, month, c.consec).ok;
          })
          .sort((a, b) => {
            if (pos === 'catClinic' && !names.some(n => staffByName.get(n)?.hasLicense)) {
              const aLic = a.hasLicense ? 0 : 1;
              const bLic = b.hasLicense ? 0 : 1;
              if (aLic !== bLic) return aLic - bLic;
            }
            return (c.workCount.get(a.name) ?? 0) - (c.workCount.get(b.name) ?? 0);
          });

        for (const p of fillers) {
          if (power >= req) break;

          if (p.needsTraining) {
            const reqT = p.needsTraining.find(r => r.position === pos);
            if (reqT && !reqT.trainers.some(t => names.includes(t))) continue;
          }

          if (pos === 'catClinic' && names.length > 0 &&
              !names.some(n => staffByName.get(n)?.hasLicense) && !p.hasLicense) {
            continue;
          }

          const ins = canInsertDay(p, d, dm, year, month, c.consec);
          if (!ins.ok) continue;
          if (ins.exception) c.consec.usedException = true;

          names.push(p.name);
          c.workCount.set(p.name, (c.workCount.get(p.name) ?? 0) + 1);
          power += p.countsAs ?? 1;
        }
      }
    }

    return dm;
  };

  // 多次重啟：第 1 次無擾動（確定性），之後加隨機擾動，取最佳
  let dayMap = null;
  let bestInitScore = -Infinity;
  const MAX_RESTARTS = 6;
  for (let rIdx = 0; rIdx < MAX_RESTARTS; rIdx++) {
    if (dayMap && Date.now() - startTime > timeLimitMs * 0.35) break;
    const dm = buildInitial(rIdx === 0 ? 0 : 0.3);
    const sc = computeScore(dm, year, month, maxWorkdays);
    if (sc > bestInitScore) { bestInitScore = sc; dayMap = dm; }
    onProgress?.({ stage: 'phase1', message: `階段 1：初始解 ${rIdx + 1}/${MAX_RESTARTS}`, percent: Math.round((rIdx + 1) / MAX_RESTARTS * 50) });
  }

  const phase1Overtime = Date.now() - startTime > timeLimitMs * 0.6;

  if (phase1Overtime) {
    onProgress?.({ stage: 'phase1', message: '階段 1 超時，跳過優化階段', percent: 90 });
  } else {
    onProgress?.({ stage: 'phase1', message: '階段 1.5 完成，進入軟規則優化…', percent: 55 });
  }

  // ── 階段 2（若階段 1 超時則略過）────────────────────────
  let iter = 0;
  if (!phase1Overtime) {
    onProgress?.({ stage: 'phase2', message: '階段 2：Hill Climbing 優化中…', percent: 55 });

    const phase2End = startTime + timeLimitMs * 0.9;
    let noImprove = 0;

    while (Date.now() < phase2End && noImprove < 200) {
      const improved = hillClimbStep(dayMap, total, year, month, availMap, maxWorkdays, lockedSet);
      noImprove = improved ? 0 : noImprove + 1;
      iter++;

      const now = Date.now();
      if (now - lastProgressMs >= 200) {
        const pct = 50 + Math.min(Math.round((now - startTime) / timeLimitMs * 45), 45);
        onProgress?.({ stage: 'phase2', message: `階段 2：迭代 ${iter} 次，連續無改善 ${noImprove} 輪`, percent: pct });
        lastProgressMs = now;
      }
    }
  }

  // ── 產出 ────────────────────────────────────────────────
  const finalWorkCount  = new Map();
  for (const [day, posMap] of dayMap) {
    for (const names of posMap.values()) {
      for (const name of names) finalWorkCount.set(name, (finalWorkCount.get(name) ?? 0) + 1);
    }
  }

  const hardViolations = validateHardRules(dayMap, year, month, maxWorkdays);
  const { violations: softViolations } = scoreSoftRules(dayMap, year, month);
  const unfilled   = computeUnfilled(dayMap, year, month);
  const schedule   = dayMapToSchedule(dayMap);
  const workdayCount = Object.fromEntries(staff.map(p => [p.name, finalWorkCount.get(p.name) ?? 0]));

  const hLen = hardViolations.length;
  const sLen = softViolations.length;
  const uLen = unfilled.length;
  const summary = hLen === 0 && uLen === 0
    ? `排班完成，${sLen} 條軟規則提醒`
    : `排班完成，${hLen} 條硬規則違反、${sLen} 條軟規則提醒、${uLen} 個人力缺口`;

  console.log(`[scheduler] ${summary}（耗時 ${Date.now() - startTime} ms，迭代 ${iter} 次）`);
  onProgress?.({ stage: 'done', message: summary, percent: 100 });

  return { schedule, hardViolations, softViolations, unfilled, workdayCount, summary };
}

export { validateHardRules };
