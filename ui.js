/**
 * ui.js — Phase 4a：手動修改、位置循環、排班鎖定、驗證按鈕
 */

import { staff, workHoursConfig } from './data.js';
import { generateSchedule, validateHardRules } from './scheduler.js';

// 動態載入 ExcelJS（支援完整儲存格樣式，非同步，匯出時再檢查是否就緒）
(function () {
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
  document.head.appendChild(s);
}());

// ─── 常數 ────────────────────────────────────────────────────────────────────
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const POSITION_CONFIG = {
  counter:   { label: '櫃' },
  pharmacy:  { label: '藥' },
  catClinic: { label: '貓' },
};
const POSITION_CYCLE = ['counter', 'pharmacy', 'catClinic'];

// 人員快速查詢
const staffByName = new Map(staff.map(p => [p.name, p]));

// ─── 執行時狀態 ───────────────────────────────────────────────────────────────
let currentYear  = 0;
let currentMonth = 0;
let editMode     = 'vacation'; // 'vacation' | 'position' | 'lock'
// vacationMap: { 姓名: Set<number> }
let vacationMap  = {};
// scheduleMap: { 姓名: { 日期數字: position } }
let scheduleMap  = {};
// lockMap: { 姓名: Set<number> }
let lockMap      = {};
// 最近一次 generateSchedule 的完整結果（或從 localStorage 還原）
let lastScheduleResult = null;

// ─── LocalStorage 工具 ────────────────────────────────────────────────────────

function vacationStorageKey(y, m) {
  return `vacation_${y}_${String(m).padStart(2, '0')}`;
}
function scheduleStorageKey(y, m) {
  return `schedule_${y}_${String(m).padStart(2, '0')}`;
}
function lockStorageKey(y, m) {
  return `lock_${y}_${String(m).padStart(2, '0')}`;
}

function loadSetMap(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    const result = {};
    for (const [name, days] of Object.entries(obj)) {
      result[name] = new Set(days);
    }
    return result;
  } catch { return {}; }
}

function saveSetMap(key, map) {
  const serializable = {};
  for (const [name, daySet] of Object.entries(map)) {
    if (daySet.size > 0) {
      serializable[name] = [...daySet].sort((a, b) => a - b);
    }
  }
  localStorage.setItem(key, JSON.stringify(serializable));
}

function loadVacations(y, m)  { return loadSetMap(vacationStorageKey(y, m)); }
function loadLockMap(y, m)    { return loadSetMap(lockStorageKey(y, m)); }
function saveVacations()       { saveSetMap(vacationStorageKey(currentYear, currentMonth), vacationMap); }
function saveLockMap()         { saveSetMap(lockStorageKey(currentYear, currentMonth), lockMap); }

