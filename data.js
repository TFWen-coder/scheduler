/**
 * @file data.js — 獸醫院排班系統資料模型
 * @version 1.0.0
 *
 * 本檔案僅定義資料結構與規則，不含 UI 或排班演算法。
 * 所有規則均可追溯至中文原始需求說明。
 *
 * ════════════════════════════════════════════════════════════
 *  硬規則 HARD RULES（不可違反）
 * ════════════════════════════════════════════════════════════
 *
 * [H1] 位置能力限制
 *   每位人員只能被排到其 positions 陣列所列的位置。
 *   - 怡庭、燕姐：只能排 counter
 *   - 小加、小柚：只能排 catClinic
 *   - 莉婷：可排 pharmacy 或 catClinic（不排 counter）
 *   - 俊傑：可排 counter 或 pharmacy（不排 catClinic）
 *   - 機動：可排 pharmacy 或 catClinic（不排 counter）
 *
 * [H2] 貓診證照需求
 *   catClinic 每天至少需有 1 名 hasLicense:true 的人員。
 *   若當天機動人員排在 catClinic，視為自動滿足（機動有證照，countsAs:2）。
 *
 * [H3] 訓練配對（被訓練者排到指定位置時，需有訓練者同班）
 *   條件為 OR：trainers 中至少有一人同班於指定位置即可。
 *   - 莉婷 @ pharmacy  → 需有 雅卉 或 樂樂 同班於 pharmacy
 *   - 小加 @ catClinic → 需有 仕賢、Erin 或 彤彤 同班於 catClinic
 *   - 小柚 @ catClinic → 需有 雅卉、樂樂 或 毛毛 同班於 catClinic
 *
 * [H4] 禁排星期（forbiddenWeekdays）
 *   - 俊傑：週二（2）、週五（5）不可排班（因外單位職務，詳見 [H9]）
 *
 * [H9] 外單位職務（externalDuty）
 *   有外單位職務的人員，其工時計算需扣除外單位時數。
 *   本系統可排上班天數上限 = floor((170 - 外單位月總時數) / 10)。
 *   - 俊傑：週二、週五各 8 小時，實際上限依當月週二、週五天數計算。
 *     例：2026/6 有 5 個週二 + 4 個週五 = 9 天 × 8h = 72h
 *         可用時數 = 170 - 72 = 98h，本系統可排上限 = floor(98/10) = 9 天。
 *
 * [H5] 連班天數限制（僅適用 role:"regular"）
 *   一般：最多連 3 天，前後至少各休 2 天，避免「上一天休一天」交替模式。
 *   例外：人力不足時，每月最多允許一次連 4 天班。
 *   「人力不足」定義：當天 counter+pharmacy+catClinic 三個位置無法同時湊足 9 人（A5 確認）。
 *
 * [H6] 機動人員限週末（role:"flex"）
 *   只能排週六（6）或週日（0），其餘均為禁排日。
 *
 * [H7] 每日人力需求
 *   counter   : 每天恰好 3 人
 *   pharmacy  : 每天恰好 2 人力（機動 countsAs:2 可獨自填滿）
 *   catClinic : 每天恰好 4 人力（機動 countsAs:2 貢獻 2 人力）
 *
 * [H8] 月總工時限制
 *   常規人員：10 小時／天，上限 170 小時／月（最多 17 天班）。
 *   機動人員：無月工時上限。
 *
 * ════════════════════════════════════════════════════════════
 *  軟規則 SOFT RULES（盡量滿足，人力不足時可妥協）
 * ════════════════════════════════════════════════════════════
 *
 * [S1] 位置平均分配
 *   可排多個位置的人員，排班應盡可能均等分散到各可排位置，
 *   再依 preferredExtraDays 給予管理職人員在特定位置額外 1-2 天。
 *
 * [S2] avoidWith 迴避配對
 *   字串型別：所有位置皆需迴避同日同班。
 *   { person, position } 物件型別：僅在該位置迴避。
 *   本檔案採「雙向記錄」以簡化演算法查詢，來源規則見各人員注解。
 *   怡庭 & 燕姐：兩人均只能排 counter，avoidWith 實務意義為「儘量錯開上班日」。
 *
 * [S3] 管理職偏好位置（preferredExtraDays）
 *   catClinic +1-2 天：雅卉（四樓管理）、仕賢（耗材）、彤彤（耗材）
 *   pharmacy  +1-2 天：樂樂、Erin、摩迪、維維（藥品管理）
 *   counter   +1-2 天：毛毛、瑜庭、伊森（二樓百貨管理）
 *
 * [S4] 小加 & 小柚 月重疊天數上限
 *   兩人同日均排班（同在 catClinic）的天數，每月上限 3 天（0-3 天皆可接受，A1 確認）。
 *
 * [S5] 仕賢 & 彤彤 catClinic 各自天數下限
 *   仕賢、彤彤各自每月在 catClinic 排班至少 10 天（各自獨立計算，可同天，A4 確認）。
 *
 * [S6] 雅卉四樓管理偏好
 *   雅卉預設排 catClinic；以下情況可例外排其他位置（例外 A 優先於 B，A3 確認）：
 *   例外 A（優先）：需帶莉婷在 pharmacy 且當日無其他合資格訓練者（樂樂）可用。
 *   例外 B：當日 catClinic 已排有 小加 或 Erin（avoidWith 衝突）。
 *
 * ════════════════════════════════════════════════════════════
 *  機動人員人力計算說明
 * ════════════════════════════════════════════════════════════
 *
 * countsAs:2 僅適用於 pharmacy 與 catClinic（機動不可排 counter）：
 *   機動 @ pharmacy  → 當日 pharmacy 剩餘需求 = 2 − 2 = 0，無需再排他人。
 *   機動 @ catClinic → 當日 catClinic 剩餘需求 = 4 − 2 = 2，
 *                      且 [H2] 「至少 1 人有證照」條件自動滿足。
 */

