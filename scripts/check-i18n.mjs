import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

// 逃生开关：紧急情况下用 OPENLIST_SKIP_I18N_CHECK=1 跳过（CI / 提交前不建议）
if (process.env.OPENLIST_SKIP_I18N_CHECK === "1") {
  console.log("i18n 校验已通过 OPENLIST_SKIP_I18N_CHECK=1 跳过")
  process.exit(0)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const langRoot = path.join(root, "src/lang")
const enRoot = path.join(langRoot, "en")
const zhRoot = path.join(langRoot, "zh-CN")
// CI 只 checkout 前端时可用 OPENLIST_BACKEND 指向后端；找不到则跳过后端字段检查
const backendRoot = process.env.OPENLIST_BACKEND
  ? path.resolve(process.env.OPENLIST_BACKEND)
  : path.resolve(root, "..", "OpenList")
// settings 历史欠账基线：基线内的缺失只提示，基线外的新增一律硬失败
const baselinePath = path.join(here, "i18n-known-missing.json")
const updateBaseline = process.argv.includes("--update-baseline")
const isCI = Boolean(process.env.CI)

const errors = []
const warnings = []
const hasCJK = /[\u4e00-\u9fff]/
const cjkNote = "（品牌名、协议名、缩写、URL 不在此列）"

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"))

function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, key, out)
    } else {
      out.set(key, v)
    }
  }
  return out
}

// 递归收集后端 Go 源文件的最新修改时间。生成器产物过期时，
// 光比对产物内容会漏掉「后端加了字段但没跑 lang 命令」这种情况。
function newestGoMtime(dir) {
  if (!fs.existsSync(dir)) return 0
  let newest = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestGoMtime(full))
    } else if (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs)
    }
  }
  return newest
}

// 1) en 与 zh-CN 的键集合必须完全一致
const files = fs
  .readdirSync(enRoot)
  .filter((f) => f.endsWith(".json"))
  .sort()
let totalKeys = 0

for (const file of files) {
  const enPath = path.join(enRoot, file)
  const zhPath = path.join(zhRoot, file)
  if (!fs.existsSync(zhPath)) {
    errors.push(`[${file}] zh-CN 缺少整个文件`)
    continue
  }
  const en = flatten(readJson(enPath))
  const zh = flatten(readJson(zhPath))
  totalKeys += en.size

  const missing = [...en.keys()].filter((k) => !zh.has(k))
  const extra = [...zh.keys()].filter((k) => !en.has(k))
  for (const k of missing) errors.push(`[${file}] zh-CN 缺键: ${k}`)
  for (const k of extra) errors.push(`[${file}] en 缺键: ${k}（zh-CN 独有）`)

  // 2) zh-CN 里不应残留可读英文句子（复制英文占位忘了翻）
  for (const [k, v] of zh) {
    if (typeof v !== "string" || hasCJK.test(v) || v.startsWith("http")) continue
    const words = v.match(/[A-Za-z][A-Za-z-]*/g) || []
    if (words.length >= 5) {
      errors.push(`[${file}] zh-CN 仍是英文句子: ${k} = "${v.slice(0, 80)}"`)
    }
  }
}

// 3) 与后端生成器产物对比。以 `go run . lang` 的输出为事实源，
//    不静态解析 Go 源码（驱动名与历史键名并不总是一致，容易误报）
let generatedKeys = 0
const genDrivers = path.join(backendRoot, "lang", "drivers.json")
const genSettings = path.join(backendRoot, "lang", "settings.json")
const hasGenerated = fs.existsSync(genDrivers)

if (!hasGenerated) {
  warnings.push(
    `未找到 ${genDrivers}，跳过后端字段检查；先跑 cd ../OpenList && GOTOOLCHAIN=local go run . lang --frontend-path ../OpenList-Frontend`,
  )
} else {
  const gen = flatten(readJson(genDrivers))
  const cur = flatten(readJson(path.join(enRoot, "drivers.json")))
  generatedKeys = gen.size
  for (const k of [...gen.keys()].filter((k) => !cur.has(k))) {
    errors.push(`[drivers.json] 后端已有字段未同步进 en 字典: ${k}`)
  }
}