function loadScheduleFromStorage(y, m) {
  const raw = localStorage.getItem(scheduleStorageKey(y, m));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function saveScheduleToStorage(result) {
  localStorage.setItem(
    scheduleStorageKey(currentYear, currentMonth),
    JSON.stringify({
      schedule:       result.schedule,
      hardViolations: result.hardViolations,
      softViolations: result.softViolations,
      unfilled:       result.unfilled,
      workdayCount:   result.workdayCount,
      summary:        result.summary,
    })
  );
}

// ─── 日期工具 ────────────────────────────────────────────────────────────────

function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
function weekdayOf(y, m, d) { return new Date(y, m - 1, d).getDay(); }

// ─── 禁用格判斷 ──────────────────────────────────────────────────────────────

function isDisabled(person, weekday) {
  if (person.workableDays === 'weekendOnly' && weekday !== 0 && weekday !== 6) return true;
  if (person.forbiddenWeekdays.includes(weekday)) return true;
  return false;
}

// ─── 排班 Map 轉換 ────────────────────────────────────────────────────────────

function buildScheduleMap(schedule) {
  const map = {};
  for (const [name, assignments] of Object.entries(schedule)) {
    map[name] = {};
    for (const { day, position } of assignments) {
      map[name][day] = position;
    }
  }
  return map;
}

/** scheduleMap → generateSchedule 所需的 schedule 格式 */
function scheduleMapToSchedule() {
  const schedule = {};
  for (const [name, dayAssign] of Object.entries(scheduleMap)) {
    schedule[name] = [];
    for (const [dayStr, pos] of Object.entries(dayAssign)) {
      schedule[name].push({ day: Number(dayStr), position: pos });
    }
    schedule[name].sort((a, b) => a.day - b.day);
  }
  return schedule;
}

/** 從 scheduleMap 建立 validateHardRules 所需的 dayMap */
function buildDayMapFromCurrent(y, m) {
  const total = daysInMonth(y, m);
  const dayMap = {};
  for (let d = 1; d <= total; d++) {
    dayMap[d] = { counter: [], pharmacy: [], catClinic: [] };
  }
  for (const [name, dayAssign] of Object.entries(scheduleMap)) {
    for (const [dayStr, pos] of Object.entries(dayAssign)) {
      const d = Number(dayStr);
      if (dayMap[d] && dayMap[d][pos]) {
        dayMap[d][pos].push(name);
      }
    }
  }
  return dayMap;
}

// ─── 格子互動（分模式） ───────────────────────────────────────────────────────

function onCellClick(personName, day) {
  if (editMode === 'vacation')  return onCellClickVacation(personName, day);
  if (editMode === 'position')  return onCellClickPosition(personName, day);
  if (editMode === 'lock')      return onCellClickLock(personName, day);
}

function onCellClickVacation(personName, day) {
  if (!vacationMap[personName]) vacationMap[personName] = new Set();
  const set = vacationMap[personName];
  if (set.has(day)) set.delete(day);
  else set.add(day);
  saveVacations();
  refreshCell(personName, day);
  refreshStats();
}

function onCellClickPosition(personName, day) {
  const person = staffByName.get(personName);
  if (!person) return;

  // 可用位置僅限此人 positions 陣列中的項目
  const available = POSITION_CYCLE.filter(p => person.positions?.includes(p));
  if (available.length === 0) return;

  const current = scheduleMap[personName]?.[day] ?? null;
  const idx = available.indexOf(current);
  // null → first, last → null
  const next = idx < available.length - 1 ? available[idx + 1] : null;

  if (!scheduleMap[personName]) scheduleMap[personName] = {};
  if (next === null) {
    delete scheduleMap[personName][day];
  } else {
    scheduleMap[personName][day] = next;
  }

  // 清除休假（位置編輯優先）
  if (vacationMap[personName]?.has(day)) {
    vacationMap[personName].delete(day);
    saveVacations();
  }

  saveCurrentSchedule();
  refreshCell(personName, day);
  refreshStats();
}

function onCellClickLock(personName, day) {
  if (!lockMap[personName]) lockMap[personName] = new Set();
  const set = lockMap[personName];
  if (set.has(day)) set.delete(day);
  else set.add(day);
  saveLockMap();
  refreshCell(personName, day);
}

function saveCurrentSchedule() {
  if (!lastScheduleResult) return;
  const schedule = scheduleMapToSchedule();
  saveScheduleToStorage({ ...lastScheduleResult, schedule });
}

// ─── 格子外觀 ─────────────────────────────────────────────────────────────────

function refreshCell(personName, day) {
  const td = document.querySelector(
    `#schedule-table tr[data-name="${personName}"] td[data-day="${day}"]`
  );
  if (!td) return;

  const isWeekend = td.classList.contains('weekend');
  td.className = 'cell-day' + (isWeekend ? ' weekend' : '');
  td.textContent = '';

  if (vacationMap[personName]?.has(day)) {
    td.classList.add('vacation');
    td.textContent = '休';
  } else {
    const pos = scheduleMap[personName]?.[day];
    if (pos) applyScheduleCell(td, personName, pos);
  }

  if (lockMap[personName]?.has(day)) {
    td.classList.add('locked');
  }
}

function applyScheduleCell(td, personName, position) {
  const p      = staffByName.get(personName);
  const isFlex = p?.role === 'flex';
  const cfg    = POSITION_CONFIG[position];
  if (!cfg) return;

  if (isFlex) {
    td.classList.add(`pos-flex-${position}`);
    td.innerHTML = `${cfg.label}<span class="x2-label">×2</span>`;
  } else {
    td.classList.add(`pos-${position}`);
    td.textContent = cfg.label;
  }
}

// ─── 建立表格 ────────────────────────────────────────────────────────────────

function buildTable() {
  const y     = currentYear;
  const m     = currentMonth;
  const total = daysInMonth(y, m);

  const thead = document.getElementById('schedule-thead');
  const tbody = document.getElementById('schedule-tbody');
  const tfoot = document.getElementById('schedule-tfoot');
  thead.innerHTML = '';
  tbody.innerHTML = '';
  tfoot.innerHTML = '';

  // ── 表頭列 ──
  const hRow = document.createElement('tr');

  const thCorner = document.createElement('th');
  thCorner.className = 'col-name';
  thCorner.textContent = '人員';
  hRow.appendChild(thCorner);

  for (let d = 1; d <= total; d++) {
    const wd = weekdayOf(y, m, d);
    const th = document.createElement('th');
    th.className = 'col-day' + (wd === 0 || wd === 6 ? ' weekend' : '');
    th.innerHTML = `${d}<span class="wd-label">${WEEKDAY_NAMES[wd]}</span>`;
    hRow.appendChild(th);
  }

  const thStat = document.createElement('th');
  thStat.className = 'col-stat';
  thStat.textContent = '已休 / 應上';
  hRow.appendChild(thStat);
  thead.appendChild(hRow);

  // ── 人員列 ──
  for (const person of staff) {
    const tr = document.createElement('tr');
    tr.dataset.name = person.name;

    const tdName = document.createElement('td');
    tdName.className = 'cell-name';
    tdName.id = `name-cell-${person.name}`;
    if (person.role === 'flex') tdName.classList.add('flex-staff');
    tdName.textContent = person.name;
    tr.appendChild(tdName);

    for (let d = 1; d <= total; d++) {
      const wd = weekdayOf(y, m, d);
      const td = document.createElement('td');
      td.className = 'cell-day';
      td.dataset.day = d;
      if (wd === 0 || wd === 6) td.classList.add('weekend');

      if (isDisabled(person, wd)) {
        td.classList.add('disabled');
        if (person.externalDuty && person.externalDuty.weekdays.includes(wd)) {
          td.classList.add('external-duty');
          td.textContent = person.externalDuty.label;
        }
      } else {
        td.addEventListener('click', () => onCellClick(person.name, d));

        if (vacationMap[person.name]?.has(d)) {
          td.classList.add('vacation');
          td.textContent = '休';
        } else {
          const pos = scheduleMap[person.name]?.[d];
          if (pos) applyScheduleCell(td, person.name, pos);
        }

        if (lockMap[person.name]?.has(d)) {
          td.classList.add('locked');
        }
      }

      tr.appendChild(td);
    }

    const tdStat = document.createElement('td');
    tdStat.className = 'cell-stat';
    tdStat.id = `stat-cell-${person.name}`;
    tr.appendChild(tdStat);

    tbody.appendChild(tr);
  }

  // ── 表尾：每日人力 ──
  const fRow = document.createElement('tr');

  const tfLabel = document.createElement('td');
  tfLabel.className = 'cell-name foot-label';
  tfLabel.textContent = '每日人力';
  fRow.appendChild(tfLabel);

  for (let d = 1; d <= total; d++) {
    const wd = weekdayOf(y, m, d);
    const td = document.createElement('td');
    td.className = 'cell-day cell-power';
    td.id = `power-${d}`;
    if (wd === 0 || wd === 6) td.classList.add('weekend');
    fRow.appendChild(td);
  }

  const tfStat = document.createElement('td');
  tfStat.className = 'cell-stat foot-label';
  tfStat.textContent = '目標 ≥ 9';
  fRow.appendChild(tfStat);
  tfoot.appendChild(fRow);

  refreshStats();
}

// ─── 統計計算 ────────────────────────────────────────────────────────────────

function refreshStats() {
  const y     = currentYear;
  const m     = currentMonth;
  const total = daysInMonth(y, m);

  for (let d = 1; d <= total; d++) {
    const wd = weekdayOf(y, m, d);
    let power = 0;

    if (lastScheduleResult) {
      for (const [name, dayAssign] of Object.entries(scheduleMap)) {
        if (dayAssign[d]) power += staffByName.get(name)?.countsAs ?? 1;
      }
    } else {
      for (const p of staff) {
        if (isDisabled(p, wd)) continue;
        if (!vacationMap[p.name]?.has(d)) power += p.countsAs;
      }
    }

    const el = document.getElementById(`power-${d}`);
    if (el) {
      el.textContent = power;
      el.classList.toggle('power-warning', power < 9);
    }
  }

  for (const p of staff) {
    const statEl = document.getElementById(`stat-cell-${p.name}`);
    const nameEl = document.getElementById(`name-cell-${p.name}`);
    if (!statEl) continue;

    if (p.role === 'flex') {
      statEl.textContent = '—';
      statEl.className = 'cell-stat';
      if (nameEl) {
        nameEl.classList.remove('name-warning');
        nameEl.classList.remove('name-hard-warning');
      }
      continue;
    }

    let externalDays = 0;
    if (p.externalDuty) {
      for (let d = 1; d <= total; d++) {
        if (p.externalDuty.weekdays.includes(weekdayOf(y, m, d))) externalDays++;
      }
    }
    const externalHours = p.externalDuty ? externalDays * p.externalDuty.hoursPerDay : 0;
    const personMaxDays = Math.floor(
      (workHoursConfig.monthlyHoursLimit.regular - externalHours) / workHoursConfig.hoursPerDay
    );

    let vacTaken  = 0;
    let availDays = 0;
    for (let d = 1; d <= total; d++) {
      const wd = weekdayOf(y, m, d);
      if (isDisabled(p, wd)) continue;
      availDays++;
      if (vacationMap[p.name]?.has(d)) vacTaken++;
    }

    const workdayCountFromMap = Object.keys(scheduleMap[p.name] ?? {}).length;
    const workDays = lastScheduleResult
      ? workdayCountFromMap
      : availDays - vacTaken;

    const overLimit   = workDays > personMaxDays;
    const hasHardViol = lastScheduleResult?.hardViolations?.some(v => v.staff?.includes(p.name)) ?? false;

    statEl.textContent = p.externalDuty
      ? `休 ${vacTaken} / 上 ${workDays} / 外 ${externalDays}`
      : `休 ${vacTaken} / 上 ${workDays}`;
    statEl.className = 'cell-stat' + (overLimit ? ' stat-warning' : '');

    if (nameEl) {
      nameEl.classList.toggle('name-hard-warning', hasHardViol);
      nameEl.classList.toggle('name-warning', overLimit && !hasHardViol);
    }
  }
}

// ─── 違規面板 ────────────────────────────────────────────────────────────────

function renderViolationsPanel(result) {
  const panel = document.getElementById('violations-panel');
  if (!panel) return;

  const total = result.hardViolations.length + result.softViolations.length;
  if (total === 0) { panel.style.display = 'none'; return; }

  panel.style.display = '';
  const hasHard = result.hardViolations.length > 0;
  const summary = panel.querySelector('summary');
  const list    = panel.querySelector('.viol-list');

  summary.className   = hasHard ? 'has-hard' : '';
  summary.textContent = `${hasHard ? '⛔' : '⚠'} 排班警告（${total} 項）`;

  list.innerHTML = '';
  for (const v of result.hardViolations) {
    const item = document.createElement('div');
    item.className = 'viol-item hard';
    item.innerHTML = `<span class="viol-id">[${v.ruleId}]</span> ${v.message}`;
    list.appendChild(item);
  }
  for (const v of result.softViolations) {
    const item = document.createElement('div');
    item.className = 'viol-item soft';
    item.innerHTML = `<span class="viol-id">[${v.ruleId}]</span> ${v.message}`;
    list.appendChild(item);
  }
}

function clearViolationsPanel() {
  const panel = document.getElementById('violations-panel');
  if (panel) panel.style.display = 'none';
}

// ─── 進度條 Modal ─────────────────────────────────────────────────────────────

function updateProgressModal({ stage, message, percent }) {
  const label = stage === 'phase1' ? '階段 1：建構可行解'
              : stage === 'phase2' ? '階段 2：軟規則優化'
              : '完成';
  const stageEl = document.getElementById('modal-stage');
  const msgEl   = document.getElementById('modal-message');
  const fillEl  = document.getElementById('modal-bar-fill');
  if (stageEl) stageEl.textContent = label;
  if (msgEl)   msgEl.textContent   = message;
  if (fillEl)  fillEl.style.width  = `${percent}%`;
}

function showProgressModal() {
  updateProgressModal({ stage: 'phase1', message: '準備中…', percent: 0 });
  document.getElementById('schedule-modal')?.classList.add('active');
}

function hideProgressModal() {
  document.getElementById('schedule-modal')?.classList.remove('active');
}

// ─── 控制列摘要文字 ───────────────────────────────────────────────────────────

function updateSummaryLabel(text, hasError) {
  const el = document.getElementById('schedule-summary');
  if (!el) return;
  el.textContent = text;
  el.className   = hasError ? 'has-error' : 'has-warning';
}

function clearSummaryLabel() {
  const el = document.getElementById('schedule-summary');
  if (!el) return;
  el.textContent = '';
  el.className   = '';
}

// ─── 工具：計算每人月上班天數上限 ────────────────────────────────────────────

function computeMaxWorkdays(y, m) {
  const total = daysInMonth(y, m);
  const maxWorkdays = {};
  for (const p of staff) {
    let externalDays = 0;
    if (p.externalDuty) {
      for (let d = 1; d <= total; d++) {
        if (p.externalDuty.weekdays.includes(weekdayOf(y, m, d))) externalDays++;
      }
    }
    const externalHours = p.externalDuty ? externalDays * p.externalDuty.hoursPerDay : 0;
    maxWorkdays[p.name] = Math.floor(
      (workHoursConfig.monthlyHoursLimit.regular - externalHours) / workHoursConfig.hoursPerDay
    );
  }
  return maxWorkdays;
}

// ─── 驗證當前排班 ─────────────────────────────────────────────────────────────

function runValidation() {
  const y = currentYear;
  const m = currentMonth;
  const dayMap = buildDayMapFromCurrent(y, m);
  const maxWorkdays = computeMaxWorkdays(y, m);

  const hardViolations = validateHardRules(dayMap, y, m, maxWorkdays);
  const softViolations = lastScheduleResult?.softViolations ?? [];

  const result = { hardViolations, softViolations };
  renderViolationsPanel(result);
  updateSummaryLabel(
    hardViolations.length > 0
      ? `⛔ ${hardViolations.length} 項硬規則違反`
      : softViolations.length > 0
        ? `⚠ ${softViolations.length} 項軟規則警告`
        : '✓ 無違規',
    hardViolations.length > 0
  );

  // 更新姓名格紅色標記
  for (const p of staff) {
    const nameEl = document.getElementById(`name-cell-${p.name}`);
    if (!nameEl) continue;
    const hasHardViol = hardViolations.some(v => v.staff?.includes(p.name));
    nameEl.classList.toggle('name-hard-warning', hasHardViol);
  }
}

// ─── 主要操作 ─────────────────────────────────────────────────────────────────

function onAutoSchedule() {
  showProgressModal();

  setTimeout(() => {
    const y = currentYear;
    const m = currentMonth;

    // 基本休假（vacationMap → vacations）
    const vacations = {};
    for (const [name, daySet] of Object.entries(vacationMap)) {
      if (daySet.size > 0) vacations[name] = [...daySet].sort((a, b) => a - b);
    }

    // 從 lockMap 組成 prefilled（演算法層級硬約束）
    // - 有位置的格子：prefilled[name][day] = position
    // - 空白的格子：加入 vacations，讓演算法不排入任何人
    // - 休假的格子：已在 vacations 中，不需另外處理
    // - isDisabled 的格子：跳過（不應被鎖定）
    const prefilled = {};
    for (const [name, daySet] of Object.entries(lockMap)) {
      for (const day of daySet) {
        const person = staffByName.get(name);
        if (!person || isDisabled(person, weekdayOf(y, m, day))) continue;

        if (scheduleMap[name]?.[day]) {
          if (!prefilled[name]) prefilled[name] = {};
          prefilled[name][day] = scheduleMap[name][day];
        } else if (!vacationMap[name]?.has(day)) {
          // 空白鎖定格：加入 vacations 防止演算法排入此人
          if (!vacations[name]) vacations[name] = [];
          if (!vacations[name].includes(day)) vacations[name].push(day);
        }
        // 休假格：vacationMap → vacations 已處理，無需重複
      }
    }

    try {
      const result = generateSchedule(y, m, vacations, {
        timeLimitMs: 30000,
        onProgress:  updateProgressModal,
      }, prefilled);

      lastScheduleResult = result;
      scheduleMap        = buildScheduleMap(result.schedule);

      saveScheduleToStorage(lastScheduleResult);
      buildTable();
      renderViolationsPanel(lastScheduleResult);
      updateSummaryLabel(lastScheduleResult.summary, lastScheduleResult.hardViolations.length > 0);

      updateProgressModal({ stage: 'done', message: '排班完成', percent: 100 });
      setTimeout(() => hideProgressModal(), 500);
    } catch (err) {
      console.error('[ui] generateSchedule 錯誤:', err);
      hideProgressModal();
      alert('排班過程發生錯誤，請查看 console。');
    }
  }, 50);
}

function onClearSchedule() {
  if (!confirm('確定要清除排班結果嗎？休假資料與鎖定不會被刪除。')) return;
  lastScheduleResult = null;
  scheduleMap        = {};
  localStorage.removeItem(scheduleStorageKey(currentYear, currentMonth));
  buildTable();
  clearViolationsPanel();
  clearSummaryLabel();
}

// ─── 控制列事件 ──────────────────────────────────────────────────────────────

function onYearMonthChange() {
  currentYear  = parseInt(document.getElementById('sel-year').value, 10);
  currentMonth = parseInt(document.getElementById('sel-month').value, 10);
  vacationMap  = loadVacations(currentYear, currentMonth);
  lockMap      = loadLockMap(currentYear, currentMonth);

  const stored = loadScheduleFromStorage(currentYear, currentMonth);
  if (stored) {
    lastScheduleResult = stored;
    scheduleMap        = buildScheduleMap(stored.schedule);
  } else {
    lastScheduleResult = null;
    scheduleMap        = {};
  }

  updateCurrentLabel();
  buildTable();

  if (lastScheduleResult) {
    renderViolationsPanel(lastScheduleResult);
    updateSummaryLabel(lastScheduleResult.summary, lastScheduleResult.hardViolations.length > 0);
  } else {
    clearViolationsPanel();
    clearSummaryLabel();
  }
}

function onClearAll() {
  if (!confirm(`確定要清空 ${currentYear} 年 ${currentMonth} 月的所有休假紀錄嗎？`)) return;
  vacationMap = {};
  localStorage.removeItem(vacationStorageKey(currentYear, currentMonth));
  buildTable();
}

function updateCurrentLabel() {
  const el = document.getElementById('current-label');
  if (el) el.textContent = `${currentYear} 年 ${currentMonth} 月`;
}

// ─── CSS 注入 ─────────────────────────────────────────────────────────────────

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    /* 外單位格 */
    .cell-day.external-duty { color: #7f8c8d; font-size: 11px; font-weight: 600; }

    /* 位置色塊 */
    .cell-day.pos-counter   { background: #27ae60 !important; color: #fff !important; font-weight: 700; font-size: 13px; }
    .cell-day.pos-pharmacy  { background: #3498db !important; color: #fff !important; font-weight: 700; font-size: 13px; }
    .cell-day.pos-catClinic { background: #e67e22 !important; color: #fff !important; font-weight: 700; font-size: 13px; }

    /* 機動人員：斜線底紋疊加位置色 */
    .cell-day.pos-flex-pharmacy {
      background: repeating-linear-gradient(
        45deg, #3498db 0px, #3498db 5px, #2980b9 5px, #2980b9 10px
      ) !important;
      color: #fff !important; font-weight: 700; font-size: 11px;
    }
    .cell-day.pos-flex-catClinic {
      background: repeating-linear-gradient(
        45deg, #e67e22 0px, #e67e22 5px, #ca6f1e 5px, #ca6f1e 10px
      ) !important;
      color: #fff !important; font-weight: 700; font-size: 11px;
    }
    .x2-label { font-size: 8px; vertical-align: super; margin-left: 1px; }

    /* 硬規則違反：姓名格紅底 */
    .name-hard-warning { background: #e74c3c !important; color: #fff !important; }

    /* 鎖定格：金色邊框 */
    .cell-day.locked { box-shadow: inset 0 0 0 3px #f1c40f !important; }

    /* 控制列：編輯模式群組 */
    .edit-mode-group {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; color: #bdc3c7;
    }
    .edit-mode-group label {
      display: flex; align-items: center; gap: 3px;
      cursor: pointer; color: #ecf0f1;
    }
    .edit-mode-group input[type="radio"] { cursor: pointer; accent-color: #f1c40f; }

    /* 控制列：排班摘要文字 */
    #schedule-summary {
      font-size: 11px; color: #bdc3c7;
      max-width: 240px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    #schedule-summary.has-warning { color: #f39c12; }
    #schedule-summary.has-error   { color: #e74c3c; }

    /* 自動排班按鈕（綠色） */
    #btn-schedule {
      padding: 4px 14px; background: #27ae60; color: #fff;
      border: none; border-radius: 4px; font-size: 13px;
      font-weight: 600; cursor: pointer; transition: background 0.15s;
    }
    #btn-schedule:hover { background: #219a52; }

    /* 清除排班按鈕（灰色） */
    #btn-clear-schedule {
      padding: 4px 14px; background: #7f8c8d; color: #fff;
      border: none; border-radius: 4px; font-size: 13px;
      font-weight: 600; cursor: pointer; transition: background 0.15s;
    }
    #btn-clear-schedule:hover { background: #6c7a7d; }

    /* 驗證按鈕（紫色） */
    #btn-validate {
      padding: 4px 14px; background: #8e44ad; color: #fff;
      border: none; border-radius: 4px; font-size: 13px;
      font-weight: 600; cursor: pointer; transition: background 0.15s;
    }
    #btn-validate:hover { background: #7d3c98; }

    /* Modal 覆蓋層 */
    #schedule-modal {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.5); z-index: 200;
      align-items: center; justify-content: center;
    }
    #schedule-modal.active { display: flex; }
    .modal-box {
      background: #fff; border-radius: 8px;
      padding: 28px 32px; min-width: 340px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.25); text-align: center;
    }
    .modal-stage {
      font-size: 11px; font-weight: 700; color: #95a5a6;
      margin-bottom: 6px; letter-spacing: 0.08em; text-transform: uppercase;
    }
    .modal-message {
      font-size: 14px; font-weight: 600; color: #2c3e50;
      margin-bottom: 16px; min-height: 38px;
    }
    .modal-bar-wrap {
      height: 10px; background: #ecf0f1;
      border-radius: 5px; overflow: hidden; margin-bottom: 8px;
    }
    .modal-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #27ae60, #2ecc71);
      border-radius: 5px; transition: width 0.2s ease;
    }

    /* 違規面板 */
    #violations-panel {
      margin: 0 12px 24px; border-radius: 6px;
      border: 1px solid #e0e4ea; background: #fff;
      font-size: 12px; overflow: hidden;
    }
    #violations-panel summary {
      cursor: pointer; padding: 10px 14px;
      font-weight: 700; color: #e67e22;
      background: #fff9f0; border-bottom: 1px solid #e0e4ea;
      list-style: none; user-select: none;
    }
    #violations-panel summary::-webkit-details-marker { display: none; }
    #violations-panel summary.has-hard { color: #e74c3c; background: #fef0ef; }
    #violations-panel .viol-list {
      padding: 8px 14px; max-height: 220px; overflow-y: auto;
    }
    .viol-item { padding: 3px 0; border-bottom: 1px solid #f5f5f5; }
    .viol-item:last-child { border-bottom: none; }
    .viol-id { display: inline-block; min-width: 36px; font-weight: 700; }
    .viol-item.hard { color: #c0392b; }
    .viol-item.soft { color: #95a5a6; }

    /* 匯出班表按鈕（深綠） */
    #btn-export-excel {
      padding: 4px 14px; background: #1a7a4a; color: #fff;
      border: none; border-radius: 4px; font-size: 13px;
      font-weight: 600; cursor: pointer; transition: background 0.15s;
    }
    #btn-export-excel:hover { background: #145e38; }

    /* 匯出/匯入備份（藍灰） */
    #btn-export-json, #btn-import-json {
      padding: 4px 14px; background: #566573; color: #fff;
      border: none; border-radius: 4px; font-size: 13px;
      font-weight: 600; cursor: pointer; transition: background 0.15s;
    }
    #btn-export-json:hover, #btn-import-json:hover { background: #424d57; }

    /* ── 側邊欄切換按鈕 ── */
    #sidebar-toggle {
      position: fixed; right: 0; top: 50%;
      transform: translateY(-50%);
      z-index: 300;
      writing-mode: vertical-rl; text-orientation: mixed;
      padding: 12px 7px;
      background: #2c3e50; color: #ecf0f1;
      border: none; border-radius: 6px 0 0 6px;
      font-size: 13px; font-weight: 600; cursor: pointer;
      transition: right 0.3s ease, background 0.15s;
      white-space: nowrap; line-height: 1.4;
    }
    #sidebar-toggle:hover { background: #34495e; }
    body.sidebar-open #sidebar-toggle { right: 320px; }

    /* ── 側邊欄主體 ── */
    #sidebar-panel {
      position: fixed; right: -320px; top: 0; bottom: 0; width: 320px;
      background: #fff;
      box-shadow: -4px 0 20px rgba(0,0,0,0.15);
      z-index: 290; overflow-y: auto;
      transition: right 0.3s ease;
    }
    body.sidebar-open #sidebar-panel { right: 0; }

    /* ── 側邊欄內層 ── */
    .sidebar-inner { padding: 0 0 32px; }

    /* 頂層摺疊區塊 */
    .sb-block { border-bottom: 1px solid #e0e4ea; }
    .sb-block > summary {
      padding: 11px 16px; font-size: 14px; font-weight: 700;
      color: #2c3e50; background: #f4f6f8;
      cursor: pointer; list-style: none; user-select: none;
      display: flex; align-items: center; gap: 6px;
    }
    .sb-block > summary::-webkit-details-marker { display: none; }
    .sb-block > summary .sb-arrow { font-size: 10px; color: #95a5a6; transition: transform 0.2s; }
    .sb-block[open] > summary .sb-arrow { transform: rotate(90deg); }

    /* 頂層內容 */
    .sb-content { padding: 4px 0 8px; }

    /* 子摺疊 */
    .sb-sub { border-top: 1px solid #f0f3f6; }
    .sb-sub > summary {
      padding: 7px 16px 7px 20px;
      font-size: 13px; font-weight: 600; color: #34495e;
      cursor: pointer; list-style: none; user-select: none;
      display: flex; align-items: center; gap: 5px;
    }
    .sb-sub > summary::-webkit-details-marker { display: none; }
    .sb-sub > summary .sb-arrow { font-size: 9px; color: #bdc3c7; transition: transform 0.2s; }
    .sb-sub[open] > summary .sb-arrow { transform: rotate(90deg); }

    /* 文字內容 */
    .sb-content ul, .sb-content ol {
      margin: 4px 0 6px; padding-left: 30px;
      font-size: 13px; color: #2c3e50; line-height: 1.75;
    }
    .sb-steps { padding-left: 26px; }
    .sb-hint { font-size: 11px; color: #95a5a6; }
    .sb-names {
      margin: 4px 16px 6px 20px;
      font-size: 13px; color: #2c3e50; line-height: 1.75;
    }

    /* 位置色標（可在 sidebar 內複用） */
    .sb-c   { color: #27ae60; font-weight: 600; }
    .sb-p   { color: #3498db; font-weight: 600; }
    .sb-cat { color: #e67e22; font-weight: 600; }
  `;
  document.head.appendChild(style);
}

// ─── 匯出班表 Excel（ExcelJS）────────────────────────────────────────────────

async function onExportSchedule() {
  if (!window.ExcelJS) {
    alert('Excel 模組尚未載入完成，請稍候再試。');
    return;
  }

  const y     = currentYear;
  const m     = currentMonth;
  const total = daysInMonth(y, m);

  const workbook = new ExcelJS.Workbook();
  const sheet    = workbook.addWorksheet(`${y}年${m}月班表`);

  const thinGray = { style: 'thin', color: { argb: 'FFE8EAED' } };
  const border   = { top: thinGray, bottom: thinGray, left: thinGray, right: thinGray };

  // ── 第 1 列：標題 ──
  sheet.mergeCells(1, 1, 1, total + 1);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value     = `${y} 年 ${m} 月排班表`;
  titleCell.font      = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  titleCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 28;

  // ── 第 2 列：日期表頭 ──
  const h2name = sheet.getCell(2, 1);
  h2name.value     = '姓名';
  h2name.font      = { bold: true };
  h2name.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECF0F1' } };
  h2name.alignment = { horizontal: 'center', vertical: 'middle' };
  h2name.border    = border;

  for (let d = 1; d <= total; d++) {
    const wd     = weekdayOf(y, m, d);
    const isWknd = wd === 0 || wd === 6;
    const cell   = sheet.getCell(2, d + 1);
    cell.value     = d;
    cell.font      = { bold: true, color: { argb: isWknd ? 'FF2471A3' : 'FF2C3E50' } };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: isWknd ? 'FFD6EAF8' : 'FFECF0F1' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border    = border;
  }
  sheet.getRow(2).height = 18;

  // ── 第 3 列：星期表頭 ──
  const h3name = sheet.getCell(3, 1);
  h3name.value     = '—';
  h3name.font      = { color: { argb: 'FF95A5A6' } };
  h3name.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECF0F1' } };
  h3name.alignment = { horizontal: 'center', vertical: 'middle' };
  h3name.border    = border;

  for (let d = 1; d <= total; d++) {
    const wd     = weekdayOf(y, m, d);
    const isWknd = wd === 0 || wd === 6;
    const cell   = sheet.getCell(3, d + 1);
    cell.value     = WEEKDAY_NAMES[wd];
    cell.font      = { bold: true, color: { argb: isWknd ? 'FF2471A3' : 'FF7F8C8D' } };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: isWknd ? 'FFD6EAF8' : 'FFECF0F1' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border    = border;
  }
  sheet.getRow(3).height = 15;

  // ── 第 4 列起：人員 ──
  const colorMap = {
    counter:   { bg: 'FF27AE60', label: '櫃' },
    pharmacy:  { bg: 'FF3498DB', label: '藥' },
    catClinic: { bg: 'FFE67E22', label: '貓' },
  };
  const flexColorMap = {
    pharmacy:  { bg: 'FF2980B9', label: '藥×2' },
    catClinic: { bg: 'FFCA6F1E', label: '貓×2' },
  };

  let rowIdx = 4;
  for (const person of staff) {
    const nameCell   = sheet.getCell(rowIdx, 1);
    nameCell.value     = person.name;
    nameCell.font      = { bold: true };
    nameCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6F7' } };
    nameCell.alignment = { horizontal: 'left', vertical: 'middle' };
    nameCell.border    = border;

    for (let d = 1; d <= total; d++) {
      const wd   = weekdayOf(y, m, d);
      const cell = sheet.getCell(rowIdx, d + 1);
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border    = border;

      // 外單位 > 休假 > 排班位置 > 空白
      if (person.externalDuty?.weekdays.includes(wd)) {
        cell.value = person.externalDuty.label ?? '外';
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD5D8DC' } };
        cell.font  = { color: { argb: 'FF7F8C8D' }, bold: true };
      } else if (vacationMap[person.name]?.has(d)) {
        cell.value = '休';
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFADB5BD' } };
        cell.font  = { color: { argb: 'FF2D3436' }, bold: true };
      } else {
        const pos = scheduleMap[person.name]?.[d];
        if (pos) {
          const cfg = person.role === 'flex' ? flexColorMap[pos] : colorMap[pos];
          if (cfg) {
            cell.value = cfg.label;
            cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: cfg.bg } };
            cell.font  = { color: { argb: 'FFFFFFFF' }, bold: true };
          }
        } else {
          const isWknd = wd === 0 || wd === 6;
          if (isWknd) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEBF5FB' } };
        }
      }
    }
    sheet.getRow(rowIdx).height = 18;
    rowIdx++;
  }

  // ── 欄寬 ──
  sheet.getColumn(1).width = 10;
  for (let d = 1; d <= total; d++) sheet.getColumn(d + 1).width = 5;

  // ── 凍結窗格 ──
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];

  // ── 產生並下載 ──
  const buffer = await workbook.xlsx.writeBuffer();
  const blob   = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = `班表_${y}_${m}月.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── 匯出備份 JSON ────────────────────────────────────────────────────────────

function onExportJSON() {
  const y = currentYear;
  const m = currentMonth;

  const vacations = {};
  for (const [name, daySet] of Object.entries(vacationMap)) {
    if (daySet.size > 0) vacations[name] = [...daySet].sort((a, b) => a - b);
  }
  const locks = {};
  for (const [name, daySet] of Object.entries(lockMap)) {
    if (daySet.size > 0) locks[name] = [...daySet].sort((a, b) => a - b);
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;

  const data = {
    version:    '1.0',
    year:       y,
    month:      m,
    exportedAt: now.toISOString().slice(0, 19),
    vacations,
    schedule:   lastScheduleResult ?? null,
    locks,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `排班備份_${y}_${m}月_${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── 匯入備份 JSON ────────────────────────────────────────────────────────────

function onImportJSON() {
  const input    = document.createElement('input');
  input.type     = 'file';
  input.accept   = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.target.result);
      } catch {
        alert('檔案格式錯誤：無法解析 JSON。');
        return;
      }
      if (!data.version || !data.year || !data.month) {
        alert('檔案格式錯誤：缺少必要欄位（version、year、month）。');
        return;
      }

      const y = data.year;
      const m = data.month;
      if (!confirm(
        `將覆蓋當前 ${currentYear} 年 ${currentMonth} 月的所有資料（休假、排班、鎖定），\n` +
        `並切換到備份檔的 ${y} 年 ${m} 月。\n是否繼續？`
      )) return;

      // 寫入 localStorage
      const writeOrClear = (key, val) =>
        val ? localStorage.setItem(key, JSON.stringify(val)) : localStorage.removeItem(key);

      writeOrClear(vacationStorageKey(y, m), data.vacations ?? null);
      writeOrClear(scheduleStorageKey(y, m), data.schedule  ?? null);
      writeOrClear(lockStorageKey(y, m),     data.locks     ?? null);

      // 切換年月選單
      const selYear  = document.getElementById('sel-year');
      const selMonth = document.getElementById('sel-month');
      if (selYear)  selYear.value  = y;
      if (selMonth) selMonth.value = m;

      // 重建狀態
      currentYear  = y;
      currentMonth = m;
      vacationMap  = loadVacations(y, m);
      lockMap      = loadLockMap(y, m);

      const stored = loadScheduleFromStorage(y, m);
      if (stored) {
        lastScheduleResult = stored;
        scheduleMap        = buildScheduleMap(stored.schedule);
      } else {
        lastScheduleResult = null;
        scheduleMap        = {};
      }

      updateCurrentLabel();
      buildTable();

      if (lastScheduleResult) {
        renderViolationsPanel(lastScheduleResult);
        updateSummaryLabel(lastScheduleResult.summary, lastScheduleResult.hardViolations.length > 0);
      } else {
        clearViolationsPanel();
        clearSummaryLabel();
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ─── 側邊欄說明 ──────────────────────────────────────────────────────────────

function buildSidebarHTML() {
  const arr = (s) => `<span class="sb-arrow">▶</span>${s}`;
  return `
  <div class="sidebar-inner">

    <details class="sb-block" open>
      <summary>${arr('📌 排班流程')}</summary>
      <div class="sb-content">
        <ol class="sb-steps">
          <li>選擇<b>年份</b>、<b>月份</b></li>
          <li>切「<b>休假</b>」模式，點格子標記休假</li>
          <li>按「<b>自動排班</b>」取得初稿</li>
          <li>查看下方「<b>排班警告</b>」面板</li>
          <li>切「<b>位置</b>」模式，手動調整格子<br>
            <span class="sb-hint">點格子循環切換 <span class="sb-c">櫃</span>→<span class="sb-p">藥</span>→<span class="sb-cat">貓</span>→空白</span></li>
          <li>切「<b>鎖定</b>」模式，鎖住滿意的部分<br>
            <span class="sb-hint">金色邊框 = 已鎖定</span></li>
          <li>再按「<b>自動排班</b>」，演算法只重排未鎖定部分</li>
          <li>反覆第 5–7 步直到警告可接受</li>
          <li>按「<b>驗證當前排班</b>」做最後確認</li>
        </ol>
      </div>
    </details>

    <details class="sb-block" open>
      <summary>${arr('📋 排班條件')}</summary>
      <div class="sb-content">

        <details class="sb-sub" open>
          <summary>${arr('每日人力（共 9 人）')}</summary>
          <ul>
            <li><span class="sb-c">二樓櫃台</span> 3 人</li>
            <li><span class="sb-p">二樓藥局</span> 2 人</li>
            <li><span class="sb-cat">四樓貓診</span> 4 人，至少 1 位有證照</li>
          </ul>
        </details>

        <details class="sb-sub" open>
          <summary>${arr('工時限制')}</summary>
          <ul>
            <li>每天 10 小時、每月最多 <b>170 小時（17 天班）</b></li>
            <li>最多連上 <b>3 天</b>，前後各休 <b>2 天</b></li>
            <li>人力不足時每月可一次連上 <b>4 天</b></li>
            <li>避免「上一天休一天」交替</li>
            <li>機動人員：限週末上班、人力算 <b>2 倍</b></li>
          </ul>
        </details>

        <details class="sb-sub" open>
          <summary>${arr('位置限制')}</summary>
          <ul>
            <li><b>俊傑</b>：不上四樓；週二週五在外單位（各 8 小時）</li>
            <li><b>怡庭、燕姐</b>：只能<span class="sb-c">櫃台</span></li>
            <li><b>莉婷</b>：不上<span class="sb-c">櫃台</span></li>
            <li><b>小加、小柚</b>：只能<span class="sb-cat">貓診</span></li>
            <li><b>機動</b>：不上<span class="sb-c">櫃台</span></li>
          </ul>
        </details>

        <details class="sb-sub" open>
          <summary>${arr('訓練配對')}</summary>
          <ul>
            <li><b>莉婷</b>上<span class="sb-p">藥局</span> → 需<b>雅卉</b>或<b>樂樂</b>同班</li>
            <li><b>小加</b>上<span class="sb-cat">貓診</span> → 需<b>仕賢／Erin／彤彤</b>至少一人</li>
            <li><b>小柚</b>上<span class="sb-cat">貓診</span> → 需<b>雅卉／樂樂／毛毛</b>至少一人</li>
          </ul>
        </details>

        <details class="sb-sub" open>
          <summary>${arr('管理職偏好（可妥協）')}</summary>
          <ul>
            <li><b>仕賢、彤彤</b>：<span class="sb-cat">貓診</span> ≥ 10 天／月（耗材管理）</li>
            <li><b>雅卉</b>：盡量排<span class="sb-cat">貓診</span>（四樓管理）</li>
            <li><b>樂樂、Erin、摩迪、維維</b>：<span class="sb-p">藥局</span>可多 1–2 天</li>
            <li><b>毛毛、瑜庭、伊森</b>：<span class="sb-c">櫃台</span>可多 1–2 天</li>
          </ul>
        </details>

      </div>
    </details>

    <details class="sb-block" open>
      <summary>${arr('👥 組員清單（17 人）')}</summary>
      <div class="sb-content">

        <details class="sb-sub" open>
          <summary>${arr('有證照（6 人）')}</summary>
          <p class="sb-names">俊傑、雅卉、樂樂、仕賢、Erin、毛毛</p>
        </details>

        <details class="sb-sub" open>
          <summary>${arr('無證照（10 人）')}</summary>
          <p class="sb-names">怡庭、燕姐、摩迪、瑜庭、彤彤、維維、伊森、莉婷、小加、小柚</p>
        </details>

        <details class="sb-sub" open>
          <summary>${arr('機動人員（1 人）')}</summary>
          <p class="sb-names">機動（限週末、人力 ×2）</p>
        </details>

      </div>
    </details>

  </div>`;
}

function buildSidebar() {
  const stored = localStorage.getItem('sidebar_open');
  const isOpen = stored !== 'false'; // 預設展開

  const toggle = document.createElement('button');
  toggle.id = 'sidebar-toggle';
  toggle.setAttribute('aria-label', '說明側邊欄');
  toggle.textContent = isOpen ? '✕ 關閉' : '📖 說明';
  document.body.appendChild(toggle);

  const panel = document.createElement('aside');
  panel.id = 'sidebar-panel';
  panel.innerHTML = buildSidebarHTML();
  document.body.appendChild(panel);

  if (isOpen) document.body.classList.add('sidebar-open');

  toggle.addEventListener('click', () => {
    const nowOpen = document.body.classList.toggle('sidebar-open');
    localStorage.setItem('sidebar_open', nowOpen);
    toggle.textContent = nowOpen ? '✕ 關閉' : '📖 說明';
  });
}

// ─── 初始化 ──────────────────────────────────────────────────────────────────

function init() {
  injectStyles();
  buildSidebar();

  const controls = document.getElementById('controls');
  const btnClear = document.getElementById('btn-clear');
  const curLabel = document.getElementById('current-label');

  // ── 分隔線 ──
  const divider = document.createElement('div');
  divider.className = 'divider';

  // ── 自動排班按鈕 ──
  const btnSchedule = document.createElement('button');
  btnSchedule.id = 'btn-schedule';
  btnSchedule.textContent = '自動排班';

  // ── 清除排班按鈕 ──
  const btnClearSched = document.createElement('button');
  btnClearSched.id = 'btn-clear-schedule';
  btnClearSched.textContent = '清除排班';

  // ── 驗證按鈕 ──
  const btnValidate = document.createElement('button');
  btnValidate.id = 'btn-validate';
  btnValidate.textContent = '驗證當前排班';

  // ── 編輯模式 ──
  const modeGroup = document.createElement('div');
  modeGroup.className = 'edit-mode-group';
  modeGroup.innerHTML = `
    <span>編輯模式：</span>
    <label><input type="radio" name="edit-mode" value="vacation" checked> 休假</label>
    <label><input type="radio" name="edit-mode" value="position"> 位置</label>
    <label><input type="radio" name="edit-mode" value="lock"> 鎖定</label>
  `;

  // ── 匯出/匯入按鈕 ──
  const divider2 = document.createElement('div');
  divider2.className = 'divider';

  const btnExportExcel = document.createElement('button');
  btnExportExcel.id = 'btn-export-excel';
  btnExportExcel.textContent = '📊 匯出班表';

  const btnExportJson = document.createElement('button');
  btnExportJson.id = 'btn-export-json';
  btnExportJson.textContent = '💾 匯出備份';

  const btnImportJson = document.createElement('button');
  btnImportJson.id = 'btn-import-json';
  btnImportJson.textContent = '📂 匯入備份';

  // ── 摘要 ──
  const summarySpan = document.createElement('span');
  summarySpan.id = 'schedule-summary';

  // 插入順序：清空休假 → | → 自動排班 → 清除排班 → 驗證當前排班 → 編輯模式 → | → 匯出班表 → 匯出備份 → 匯入備份 → summary → current-label
  controls.insertBefore(divider,        btnClear.nextSibling);
  controls.insertBefore(btnSchedule,    divider.nextSibling);
  controls.insertBefore(btnClearSched,  btnSchedule.nextSibling);
  controls.insertBefore(btnValidate,    btnClearSched.nextSibling);
  controls.insertBefore(modeGroup,      btnValidate.nextSibling);
  controls.insertBefore(divider2,       modeGroup.nextSibling);
  controls.insertBefore(btnExportExcel, divider2.nextSibling);
  controls.insertBefore(btnExportJson,  btnExportExcel.nextSibling);
  controls.insertBefore(btnImportJson,  btnExportJson.nextSibling);
  controls.insertBefore(summarySpan,    curLabel);

  // ── 建立進度條 Modal ──
  const modal = document.createElement('div');
  modal.id = 'schedule-modal';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-stage"   id="modal-stage">階段 1</div>
      <div class="modal-message" id="modal-message">準備中…</div>
      <div class="modal-bar-wrap">
        <div class="modal-bar-fill" id="modal-bar-fill" style="width:0%"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // ── 建立違規面板 ──
  const violPanel = document.createElement('details');
  violPanel.id = 'violations-panel';
  violPanel.style.display = 'none';
  violPanel.innerHTML = `<summary></summary><div class="viol-list"></div>`;
  document.getElementById('table-wrapper').insertAdjacentElement('afterend', violPanel);

  // ── 年月選單 ──
  const selYear  = document.getElementById('sel-year');
  const selMonth = document.getElementById('sel-month');

  const now = new Date();
  let defYear  = now.getFullYear();
  let defMonth = now.getMonth() + 2;
  if (defMonth > 12) { defMonth -= 12; defYear += 1; }

  for (let y = defYear - 2; y <= defYear + 2; y++) {
    selYear.appendChild(new Option(`${y} 年`, y, y === defYear, y === defYear));
  }
  for (let mo = 1; mo <= 12; mo++) {
    selMonth.appendChild(new Option(`${mo} 月`, mo, mo === defMonth, mo === defMonth));
  }

  // ── 事件綁定 ──
  selYear.addEventListener('change', onYearMonthChange);
  selMonth.addEventListener('change', onYearMonthChange);
  btnClear.addEventListener('click', onClearAll);
  btnSchedule.addEventListener('click', onAutoSchedule);
  btnClearSched.addEventListener('click', onClearSchedule);
  btnValidate.addEventListener('click', runValidation);
  btnExportExcel.addEventListener('click', onExportSchedule);
  btnExportJson.addEventListener('click',  onExportJSON);
  btnImportJson.addEventListener('click',  onImportJSON);

  modeGroup.querySelectorAll('input[name="edit-mode"]').forEach(radio => {
    radio.addEventListener('change', e => { editMode = e.target.value; });
  });

  // ── 初始載入 ──
  currentYear  = defYear;
  currentMonth = defMonth;
  vacationMap  = loadVacations(currentYear, currentMonth);
  lockMap      = loadLockMap(currentYear, currentMonth);

  const stored = loadScheduleFromStorage(currentYear, currentMonth);
  if (stored) {
    lastScheduleResult = stored;
    scheduleMap        = buildScheduleMap(stored.schedule);
  }

  updateCurrentLabel();
  buildTable();

  if (lastScheduleResult) {
    renderViolationsPanel(lastScheduleResult);
    updateSummaryLabel(lastScheduleResult.summary, lastScheduleResult.hardViolations.length > 0);
  }
}

init();