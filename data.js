/**
 * @file data.js — 獸醫院排班系統資料模型
 * @version 2.0.0（2026-07 人事異動改版）
 *
 * ════════════════════════════════════════════════════════════════
 *  硬規則 HARD RULES（不可違反）
 * ════════════════════════════════════════════════════════════════
 * [H1] 位置能力限制
 *   - 怡庭、燕姐：只能排 counter
 *   - 慈顯、新人A：只能排 catClinic
 *   - 俊傑：不排 catClinic（counter / pharmacy）
 *   - 其他人（含莉婷）：三個位置皆可
 * [H2] catClinic 每天至少 1 名 hasLicense:true 人員
 * [H3] 訓練配對（OR 條件：trainers 至少一人同班同位置）
 *   - 慈顯 @ catClinic → 需 雅卉／樂樂／毛毛 其中一人
 *   - 莉婷 @ pharmacy → 需 雅卉／樂樂 其中一人
 * [H4] 禁排星期：俊傑 週二(2)、週五(5) 跟診張醫師
 * [H9] 外單位職務：俊傑跟診時數（8h/天）計入 170h 月上限
 *   本系統可排天數 = floor((170 − 跟診月總時數) / 10)
 * [H5] 連班限制：最多連 3 天，前後至少各休 2 天，避免上一休一；
 *   人力不足時每月最多一次連 4 天
 * [H7] 每日人力：counter 3、pharmacy 2、catClinic 4（共 9 人）
 * [H8] 月工時：10h/天，170h/月（最多 17 天）
 *
 * ════════════════════════════════════════════════════════════════
 *  軟規則 SOFT RULES（盡量滿足）
 * ════════════════════════════════════════════════════════════════
 * [S1] 三個位置除特殊狀況外盡可能平均分配
 * [S2] Erin 避免與 雅卉、樂樂、摩迪 同一位置
 * [S3][S6] 雅卉管理四樓：除帶莉婷藥局外，需排 catClinic
 * [S5] 仕賢、彤彤 每月 catClinic 各至少 6 天（耗材管理）
 *
 * ⚠ 人力總量提醒：16 人（俊傑僅約 9-10 天）×17 天上限
 *   仍低於每月所需人次（9 人/天），部分日子會缺人，
 *   缺口會如實顯示於「每日人力」列與警告面板。
 */

/** @typedef {'counter' | 'pharmacy' | 'catClinic'} Position */

