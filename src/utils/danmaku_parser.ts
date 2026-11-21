/**
 * 外挂 XML 弹幕解析器。
 *
 * 背景：
 * - artplayer-plugin-danmuku 内置的 XML 解析用正则 `<d[^>]*?p="...">`，
 *   属性边界不严格，会把 danmuji（弹幕哆啦）录制的抖音 XML 里
 *   `<douyin_pk ... timestamp="1794758553163" ...>` 中 timestamp 的 `p`
 *   误当成弹幕的 p 属性，然后跨标签吞掉后面真正的 `<d>` 弹幕，造成弹幕丢失。
 * - 这里自己解析，严格只匹配 `<d>` 标签且 p 必须是独立属性，
 *   从源头过滤掉 <douyin_pk>/<gift>/<sc> 等所有非弹幕事件节点。
 *
 * 支持两种常见格式：
 * - B 站格式：<d p="秒,模式,字号,颜色,时间戳,池,uid,rowid">文本</d>
 * - danmuji 格式：<d p="秒,模式,字号,颜色,时间戳,池,uid,uid,0" user=".." uid=".." timestamp="..">文本</d>
 *   两者前 4 段语义一致，直接兼容。
 */

export interface DanmuItem {
  text: string
  /** 出现时间，单位秒 */
  time: number
  /** 0: 滚动 1: 顶部 2: 底部 */
  mode: 0 | 1 | 2
  /** #rrggbb */
  color: string
}

const ENTITY_MAP: Record<string, string> = {
  "&quot;": '"',
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, ENTITY_MAP["&quot;"])
    .replace(/&apos;/g, ENTITY_MAP["&apos;"])
    .replace(/&lt;/g, ENTITY_MAP["&lt;"])
    .replace(/&gt;/g, ENTITY_MAP["&gt;"])
    .replace(/&amp;/g, ENTITY_MAP["&amp;"])
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
}

/** danmuji / B 站 mode 值统一到插件的 0/1/2 */
function normalizeMode(raw: number): 0 | 1 | 2 {
  // B 站: 1=滚动 2=顶部 3=底部 4/5=特殊(按滚动处理)
  // danmuji: 1=滚动 5=顶部 6=底部（取常见映射）
  if (raw === 1) return 0
  if (raw === 2 || raw === 5) return 1
  if (raw === 3 || raw === 6) return 2
  if (raw === 0) return 0
  return 0
}

function normalizeColor(raw: number | string): string {
  if (typeof raw === "string") {
    if (raw.startsWith("#")) return raw
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return "#ffffff"
    return `#${(n >>> 0).toString(16).padStart(6, "0").slice(-6)}`
  }
  if (!Number.isFinite(raw)) return "#ffffff"
  return `#${(raw >>> 0).toString(16).padStart(6, "0").slice(-6)}`
}

/**
 * 解析 XML 文本为弹幕数组。
 * - 只匹配 <d ...>...</d>，且 p 必须是带单词边界的独立属性（不会误匹配 timestamp）。
 * - 忽略 <douyin_pk>/<gift>/<sc>/<guard>/<pk> 等所有节点。
 * - 按 time 升序排序，方便做时间轴同步。
 */
export function parseDanmakuXml(xml: string): DanmuItem[] {
  // \b 保证 p 是独立属性名；[^>]* 不会跨越 '>'，因此不会吞掉嵌套标签。
  const dTag = /<d\b([^>]*)>([\s\S]*?)<\/d>/g
  const result: DanmuItem[] = []
  let match: RegExpExecArray | null

  while ((match = dTag.exec(xml)) !== null) {
    const attrs = match[1]
    const textRaw = match[2]
    // p 必须是独立属性名（\b 边界），避免误匹配 timestamp 的 p。
    const pMatch = /\bp="([^"]*)"/.exec(attrs)
    if (!pMatch) continue
    const attr = pMatch[1].split(",")
    if (attr.length < 4) continue // 时间/模式/字号/颜色都没有，跳过

    const time = Number(attr[0])
    if (!Number.isFinite(time) || time < 0) continue

    let text = decodeEntities(textRaw.trim())
    if (!text) continue

    // 弹幕带上用户名：@用户名：弹幕内容
    // danmuji 抖音 XML 把用户名放在 user="..." 属性里。
    const userMatch = /\buser="([^"]*)"/.exec(attrs)
    const user = userMatch ? decodeEntities(userMatch[1]).trim() : ""
    if (user) {
      text = `@${user}：${text}`
    }

    result.push({
      // 插件 emit 对 time=0 判为 falsy 会改成 currentTime+0.5，
      // 用 0.01 规避，视觉上仍是开头立即出现。
      time: time === 0 ? 0.01 : time,
      mode: normalizeMode(Number(attr[1])),
      color: normalizeColor(Number(attr[3])),
      text,
    })
  }

  result.sort((a, b) => a.time - b.time)
  return result
}

/**
 * 从 URL 拉取 XML 并解析。失败时返回空数组（不阻断播放）。
 */
export async function fetchDanmaku(url: string): Promise<DanmuItem[]> {
  try {
    const resp = await fetch(url)
    if (!resp.ok) return []
    const xml = await resp.text()
    return parseDanmakuXml(xml)
  } catch (e) {
    console.warn("[danmaku] fetch/parse failed:", e)
    return []
  }
}
