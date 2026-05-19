/**
 * @file scheduler.js — 獸醫院排班演算法
 * Phase 3a：純函數演算法，不含 UI 操作、不存 localStorage
 *
 * 兩階段策略：
 *   階段 1 — 逐日貪婪建構（catClinic→pharmacy→counter，MRV 優先）
 *   階段 2 — Hill Climbing 軟規則優化（隨機對換 + 得分比較）
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

// ─── 連班工具 ─────────────────────────────────────────────────────────────────

/**
 * 計算某人截至 day（含）的當前連班長度
 * @param {string} name
 * @param {number} day
 * @param {Map<number, Map<string, string[]>>} dayMap
 * @returns {number}
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
 * - weekendOnly 人員的非週末日
 * - forbiddenWeekdays 命中的日期（含外單位日，如俊傑週二、週五）
 * @param {import('./data.js').StaffMember} person
 * @param {number} weekday  0=Sun … 6=Sat
 * @returns {boolean}
 */
function isUnavailable(person, weekday) {
  if (person.workableDays === 'weekendOnly' && weekday !== 0 && weekday !== 6) return true;
  if (person.forbiddenWeekdays.includes(weekday)) return true;
  return false;
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

    // 找出所有連班段（isUnavailable 日視為分段點，但不計為真休息）
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
      // 段間若全為禁排日（trueRest=0），不計違反：禁排日本身構成自然隔離
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

    // 「上一休一」鋸齒模式偵測：跳過 isUnavailable 日，
    // 只在「真可排日」序列中偵測工作/休息交替達 5 次以上
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

    // [S4] 小加小柚同日
    if (onDuty.has('小加') && onDuty.has('小柚')) xiaojiaXiaoyouOverlap++;

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
      const exceptionB = catNamesDay.includes('小加') || catNamesDay.includes('Erin');
      if (!exceptionA && !exceptionB) {
        score -= 2;
        violations.push({ ruleId: 'S6', message: `第${d}天雅卉排 ${onDuty.get('雅卉')} 而非 catClinic（無例外）`, day: d, staff: ['雅卉'] });
      }
    }
  }

  // [S4] 重疊超限（-10/天超出）
  const overlapExcess = Math.max(0, xiaojiaXiaoyouOverlap - monthlyConstraints.xiaojiaXiaoyouOverlap.maxDays);
  if (overlapExcess > 0) {
    score -= overlapExcess * 10;
    violations.push({ ruleId: 'S4', message: `小加與小柚同日上班 ${xiaojiaXiaoyouOverlap} 天，超出上限 ${monthlyConstraints.xiaojiaXiaoyouOverlap.maxDays} 天`, staff: ['小加', '小柚'] });
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

  // [S1] 位置分配偏離（-1/天偏離）
  for (const p of staff) {
    if (p.positions.length < 2) continue;
    const rec = posDays.get(p.name);
    const counts = p.positions.map(pos => rec?.[pos] ?? 0);
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    score -= counts.reduce((sum, c) => sum + Math.abs(c - avg), 0);
  }

  return { score, violations };
}

// ─── 階段 1：逐日貪婪分配 ────────────────────────────────────────────────────

/**
 * 嘗試填入指定位置至所需人力數（含訓練者優先安插邏輯）
 * @param {string} position
 * @param {number} need        所需人力（機動 countsAs:2 折算）
 * @param {import('./data.js').StaffMember[]} candidates
 * @param {Map<string, string[]>} assigned   當天各位置已排人員
 * @param {Set<string>} usedNames
 * @returns {boolean}          true 表示人力需求已滿足
 */