// 3b) 产物是否过期：后端 Go 源码比 lang/*.json 新 = 忘记重跑生成器。
//     CI 里 checkout 后 mtime 不可靠，且应由 workflow 现场生成，故跳过。
if (hasGenerated && !isCI) {
  const goDirs = [
    path.join(backendRoot, "drivers"),
    path.join(backendRoot, "internal", "bootstrap", "data"),
  ]
  let sourceMtime = 0
  let touchedFile = ""
  for (const dir of goDirs) {
    const t = newestGoMtime(dir)
    if (t > sourceMtime) {
      sourceMtime = t
      touchedFile = dir
    }
  }
  const outMtime = Math.min(
    fs.statSync(genDrivers).mtimeMs,
    fs.existsSync(genSettings) ? fs.statSync(genSettings).mtimeMs : Infinity,
  )
  if (sourceMtime > outMtime) {
    errors.push(
      `后端 Go 源码（${path.relative(backendRoot, touchedFile)}）比 lang/*.json 新，生成器产物已过期，请先重跑：\n` +
        `      cd ../OpenList && GOTOOLCHAIN=local go run . lang --frontend-path ../OpenList-Frontend`,
    )
  }
}

// 4) settings：历史欠账写入基线只提示，任何「基线之外的新增项」都硬失败。
//    这样不用先补完 153 条旧账，也能保证今后新增设置项不会漏翻。
if (fs.existsSync(genSettings)) {
  const gen = flatten(readJson(genSettings))
  const cur = flatten(readJson(path.join(enRoot, "settings.json")))
  const missing = [...gen.keys()].filter((k) => !cur.has(k)).sort()

  if (updateBaseline) {
    fs.writeFileSync(baselinePath, JSON.stringify(missing, null, 2) + "\n", "utf8")
    console.log(`已写入基线：${path.relative(root, baselinePath)}（${missing.length} 项历史欠账）`)
  }

  const baseline = new Set(
    fs.existsSync(baselinePath) ? readJson(baselinePath) : [],
  )
  const fresh = missing.filter((k) => !baseline.has(k))
  const known = missing.filter((k) => baseline.has(k))
  const resolved = [...baseline].filter((k) => !missing.includes(k))

  for (const k of fresh) {
    errors.push(`[settings.json] 后端新增设置项未进字典: ${k}`)
  }
  if (known.length) {
    warnings.push(
      `[settings.json] ${known.length} 项历史欠账仍缺（基线内，不阻断）；补完后跑 pnpm i18n:baseline 清理基线`,
    )
  }
  if (resolved.length) {
    warnings.push(
      `[settings.json] 基线中 ${resolved.length} 项已补齐，可跑 pnpm i18n:baseline 清理`,
    )
  }
}

for (const w of warnings) console.log(`! ${w}`)

if (errors.length) {
  console.error(`\ni18n 校验失败，共 ${errors.length} 项：${cjkNote}`)
  for (const e of errors.slice(0, 60)) console.error(`  - ${e}`)
  if (errors.length > 60) console.error(`  ... 还有 ${errors.length - 60} 项`)
  console.error(
    "\n修复 SOP：\n" +
      "  1) cd ../OpenList && GOTOOLCHAIN=local go run . lang --frontend-path ../OpenList-Frontend\n" +
      "  2) git diff --no-index ../OpenList/lang/drivers.json src/lang/en/drivers.json   # 只看新键\n" +
      "  3) 把新键按字母序补进 src/lang/en/*.json，并逐条补翻 src/lang/zh-CN/*.json\n" +
      "     （不要整文件 cp：Go 输出会重排 JSON，且部分 help 本身是中文会污染 en）\n" +
      "  4) pnpm check:i18n",
  )
  process.exit(1)
}

console.log(
  `i18n 校验通过：${files.length} 个语言文件 / ${totalKeys} 条键 / ${generatedKeys} 条后端驱动字段已覆盖`,
)