// ─────────────────────────────────────────────
//  TypeDefs
// ─────────────────────────────────────────────

/** @typedef {'counter' | 'pharmacy' | 'catClinic'} Position */

/**
 * 迴避配對（限特定位置版本）
 * @typedef {Object} AvoidEntry
 * @property {string}   person   - 要迴避的人員姓名
 * @property {Position} position - 僅在此位置同班時需迴避
 */

/**
 * 訓練需求描述（被訓練者使用）。
 * 條件為 OR：trainers 中至少有一人同班於 position 即可。
 * @typedef {Object} TrainingRequirement
 * @property {Position}  position - 訓練發生的位置（被訓練者排在此位置時觸發 [H3]）
 * @property {string[]}  trainers - 可擔任訓練者的人員姓名陣列（至少一人即可）
 */

/**
 * 外單位職務設定（影響月工時計算）
 * @typedef {Object} ExternalDuty
 * @property {number[]} weekdays    - 外單位上班的星期（0=日, 1=一, …, 6=六）[H9]
 * @property {number}   hoursPerDay - 外單位每天工時（小時）
 * @property {string}   label       - 格子顯示文字（如「外」）
 */

/**
 * 偏好多排的位置與天數範圍（管理職使用）
 * @typedef {Object} PreferredExtraDays
 * @property {Position}         position  - 偏好多排的位置
 * @property {[number, number]} extraDays - 比全體平均多的天數範圍，如 [1, 2]
 */

/**
 * 人員資料結構
 * @typedef {Object} StaffMember
 * @property {string}                       name               - 姓名
 * @property {'regular' | 'flex'}           role               - 常規／機動
 * @property {Position[]}                   positions          - 可排位置清單 [H1]
 * @property {boolean}                      hasLicense         - 是否持有執照 [H2]
 * @property {TrainingRequirement[] | null} needsTraining      - 訓練需求；null 表示不需訓練 [H3]
 * @property {string[]}                     trainerFor         - 此人擔任哪些人的訓練者（姓名陣列）[H3]
 * @property {(string | AvoidEntry)[]}      avoidWith          - 迴避同班配對；字串=所有位置，物件=限特定位置 [S2]
 * @property {PreferredExtraDays | null}    preferredExtraDays - 管理職偏好多排的位置與天數；null 表示無偏好 [S3]
 * @property {number[]}                     forbiddenWeekdays  - 不可上班的星期（0=日, 1=一, …, 6=六）[H4][H6]
 * @property {'all' | 'weekendOnly'}        workableDays       - 可上班日範圍 [H6]
 * @property {number}                       countsAs           - 人力計算係數；預設 1，機動在 pharmacy/catClinic 時為 2 [H7]
 * @property {ExternalDuty | null}          externalDuty       - 外單位職務；null 表示無外部職務 [H9]
 */

// ─────────────────────────────────────────────
//  人員資料（16 位常規 + 1 位機動）
// ─────────────────────────────────────────────