function fillPosition(position, need, candidates, assigned, usedNames, workCount, avgWorkdays) {
  const posArr = assigned.get(position) ?? [];

  // 計算剩餘所需人力
  let remaining = need;
  for (const name of posArr) {
    remaining -= staffByName.get(name)?.countsAs ?? 1;
  }
  if (remaining <= 0) return true;

  // 候選人排序：
  //   1. 超過進度者後排（降格，非排除）
  //   2. 累計班數少者優先（公平分配）
  //   3. catClinic 且尚無有照者 → 有照者優先
  //   4. countsAs 大優先（機動頂兩名）
  //   5. positions 少優先（受限多，MRV）
  //   6. 需訓練者優先安插
  const sorted = [...candidates]
    .filter(p => !usedNames.has(p.name))
    .sort((a, b) => {
      const aCount = workCount?.get(a.name) ?? 0;
      const bCount = workCount?.get(b.name) ?? 0;
      const threshold = (avgWorkdays ?? 0) + 2;
      const aOver = aCount > threshold ? 1 : 0;
      const bOver = bCount > threshold ? 1 : 0;
      if (aOver !== bOver) return aOver - bOver;
      if (aCount !== bCount) return aCount - bCount;
      if (position === 'catClinic' && !posArr.some(n => staffByName.get(n)?.hasLicense)) {
        const aLic = a.hasLicense ? 0 : 1;
        const bLic = b.hasLicense ? 0 : 1;
        if (aLic !== bLic) return aLic - bLic;
      }
      if (a.countsAs !== b.countsAs) return b.countsAs - a.countsAs;
      if (a.positions.length !== b.positions.length) return a.positions.length - b.positions.length;
      const aN = (a.needsTraining?.length ?? 0) > 0 ? 1 : 0;
      const bN = (b.needsTraining?.length ?? 0) > 0 ? 1 : 0;
      return bN - aN;
    });

  for (const p of sorted) {
    if (remaining <= 0) break;
    if (usedNames.has(p.name)) continue;

    // [H3] 若此人需訓練，先安插訓練者
    if (p.needsTraining) {
      const req = p.needsTraining.find(r => r.position === position);
      if (req) {
        const currentInPos = assigned.get(position) ?? [];
        const trainerPresent = req.trainers.some(t => currentInPos.includes(t));
        if (!trainerPresent) {
          const trainer = req.trainers.find(t => {
            if (usedNames.has(t)) return false;
            return staffByName.get(t)?.positions.includes(position) ?? false;
          });
          if (!trainer) continue; // 無可用訓練者，跳過此人
          const tp = staffByName.get(trainer);
          if (tp) {
            posArr.push(trainer);
            usedNames.add(trainer);
            remaining -= tp.countsAs ?? 1;
          }
        }
      }
    }

    posArr.push(p.name);
    usedNames.add(p.name);
    remaining -= p.countsAs ?? 1;
  }

  // [H2] catClinic 需有照
  if (position === 'catClinic' && posArr.length > 0) {
    if (!posArr.some(n => staffByName.get(n)?.hasLicense)) return false;
  }

  return remaining <= 0;
}

/**
 * 為單日產生排班方案，回傳 Map<position, names[]> 或 null（無法滿足硬規則）
 * @param {number} d
 * @param {Map<string, Set<number>>} availMap
 * @param {Map<number, Map<string, string[]>>} dayMap
 * @param {Map<string, number>} workCount
 * @param {Map<string, number>} maxWorkdays
 * @param {{ usedException: boolean }} consec
 * @param {number} y
 * @param {number} m
 * @returns {Map<string, string[]> | null}
 */