export const staff = [

  // ════════════════════════
  //  有證照（6 人）
  // ════════════════════════

  {
    name: "俊傑",
    role: "regular",
    positions: ["counter", "pharmacy"],   // [H1] 不排 catClinic
    hasLicense: true,
    needsTraining: null,
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: null,
    forbiddenWeekdays: [2, 5],            // [H4] 週二、週五跟診
    workableDays: "all",
    countsAs: 1,
    externalDuty: { weekdays: [2, 5], hoursPerDay: 8, label: "外" }, // [H9]
  },

  {
    name: "雅卉",
    role: "regular",
    positions: ["counter", "pharmacy", "catClinic"],
    hasLicense: true,
    needsTraining: null,
    trainerFor: ["慈顯", "莉婷"],          // [H3]
    avoidWith: ["Erin"],                  // [S2] 雙向記錄（規則在 Erin 側）
    preferredExtraDays: { position: "catClinic", extraDays: [1, 2] }, // [S6] 管理四樓
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "樂樂",
    role: "regular",
    positions: ["counter", "pharmacy", "catClinic"],
    hasLicense: true,
    needsTraining: null,
    trainerFor: ["慈顯", "莉婷"],          // [H3]
    avoidWith: ["Erin"],                  // [S2] 雙向記錄
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "仕賢",
    role: "regular",
    positions: ["counter", "pharmacy", "catClinic"],
    hasLicense: true,
    needsTraining: null,
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: { position: "catClinic", extraDays: [1, 2] }, // [S5] 耗材管理
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "Erin",
    role: "regular",
    positions: ["counter", "pharmacy", "catClinic"],
    hasLicense: true,
    needsTraining: null,
    trainerFor: [],
    avoidWith: ["雅卉", "樂樂", "摩迪"],   // [S2]
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "毛毛",
    role: "regular",
    positions: ["counter", "pharmacy", "catClinic"],
    hasLicense: true,
    needsTraining: null,
    trainerFor: ["慈顯"],                  // [H3]
    avoidWith: [],
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  // ════════════════════════
  //  無證照（10 人）
  // ════════════════════════

  {
    name: "怡庭",
    role: "regular",
    positions: ["counter"],               // [H1]
    hasLicense: false,
    needsTraining: null,
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "燕姐",
    role: "regular",
    positions: ["counter"],               // [H1]
    hasLicense: false,
    needsTraining: null,
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "摩迪",
    role: "regular",
    positions: ["counter", "pharmacy", "catClinic"],
    hasLicense: false,
    needsTraining: null,
    trainerFor: [],
    avoidWith: ["Erin"],                  // [S2] 雙向記錄
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "瑜庭",
    role: "regular",
    positions: ["counter", "pharmacy", "catClinic"],
    hasLicense: false,
    needsTraining: null,
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "彤彤",
    role: "regular",
    positions: ["counter", "pharmacy", "catClinic"],
    hasLicense: false,
    needsTraining: null,
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: { position: "catClinic", extraDays: [1, 2] }, // [S5] 耗材管理
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "維維",
    role: "regular",
    positions: ["counter", "pharmacy", "catClinic"],
    hasLicense: false,
    needsTraining: null,
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "伊森",
    role: "regular",
    positions: ["counter", "pharmacy", "catClinic"],
    hasLicense: false,
    needsTraining: null,
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "莉婷",
    role: "regular",
    positions: ["counter", "pharmacy", "catClinic"], // 2.0：可排櫃台
    hasLicense: false,
    // [H3] 排 pharmacy 需 雅卉 或 樂樂 同班；counter / catClinic 無限制
    needsTraining: [
      { position: "pharmacy", trainers: ["雅卉", "樂樂"] },
    ],
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "慈顯",
    role: "regular",
    positions: ["catClinic"],             // [H1] 只能排貓診
    hasLicense: false,
    // [H3] 排 catClinic 需 雅卉、樂樂 或 毛毛 同班
    needsTraining: [
      { position: "catClinic", trainers: ["雅卉", "樂樂", "毛毛"] },
    ],
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "新人A",
    role: "regular",
    positions: ["catClinic"],             // [H1] 固定四樓
    hasLicense: false,
    needsTraining: null,                  // 如需訓練配對請告知
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },
];

// ─────────────────────────────────────────────
//  位置每日人力需求 [H7]
// ─────────────────────────────────────────────

export const positionRequirements = {
  counter: {
    label: "二樓櫃台",
    dailyStaff: 3,
    licenseRequired: false,
  },
  pharmacy: {
    label: "二樓藥局",
    dailyStaff: 2,
    licenseRequired: false,
  },
  catClinic: {
    label: "四樓貓診",
    dailyStaff: 4,
    licenseRequired: true,                // [H2]
  },
};

// ─────────────────────────────────────────────
//  工時設定 [H8]
// ─────────────────────────────────────────────

export const workHoursConfig = {
  hoursPerDay: 10,
  monthlyHoursLimit: {
    regular: 170,       // 最多 17 天班
    flex: Infinity,     // 目前無機動人員，保留欄位供未來使用
  },
};

// ─────────────────────────────────────────────
//  月度特殊規則
// ─────────────────────────────────────────────

export const monthlyConstraints = {

  // 2.0：小加、小柚離職，重疊錯開限制取消（null = 停用，保留欄位供未來使用）
  xiaojiaXiaoyouOverlap: null,

  // [S5] 仕賢 & 彤彤 各自每月 catClinic 至少 6 天（2.0：由 10 天下修）
  catClinicManagement: {
    staff: ["仕賢", "彤彤"],
    position: "catClinic",
    minDaysEach: 6,
  },

  // [H5] 連班規則
  consecutive: {
    maxDays: 3,
    exceptionalMaxDays: 4,  // 每月最多一次例外
    minRestAfter: 2,
  },

  // 2.0：怡庭 & 燕姐錯開偏好已取消
  softAvoidPairs: [],
};