/** @type {StaffMember[]} */
export const staff = [

  // ════════════════════════
  //  有證照常規人員（6 人）
  // ════════════════════════

  {
    name: "俊傑",
    role: "regular",
    positions: ["counter", "pharmacy"], // [H1] 不排 catClinic
    hasLicense: true,
    needsTraining: null,
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: null,
    forbiddenWeekdays: [2, 5],          // [H4] 週二、週五不可排班（同為外單位出勤日）
    workableDays: "all",
    countsAs: 1,
    // [H9] 週二、週五各 8 小時在外單位上班；時數計入 170 小時總上限，但本系統不排班
    externalDuty: {
      weekdays: [2, 5],
      hoursPerDay: 8,
      label: "外",
    },
  },

  {
    name: "雅卉",
    role: "regular",
    positions: ["counter", "pharmacy", "catClinic"],
    hasLicense: true,
    needsTraining: null,
    trainerFor: ["小柚", "莉婷"],
    // [S2] 雙向記錄：
    //   小加.avoidWith 含 雅卉（原始規則在小加側）；小加只能在 catClinic，故限定 catClinic
    //   Erin.avoidWith 含 雅卉（原始規則在 Erin 側）；Erin 迴避所有位置
    avoidWith: [
      { person: "小加", position: "catClinic" },
      "Erin",
    ],
    // [S3][S6] 管理四樓，優先排 catClinic（例外條件見軟規則 S6）
    preferredExtraDays: { position: "catClinic", extraDays: [1, 2] },
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
    trainerFor: ["小柚", "莉婷"],
    // [S2] 雙向記錄：Erin.avoidWith 含 樂樂（原始規則在 Erin 側）
    avoidWith: ["Erin"],
    // [S3] 藥品管理，pharmacy 可比平均多 1-2 天
    preferredExtraDays: { position: "pharmacy", extraDays: [1, 2] },
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
    trainerFor: ["小加"],
    avoidWith: [],
    // [S3][S5] 四樓百貨耗材管理，catClinic 可比平均多 1-2 天（各自 ≥10 天，A4 確認）
    preferredExtraDays: { position: "catClinic", extraDays: [1, 2] },
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
    trainerFor: ["小加"],
    // [S2] 避免與 雅卉、樂樂、瑜庭 同位置（所有位置皆迴避）
    avoidWith: ["雅卉", "樂樂", "瑜庭"],
    // [S3] 藥品管理，pharmacy 可比平均多 1-2 天
    preferredExtraDays: { position: "pharmacy", extraDays: [1, 2] },
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
    trainerFor: ["小柚"],
    avoidWith: [],
    // [S3] 二樓百貨管理，counter 可比平均多 1-2 天
    preferredExtraDays: { position: "counter", extraDays: [1, 2] },
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  // ════════════════════════
  //  無證照常規人員（10 人）
  // ════════════════════════

  {
    name: "怡庭",
    role: "regular",
    positions: ["counter"],             // [H1] 只能排 counter
    hasLicense: false,
    needsTraining: null,
    trainerFor: [],
    // [S2] 與燕姐不合；錯開偏好已移至 monthlyConstraints.softAvoidPairs（A2 確認）
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
    positions: ["counter"],             // [H1] 只能排 counter
    hasLicense: false,
    needsTraining: null,
    trainerFor: [],
    // [S2] 與怡庭不合；錯開偏好已移至 monthlyConstraints.softAvoidPairs（A2 確認）
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
    // [S2] 雙向記錄：小加.avoidWith 含 摩迪（原始規則在小加側）；小加只能在 catClinic
    avoidWith: [{ person: "小加", position: "catClinic" }],
    // [S3] 藥品管理，pharmacy 可比平均多 1-2 天
    preferredExtraDays: { position: "pharmacy", extraDays: [1, 2] },
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
    // [S2] 避免與 Erin 同位置（所有位置）；避免與伊森同排 pharmacy（偷懶問題）
    avoidWith: ["Erin", { person: "伊森", position: "pharmacy" }],
    // [S3] 二樓百貨管理，counter 可比平均多 1-2 天
    preferredExtraDays: { position: "counter", extraDays: [1, 2] },
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
    trainerFor: ["小加"],
    avoidWith: [],
    // [S3][S5] 四樓百貨耗材管理，catClinic 可比平均多 1-2 天（各自 ≥10 天，A4 確認）
    preferredExtraDays: { position: "catClinic", extraDays: [1, 2] },
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
    // [S3] 藥品管理，pharmacy 可比平均多 1-2 天
    preferredExtraDays: { position: "pharmacy", extraDays: [1, 2] },
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
    // [S2] 避免與瑜庭同排 pharmacy（伊森偷懶問題）；雙向與瑜庭.avoidWith 一致
    avoidWith: [{ person: "瑜庭", position: "pharmacy" }],
    // [S3] 二樓百貨管理，counter 可比平均多 1-2 天
    preferredExtraDays: { position: "counter", extraDays: [1, 2] },
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "莉婷",
    role: "regular",
    positions: ["pharmacy", "catClinic"], // [H1] 不排 counter
    hasLicense: false,
    // [H3] 排 pharmacy 時需與 雅卉 或 樂樂 同班（OR 條件）；catClinic 無訓練配對要求
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
    name: "小加",
    role: "regular",
    positions: ["catClinic"],           // [H1] 只能排 catClinic
    hasLicense: false,
    // [H3] 排 catClinic 時需與 仕賢、Erin 或 彤彤 同班（OR 條件）
    needsTraining: [
      { position: "catClinic", trainers: ["仕賢", "Erin", "彤彤"] },
    ],
    trainerFor: [],
    // [S2] 避免與 雅卉、摩迪 同位置（小加只能在 catClinic，迴避隱含為 catClinic）
    avoidWith: ["雅卉", "摩迪"],
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "all",
    countsAs: 1,
    externalDuty: null,
  },

  {
    name: "小柚",
    role: "regular",
    positions: ["catClinic"],           // [H1] 只能排 catClinic
    hasLicense: false,
    // [H3] 排 catClinic 時需與 雅卉、樂樂 或 毛毛 同班（OR 條件）
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

  // ════════════════════════
  //  機動人員（1 人）
  // ════════════════════════

  {
    name: "機動",
    role: "flex",
    // [H1][H6] 不排 counter；僅限週末上班
    positions: ["pharmacy", "catClinic"],
    hasLicense: true,
    needsTraining: null,
    trainerFor: [],
    avoidWith: [],
    preferredExtraDays: null,
    forbiddenWeekdays: [],
    workableDays: "weekendOnly",        // [H6] 只能排週六（6）或週日（0）
    countsAs: 2,                        // [H7] pharmacy/catClinic 人力計算視為 2
    externalDuty: null,
  },
];

// ─────────────────────────────────────────────
//  位置每日人力需求
// ─────────────────────────────────────────────

/**
 * @typedef {Object} PositionRequirement
 * @property {string}  label           - 位置中文名稱
 * @property {number}  dailyStaff      - 每天所需人力數（機動 countsAs:2 時折算）[H7]
 * @property {boolean} licenseRequired - 是否需至少 1 名有證照人員 [H2]
 */

/** @type {Record<Position, PositionRequirement>} */
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
    licenseRequired: true,              // [H2]
  },
};