function assignDay(d, availMap, dayMap, workCount, maxWorkdays, consec, y, m, lockedSet = null) {
  // 當天可用人員（未超工時上限 + 連班未超限 + 非預填鎖定）
  const canWork = staff.filter(p => {
    if (lockedSet?.has(`${p.name}|${d}`)) return false;
    if (!availMap.get(p.name)?.has(d)) return false;
    if ((workCount.get(p.name) ?? 0) >= (maxWorkdays.get(p.name) ?? 17)) return false;
    if (p.role !== 'regular') return true;
    const streak = currentStreak(p.name, d - 1, dayMap);
    const maxC = monthlyConstraints.consecutive.maxDays;
    const maxE = monthlyConstraints.consecutive.exceptionalMaxDays;
    if (streak < maxC) return true;
    if (streak < maxE && !consec.usedException) return true;
    return false;
  });

  // 分組至各位置候選
  const byPos = {
    counter:   canWork.filter(p => p.positions.includes('counter')),
    pharmacy:  canWork.filter(p => p.positions.includes('pharmacy')),
    catClinic: canWork.filter(p => p.positions.includes('catClinic')),
  };

  // 初始化時保留預填人員（已寫入 dayMap），避免 fillPosition 重複計算
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

  const total_ = daysInMonth(y, m);
  const avgWorkdays = Math.max(1, (d / total_) * 17);

  // 填入順序：catClinic（最受限）→ pharmacy → counter
  const catOk  = fillPosition('catClinic', positionRequirements.catClinic.dailyStaff, byPos.catClinic, assigned, usedNames, workCount, avgWorkdays);
  const pharOk = fillPosition('pharmacy',  positionRequirements.pharmacy.dailyStaff,  byPos.pharmacy,  assigned, usedNames, workCount, avgWorkdays);
  const cntOk  = fillPosition('counter',   positionRequirements.counter.dailyStaff,   byPos.counter,   assigned, usedNames, workCount, avgWorkdays);

  // 標記連班例外使用
  if (!consec.usedException) {
    for (const p of canWork) {
      if (p.role !== 'regular') continue;
      const streak = currentStreak(p.name, d - 1, dayMap);
      if (streak >= monthlyConstraints.consecutive.maxDays) {
        let assigned_ = false;
        for (const names of assigned.values()) { if (names.includes(p.name)) { assigned_ = true; break; } }
        if (assigned_) { consec.usedException = true; break; }
      }
    }
  }

  // 即使人力不足也回傳部分解（unfilled 由後續 computeUnfilled 記錄）
  return assigned;
}

// ─── 階段 2：Hill Climbing ────────────────────────────────────────────────────

/**
 * 綜合評分 = 軟規則分數 − 人力缺口懲罰（每缺 1 人力扣 20 分）
 * Hill Climbing 用此分數同時優化軟規則與填補人力缺口。
 * @param {Map<number, Map<string, string[]>>} dayMap
 * @param {number} y
 * @param {number} m
 * @returns {number}
 */
function computeScore(dayMap, y, m) {
  const { score } = scoreSoftRules(dayMap, y, m);
  const unfilled = computeUnfilled(dayMap, y, m);
  return score - unfilled.reduce((sum, u) => sum + u.shortBy * 20, 0);
}

/**
 * 執行一輪 hill climbing：120 次嘗試，含「針對缺口日的 shift 移動」與「隨機對換」。
 * @param {Map<number, Map<string, string[]>>} dayMap
 * @param {number} total
 * @param {number} y
 * @param {number} m
 * @param {Map<string, Set<number>>} availMap
 * @param {Map<string, number>} maxWorkdays
 * @returns {boolean} 是否有改善
 */
function hillClimbStep(dayMap, total, y, m, availMap, maxWorkdays, lockedSet = null) {
  const baseScore = computeScore(dayMap, y, m);
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

  for (let attempt = 0; attempt < 120; attempt++) {
    const useShift = unfilledSlots.length > 0 && Math.random() < 0.5;

    if (useShift) {
      // ── Shift 移動：把某日/某位置的人移至缺口日的同位置 ──
      const slot = unfilledSlots[Math.floor(Math.random() * unfilledSlots.length)];
      const { d: d1, pos } = slot;

      // 找有該位置人員的另一天
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

      // 記錄移動前各位置人力
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

      if (isDayValid(d1, dayMap, y, m, prePow1) && isDayValid(d2, dayMap, y, m, prePow2)) {
        const newScore = computeScore(dayMap, y, m);
        if (newScore > bestScore) {
          bestScore = newScore;
          bestOp = { type: 'shift', d1, d2, pos, n2, idx2 };
        }
      }

      // 還原
      arr1.splice(arr1.lastIndexOf(n2), 1);
      names2.splice(idx2, 0, n2);

    } else {
      // ── 隨機對換（原有邏輯）──
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
        const newScore = computeScore(dayMap, y, m);
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
 * @param {Map<number, Map<string, string[]>>} dayMap
 * @returns {Object<string, Assignment[]>}
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
 * @param {Map<number, Map<string, string[]>>} dayMap
 * @param {number} y
 * @param {number} m
 * @returns {{day:number, position:string, shortBy:number}[]}
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

  // dayMap: Map<day, Map<position, names[]>>
  const dayMap = new Map();
  for (let d = 1; d <= total; d++) {
    dayMap.set(d, new Map([['counter', []], ['pharmacy', []], ['catClinic', []]]));
  }

  // ── 預填處理：建立 lockedSet，寫入 position 類型到 dayMap ─────────────
  const lockedSet = new Set(); // Set<"name|day">
  for (const [name, dayValues] of Object.entries(prefilled)) {
    for (const [dayStr, value] of Object.entries(dayValues)) {
      const day = Number(dayStr);
      lockedSet.add(`${name}|${day}`);
      if (value !== 'vacation' && POSITIONS.includes(value)) {
        const posArr = dayMap.get(day)?.get(value);
        if (posArr && !posArr.includes(name)) posArr.push(name);
      }
    }
  }

  const consec    = { usedException: false };
  const workCount = new Map(staff.map(p => [p.name, 0]));

  // workCount 初始化：計入預填排班天數
  for (const [name, dayValues] of Object.entries(prefilled)) {
    for (const value of Object.values(dayValues)) {
      if (value !== 'vacation' && POSITIONS.includes(value)) {
        workCount.set(name, (workCount.get(name) ?? 0) + 1);
      }
    }
  }

  // consec.usedException：若預填排班讓某 regular 人員連班達 maxDays，標記例外已用
  for (const [name, dayValues] of Object.entries(prefilled)) {
    const p = staffByName.get(name);
    if (!p || p.role !== 'regular') continue;
    for (const [dayStr, value] of Object.entries(dayValues)) {
      if (value === 'vacation') continue;
      const day = Number(dayStr);
      if (currentStreak(name, day - 1, dayMap) >= monthlyConstraints.consecutive.maxDays) {
        consec.usedException = true;
      }
    }
  }

  // ── 階段 1 ──────────────────────────────────────────────
  onProgress?.({ stage: 'phase1', message: '階段 1：建構初始可行解…', percent: 0 });
  let lastProgressMs = Date.now();

  for (let d = 1; d <= total; d++) {
    const result = assignDay(d, availMap, dayMap, workCount, maxWorkdays, consec, year, month, lockedSet);
    if (result) {
      for (const [pos, names] of result) {
        dayMap.get(d).set(pos, names);
        for (const name of names) {
          if (!lockedSet.has(`${name}|${d}`)) {
            workCount.set(name, (workCount.get(name) ?? 0) + 1);
          }
        }
      }
    }

    const now = Date.now();
    if (now - lastProgressMs >= 200) {
      onProgress?.({ stage: 'phase1', message: `階段 1：第 ${d}/${total} 天`, percent: Math.round(d / total * 50) });
      lastProgressMs = now;
    }
  }

  const phase1Overtime = Date.now() - startTime > timeLimitMs * 0.6;

  // ── 階段 1.5：補位掃描（填補 Phase 1 遺留的人力缺口）──────
  // 逐天逐位置掃描，對仍有缺口的位置補入最少班的可用人員。
  // 不做完整回溯，H5 rest-after-segment 由 validateHardRules 最終報告。
  if (!phase1Overtime) {
    onProgress?.({ stage: 'phase1', message: '階段 1.5：補位掃描中…', percent: 50 });

    for (let d = 1; d <= total; d++) {
      const posMap = dayMap.get(d);

      for (const pos of POSITIONS) {
        const req = positionRequirements[pos].dailyStaff;
        const names = posMap.get(pos);
        let power = names.reduce((s, n) => s + (staffByName.get(n)?.countsAs ?? 1), 0);
        if (power >= req) continue;

        // 今日已排人員（任何位置）
        const alreadyOnDay = new Set();
        for (const ns of posMap.values()) for (const n of ns) alreadyOnDay.add(n);

        // 候選人：可用 + 未超工時 + 可排此位置 + 連班未超限
        const fillers = staff
          .filter(p => {
            if (alreadyOnDay.has(p.name)) return false;
            if (!availMap.get(p.name)?.has(d)) return false;
            if ((workCount.get(p.name) ?? 0) >= (maxWorkdays.get(p.name) ?? 17)) return false;
            if (!p.positions.includes(pos)) return false;
            if (p.role === 'regular') {
              const streak = currentStreak(p.name, d - 1, dayMap);
              const maxC = monthlyConstraints.consecutive.maxDays;
              const maxE = monthlyConstraints.consecutive.exceptionalMaxDays;
              if (streak >= maxE) return false;
              if (streak >= maxC && consec.usedException) return false;
            }
            return true;
          })
          .sort((a, b) => {
            // catClinic：尚無有照者時有照候選優先
            if (pos === 'catClinic' && !names.some(n => staffByName.get(n)?.hasLicense)) {
              const aLic = a.hasLicense ? 0 : 1;
              const bLic = b.hasLicense ? 0 : 1;
              if (aLic !== bLic) return aLic - bLic;
            }
            return (workCount.get(a.name) ?? 0) - (workCount.get(b.name) ?? 0);
          });

        for (const p of fillers) {
          if (power >= req) break;

          // H3：需訓練者須有訓練者在同位置
          if (p.needsTraining) {
            const reqT = p.needsTraining.find(r => r.position === pos);
            if (reqT && !reqT.trainers.some(t => names.includes(t))) continue;
          }

          // H2 安全網：catClinic 已有人但無照時只接受有照者
          if (pos === 'catClinic' && names.length > 0 &&
              !names.some(n => staffByName.get(n)?.hasLicense) && !p.hasLicense) {
            continue;
          }

          names.push(p.name);
          workCount.set(p.name, (workCount.get(p.name) ?? 0) + 1);
          power += p.countsAs ?? 1;

          if (!consec.usedException && p.role === 'regular') {
            const streak = currentStreak(p.name, d - 1, dayMap);
            if (streak >= monthlyConstraints.consecutive.maxDays) consec.usedException = true;
          }
        }
      }
    }
  }

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

/*
 * ════════════════════════════════════════════════════════════════
 *  演算法說明
 * ════════════════════════════════════════════════════════════════
 *
 *  主要策略：
 *    階段 1 — 逐日貪婪建構
 *      按日期順序逐天分配人員。每天的填入順序為：
 *        catClinic（限制最多：需有照 + 訓練配對 + 機動只限週末）
 *        pharmacy（需訓練配對：莉婷需有雅卉或樂樂）
 *        counter（最寬鬆）
 *      候選人排序（MRV 概念）：
 *        countsAs 大 > positions 選項少 > 需訓練者優先
 *      [H3] 訓練配對安插：被訓練者被選中前，先嘗試將訓練者插入同位置。
 *      [H5] 連班：超限者直接排除在候選外，例外（第 4 天）每月限用一次。
 *
 *    階段 2 — Hill Climbing
 *      每輪隨機嘗試 60 次「兩日同位置一人對換」。
 *      換前後均驗證單日硬規則，換後若軟規則得分提升則保留。
 *      連續 40 輪無改善或超過 90% 時間上限時停止。
 *
 *  已知限制：
 *    1. 貪婪階段不做跨日回溯，月底可能因人員配額耗盡產生人力缺口。
 *    2. Hill Climbing 是局部搜尋，[S5] 仕賢/彤彤 catClinic ≥10 天
 *       在假期集中的月份可能無法完全達標。
 *    3. 機動人員 countsAs:2；hill climbing 目前僅支援 1:1 對換，
 *       不支援「機動 ↔ 兩名一般人員」的複合交換。
 *    4. [H5] 連班限制在貪婪階段以篩選實作（非完整回溯），
 *       極端假期分布下可能使某幾天人力不足。
 *
 *  建議測試情境：
 *    a. 多人同週休假（5 人同週）→ 驗證每日人力不足偵測
 *    b. 週末密集的月份         → 驗證機動人員排班與 catClinic 人力
 *    c. 小加小柚同時多天休假   → 驗證 catClinic 人力補位（仕賢/彤彤）
 *    d. 雅卉整月休假           → 驗證小柚 H3 訓練配對改由樂樂/毛毛承擔
 *    e. 仕賢+彤彤各有 ≥7 天假 → 驗證 S5 警告是否正確列出
 *    f. 俊傑週二週五特別多的月 → 驗證 H9 動態上限計算（如 2026/3）
 *    g. 全員零休假             → 驗證正常月份能否滿足所有硬規則
 * ════════════════════════════════════════════════════════════════
 */

export { validateHardRules };