// ─────────────────────────────────────────────
//  工時設定
// ─────────────────────────────────────────────

/**
 * @typedef {Object} WorkHoursConfig
 * @property {number} hoursPerDay                                   - 每天工時（小時）
 * @property {{ regular: number, flex: number }} monthlyHoursLimit  - 月工時上限 [H8]
 */

/** @type {WorkHoursConfig} */
export const workHoursConfig = {
  hoursPerDay: 10,
  monthlyHoursLimit: {
    regular: 170,       // 最多 17 天班 [H8]
    flex: Infinity,     // 機動無月工時上限 [H8]
  },
};

// ─────────────────────────────────────────────
//  月度特殊規則（需跨日累積追蹤）
// ─────────────────────────────────────────────

/**
 * @typedef {Object} OverlapConstraint
 * @property {string[]} staff       - 受約束的兩人姓名
 * @property {number}   minDays     - 每月同日上班天數下限（含）
 * @property {number}   maxDays     - 每月同日上班天數上限（含）
 */

/**
 * @typedef {Object} PositionMinDaysConstraint
 * @property {string[]}  staff        - 受約束的人員姓名
 * @property {Position}  position     - 計算的位置
 * @property {number}    minDaysEach  - 每人在該位置各自排班天數的下限（獨立計算，可同天）[S5]
 */

/**
 * @typedef {Object} ConsecutiveConstraint
 * @property {number} maxDays            - 一般最大連班天數 [H5]
 * @property {number} exceptionalMaxDays - 例外最大連班天數（每月限一次）[H5]
 * @property {number} minRestAfter       - 連班後最少休息天數 [H5]
 */

/**
 * 軟性迴避配對（avoidWith 難以完全滿足的情況，改用此欄位追蹤）
 * @typedef {Object} SoftAvoidPair
 * @property {[string, string]} pair   - 要儘量錯開的兩人姓名
 * @property {string}           reason - 迴避原因說明
 */

/**
 * @typedef {Object} MonthlyConstraints
 * @property {OverlapConstraint}         xiaojiaXiaoyouOverlap   - 小加&小柚每月重疊天數上限 [S4]
 * @property {PositionMinDaysConstraint} catClinicManagement     - 仕賢&彤彤 catClinic 各自天數下限 [S5]
 * @property {ConsecutiveConstraint}     consecutive             - 連班規則 [H5]
 * @property {SoftAvoidPair[]}           softAvoidPairs          - 無法用 avoidWith 表達的軟性錯開配對 [S2]
 */

/** @type {MonthlyConstraints} */
export const monthlyConstraints = {

  // [S4] 小加 & 小柚 每月同日均排班（同在 catClinic）天數上限
  //   上限 3 天，可以是 0-3 天（A1 確認：不強制最少重疊天數）
  xiaojiaXiaoyouOverlap: {
    staff: ["小加", "小柚"],
    minDays: 0,
    maxDays: 3,
  },

  // [S5] 仕賢 & 彤彤 各自在 catClinic 排班天數下限
  //   各自獨立計算，每人至少 10 天；可同天上班，同天各自計入（A4 確認）
  catClinicManagement: {
    staff: ["仕賢", "彤彤"],
    position: "catClinic",
    minDaysEach: 10,
  },

  // [H5] 連班天數規則（僅適用 role:"regular"）
  consecutive: {
    maxDays: 3,
    exceptionalMaxDays: 4,  // 每月最多一次例外
    minRestAfter: 2,        // 連班前後至少各休 2 天
  },

  // [S2] 怡庭 & 燕姐：兩人都只能排 counter，無法用 avoidWith 的「同位置」語意表達，
  //   因此改以此欄位記錄「儘量錯開上班日」的軟性偏好（A2 確認：同天 OK，儘量不重疊）
  softAvoidPairs: [
    { pair: ["怡庭", "燕姐"], reason: "個性不合，儘量錯開上班日" },
  ],
};

// ═══════════════════════════════════════════════════════════════
//  附錄：規則決策紀錄（Q&A）
//  供後續維護時追溯原始問題與決策依據。
// ═══════════════════════════════════════════════════════════════
//
//  Q1: 小加 & 小柚每月「最多重疊 2-3 天」的解讀：
//      上限是 3 天（可接受 0-3 天），還是必須落在 2-3 天之間（強制最少重疊 2 天）？
//  A1: 上限 3 天。理想為 0 重疊，不強制最少天數。
//      → monthlyConstraints.xiaojiaXiaoyouOverlap = { minDays: 0, maxDays: 3 }
//
//  Q2: 怡庭 & 燕姐「儘量錯開排班」的解讀：
//      兩人都只能排 counter，「錯開」是指完全不同天，還是儘量不重疊即可？
//  A2: 同天上班 OK，儘量讓上班日不完全重疊即可。
//      → 改以 monthlyConstraints.softAvoidPairs 記錄，avoidWith 清空。
//
//  Q3: 雅卉管理四樓的兩個例外同時成立時（需帶莉婷藥局 + catClinic 有小加或 Erin），
//      優先執行哪一個例外？
//  A3: 例外 A 優先——雅卉去 pharmacy 帶莉婷。
//      → [S6] 說明已更新：「例外 A（優先）」。
//
//  Q4: 仕賢 + 彤彤每月 catClinic ≥ 10 天：
//      是兩人各自天數相加合計 ≥ 10，還是各自獨立都要 ≥ 10 天？
//  A4: 各自獨立計算，每人至少 10 天（可同天上班，同天各自計入）。
//      → monthlyConstraints.catClinicManagement = { minDaysEach: 10 }
//
//  Q5: 連班規則中「人力不足」的判斷標準為何？
//  A5: 當天 counter + pharmacy + catClinic 三個位置合計無法湊足 9 人時，
//      視為人力不足，允許當月唯一一次連上 4 天班的例外。
//      → [H5] 說明已補充此定義。
//
//  Q6: 俊傑週二週五不可排是因為休息日嗎？
//  A6: 不是。俊傑週二、週五在外單位上班（各 8 小時），
//      不參與本系統排班，但時數仍計入 170 小時月總工時上限。
//      因此本系統可排天數需動態計算：
//        floor((170 - 外單位月總時數) / 10)
//      → 新增 externalDuty 欄位處理；forbiddenWeekdays:[2,5] 同步保留確保不被排入。