import type Artplayer from "artplayer"

/**
 * 可自由调整尺寸的“画中画”浮窗。
 *
 * 原生 Picture-in-Picture 的窗口尺寸完全由浏览器/系统控制，网页无法设置。
 * 这里通过把播放器容器移入一个 fixed 定位的浮层，实现“任意尺寸”的悬浮窗口：
 * - 窗口尺寸始终贴合视频宽高比，竖屏视频铺满无黑边
 * - 拖动顶部区域移动窗口
 * - 八向拖拽边框调整尺寸（宽高按视频比例联动）
 * - 位置与尺寸持久化到 localStorage
 * - 可随时还原回内嵌布局
 */

const STORAGE_KEY = "video_float_window"
// 最小宽高：允许缩到很小的竖屏窗口（如 200x255 这类），具体比例由视频决定
const MIN_WIDTH = 120
const MIN_HEIGHT = 120
const EDGE = 6 // 可拖拽边框的像素宽度
// 视频宽高比未知时的兜底比例（16:9）
const DEFAULT_RATIO = 16 / 9

export interface FloatRect {
  left: number
  top: number
  width: number
  height: number
}

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | null

interface FloatState extends FloatRect {
  enabled: boolean
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max)
}

function loadState(): FloatState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as Partial<FloatState>
      if (
        typeof s.left === "number" &&
        typeof s.top === "number" &&
        typeof s.width === "number" &&
        typeof s.height === "number"
      ) {
        return {
          left: s.left,
          top: s.top,
          width: s.width,
          height: s.height,
          enabled: !!s.enabled,
        }
      }
    }
  } catch {
    // ignore
  }
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.round(Math.min(480, vw * 0.45))
  const height = Math.round(Math.min(270, vh * 0.45))
  return {
    left: Math.max(16, vw - width - 24),
    top: Math.max(16, vh - height - 24),
    width,
    height,
    enabled: false,
  }
}

function saveState(state: FloatState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

export class FloatingPlayer {
  private player: Artplayer
  private state: FloatState
  private wrapper: HTMLDivElement | null = null
  private handleBar: HTMLDivElement | null = null
  private placeholder: HTMLDivElement | null = null
  private originalParent: HTMLElement | null = null
  private originalNextSibling: Node | null = null
  private resizeHandles: HTMLDivElement[] = []
  private activeResize: ResizeDir = null
  private startX = 0
  private startY = 0
  private startRect: FloatRect = { left: 0, top: 0, width: 0, height: 0 }
  private onDocMove = (e: PointerEvent) => this.handleDocMove(e)
  private onDocUp = () => this.handleDocUp()
  private onWindowResize = () => this.keepInViewport()
  private onChange?: (enabled: boolean) => void

  constructor(player: Artplayer, onChange?: (enabled: boolean) => void) {
    this.player = player
    this.state = loadState()
    this.onChange = onChange
    // 若上次处于浮窗状态，启动时自动恢复
    if (this.state.enabled) {
      // 延迟到 ready，确保容器已完成布局
      player.once("ready", () => this.enable())
    }
  }

  get enabled() {
    return this.state.enabled
  }

  /** 当前视频宽高比（宽 / 高），未知时返回兜底 16:9 */
  private get videoRatio(): number {
    const v = this.player?.video
    if (v && v.videoWidth > 0 && v.videoHeight > 0) {
      return v.videoWidth / v.videoHeight
    }
    return DEFAULT_RATIO
  }

  toggle() {
    if (this.state.enabled) this.disable()
    else this.enable()
  }

  enable() {
    if (this.state.enabled) return
    const container = this.player.template.$container as HTMLDivElement
    if (!container) return

    this.originalParent = container.parentElement
    this.originalNextSibling = container.nextSibling

    // 占位符：保持内嵌布局不塌陷
    const placeholder = document.createElement("div")
    placeholder.style.width = `${container.offsetWidth}px`
    placeholder.style.height = `${container.offsetHeight}px`
    placeholder.style.pointerEvents = "none"
    this.placeholder = placeholder
    this.originalParent?.insertBefore(placeholder, container)

    // 浮层
    const wrapper = document.createElement("div")
    wrapper.className = "artplayer-float-window"
    wrapper.style.position = "fixed"
    wrapper.style.zIndex = "99999"
    wrapper.style.overflow = "hidden"
    wrapper.style.borderRadius = "8px"
    wrapper.style.boxShadow = "0 8px 32px rgba(0,0,0,0.45)"
    wrapper.style.background = "#000"
    wrapper.style.touchAction = "none"

    container.style.width = "100%"
    container.style.height = "100%"
    wrapper.appendChild(container)

    // 顶部可见工具条：拖动移动 + 关闭按钮（小窗里更易操作）
    const handleBar = document.createElement("div")
    handleBar.style.position = "absolute"
    handleBar.style.top = "0"
    handleBar.style.left = "0"
    handleBar.style.right = "0"
    handleBar.style.height = "22px"
    handleBar.style.cursor = "move"
    handleBar.style.zIndex = "10"
    handleBar.style.display = "flex"
    handleBar.style.alignItems = "center"
    handleBar.style.justifyContent = "space-between"
    handleBar.style.padding = "0 6px"
    handleBar.style.boxSizing = "border-box"
    handleBar.style.background = "rgba(0,0,0,0.35)"
    handleBar.style.color = "#fff"
    handleBar.style.fontSize = "11px"
    handleBar.style.opacity = "0"
    handleBar.style.transition = "opacity 0.2s"
    handleBar.title = "Drag to move"

    const dragHint = document.createElement("span")
    dragHint.textContent = "⋮⋮"
    dragHint.style.letterSpacing = "1px"
    dragHint.style.userSelect = "none"

    const closeBtn = document.createElement("button")
    closeBtn.textContent = "✕"
    closeBtn.title = "Close float window"
    closeBtn.style.border = "none"
    closeBtn.style.background = "transparent"
    closeBtn.style.color = "#fff"
    closeBtn.style.cursor = "pointer"
    closeBtn.style.fontSize = "12px"
    closeBtn.style.lineHeight = "1"
    closeBtn.style.padding = "2px 4px"
    closeBtn.addEventListener("pointerdown", (e) => e.stopPropagation())
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      this.disable()
    })

    handleBar.appendChild(dragHint)
    handleBar.appendChild(closeBtn)
    this.handleBar = handleBar
    wrapper.appendChild(handleBar)

    // 鼠标移入浮窗时显示工具条
    wrapper.addEventListener("pointerenter", () => {
      handleBar.style.opacity = "1"
    })
    wrapper.addEventListener("pointerleave", () => {
      handleBar.style.opacity = "0"
    })

    // 滚轮转发：把浮窗内的滚轮事件转发给播放器元素，
    // 交由全局脚本（绑定在 .art-video-player 上的 wheel 监听）统一处理，避免双触发。
    const $playerEl = this.player.template.$player as HTMLElement | undefined
    wrapper.addEventListener(
      "wheel",
      (e) => {
        if (!$playerEl) return
        const forwarded = new WheelEvent("wheel", {
          deltaY: e.deltaY,
          deltaX: e.deltaX,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          bubbles: true,
          cancelable: true,
        })
        $playerEl.dispatchEvent(forwarded)
        if (forwarded.defaultPrevented) e.preventDefault()
      },
      { passive: false },
    )

    // 八个方向的 resize 句柄
    this.createResizeHandles(wrapper)

    document.body.appendChild(wrapper)
    this.wrapper = wrapper

    // 让窗口尺寸贴合视频宽高比，避免黑边
    this.fitToVideoRatio()
    this.applyRect(this.state)
    this.bindEvents()
    window.addEventListener("resize", this.onWindowResize)

    this.state.enabled = true
    saveState(this.state)
    this.onChange?.(true)

    // 视频元数据加载后（宽高比可能变化，如切换视频/竖屏视频）再次贴合比例
    const onMeta = () => this.fitToVideoRatio()
    this.player.video?.addEventListener("loadedmetadata", onMeta)
    ;(this as any)._onMeta = onMeta

    // 浮窗模式下禁用 autoHeight，避免覆盖
    this.player.autoSize?.()

    // 通知全局自定义脚本：播放器 DOM 结构已变化，需要重新绑定
    // （用户的全局脚本通过 MutationObserver / scheduleRun 重跑）
    this.notifyGlobalRescan()
  }

  /** 触发全局自定义脚本重新扫描/绑定 */
  private notifyGlobalRescan() {
    try {
      window.dispatchEvent(new Event("resize"))
      // 触发一次 body 上的 DOM 变化，让 MutationObserver 感知
      const marker = document.createElement("span")
      marker.style.display = "none"
      marker.setAttribute("data-ol-rescan", String(Date.now()))
      document.body.appendChild(marker)
      setTimeout(() => marker.remove(), 0)
    } catch {
      // ignore
    }
  }

  disable() {
    if (!this.state.enabled) return
    const container = this.player.template.$container as
      HTMLDivElement | undefined
    if (this.wrapper && container) {
      // 还原样式
      container.style.width = ""
      container.style.height = ""
      // 仅在原占位符/父节点仍挂载在文档中时才插回，避免路由卸载后报错
      if (this.placeholder && this.placeholder.parentNode) {
        this.placeholder.parentNode.insertBefore(container, this.placeholder)
        this.placeholder.remove()
      } else if (
        this.originalParent &&
        document.contains(this.originalParent)
      ) {
        this.originalParent.insertBefore(container, this.originalNextSibling)
      }
      this.wrapper.remove()
    }
    // 移除 loadedmetadata 监听
    const onMeta = (this as any)._onMeta as (() => void) | undefined
    if (onMeta) {
      this.player.video?.removeEventListener("loadedmetadata", onMeta)
      ;(this as any)._onMeta = undefined
    }

    this.wrapper = null
    this.handleBar = null
    this.placeholder = null
    this.resizeHandles = []
    this.unbindEvents()
    this.activeResize = null

    this.state.enabled = false
    saveState(this.state)
    this.onChange?.(false)

    // 触发一次自动高度重算
    this.player.autoHeight?.()

    // 还原后同样通知全局脚本重新绑定
    this.notifyGlobalRescan()
  }

  destroy() {
    this.disable()
  }

  /**
   * 依据视频宽高比调整当前窗口尺寸。
   * 优先保持宽度不变，按比例重算高度；高度受限时再以高度为准重算宽度。
   */
  private fitToVideoRatio() {
    if (!this.wrapper) return
    const ratio = this.videoRatio
    const vw = window.innerWidth
    const vh = window.innerHeight

    let width = this.state.width
    let height = Math.round(width / ratio)

    // 高度超过可视区则收缩宽度
    const maxHeight = vh - this.state.top - 8
    if (height > maxHeight) {
      height = Math.max(MIN_HEIGHT, maxHeight)
      width = Math.round(height * ratio)
    }

    // 宽度边界
    const maxWidth = vw - this.state.left - 8
    if (width > maxWidth) {
      width = Math.max(MIN_WIDTH, maxWidth)
      height = Math.round(width / ratio)
    }

    width = Math.max(MIN_WIDTH, width)
    height = Math.max(MIN_HEIGHT, height)

    this.state.width = width
    this.state.height = height
    // 修正位置，确保仍可见
    this.state.left = clamp(this.state.left, 0, Math.max(0, vw - width))
    this.state.top = clamp(this.state.top, 0, Math.max(0, vh - height))

    this.applyRect(this.state)
    saveState(this.state)
  }

  private createResizeHandles(wrapper: HTMLDivElement) {
    const dirs: Exclude<ResizeDir, null>[] = [
      "n",
      "s",
      "e",
      "w",
      "ne",
      "nw",
      "se",
      "sw",
    ]
    const cursorMap: Record<string, string> = {
      n: "ns-resize",
      s: "ns-resize",
      e: "ew-resize",
      w: "ew-resize",
      ne: "nesw-resize",
      sw: "nesw-resize",
      nw: "nwse-resize",
      se: "nwse-resize",
    }
    for (const dir of dirs) {
      const h = document.createElement("div")
      h.dataset.dir = dir
      h.style.position = "absolute"
      h.style.zIndex = "11"
      h.style.cursor = cursorMap[dir]

      const half = EDGE / 2
      if (dir.includes("n")) {
        h.style.top = `-${half}px`
        h.style.left = dir.includes("w") ? `-${half}px` : "0"
        h.style.right = dir.includes("e") ? `-${half}px` : "0"
        h.style.height = `${EDGE}px`
      }
      if (dir.includes("s")) {
        h.style.bottom = `-${half}px`
        h.style.left = dir.includes("w") ? `-${half}px` : "0"
        h.style.right = dir.includes("e") ? `-${half}px` : "0"
        h.style.height = `${EDGE}px`
      }
      if (dir === "e" || dir === "w") {
        h.style.top = "0"
        h.style.bottom = "0"
        h.style.width = `${EDGE}px`
        if (dir === "e") h.style.right = `-${half}px`
        else h.style.left = `-${half}px`
      }
      if (dir === "ne" || dir === "se") {
        h.style.width = `${EDGE * 2}px`
        h.style.right = `-${half}px`
      }
      if (dir === "nw" || dir === "sw") {
        h.style.width = `${EDGE * 2}px`
        h.style.left = `-${half}px`
      }
      if (dir === "ne" || dir === "nw") {
        h.style.top = `-${half}px`
        h.style.height = `${EDGE * 2}px`
      }
      if (dir === "se" || dir === "sw") {
        h.style.bottom = `-${half}px`
        h.style.height = `${EDGE * 2}px`
      }

      h.addEventListener("pointerdown", (e) =>
        this.startResize(e, dir as Exclude<ResizeDir, null>),
      )
      wrapper.appendChild(h)
      this.resizeHandles.push(h)
    }
  }

  private bindEvents() {
    this.handleBar?.addEventListener("pointerdown", (e) => this.startMove(e))
  }

  private unbindEvents() {
    // 使用 new function 无法移除匿名监听器，这里通过重建句柄已移除节点，
    // 监听器随节点销毁自动失效；文档级监听器需要显式移除。
    document.removeEventListener("pointermove", this.onDocMove)
    document.removeEventListener("pointerup", this.onDocUp)
    window.removeEventListener("resize", this.onWindowResize)
  }

  private keepInViewport() {
    if (!this.wrapper) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    this.state.width = Math.min(this.state.width, vw)
    this.state.height = Math.min(this.state.height, vh)
    this.state.left = clamp(
      this.state.left,
      0,
      Math.max(0, vw - this.state.width),
    )
    this.state.top = clamp(
      this.state.top,
      0,
      Math.max(0, vh - this.state.height),
    )
    this.applyRect(this.state)
    saveState(this.state)
  }

  private startMove(e: PointerEvent) {
    e.preventDefault()
    this.activeResize = null
    this.startX = e.clientX
    this.startY = e.clientY
    this.startRect = { ...this.state }
    document.addEventListener("pointermove", this.onDocMove)
    document.addEventListener("pointerup", this.onDocUp)
  }

  private startResize(e: PointerEvent, dir: Exclude<ResizeDir, null>) {
    e.preventDefault()
    e.stopPropagation()
    this.activeResize = dir
    this.startX = e.clientX
    this.startY = e.clientY
    this.startRect = { ...this.state }
    document.addEventListener("pointermove", this.onDocMove)
    document.addEventListener("pointerup", this.onDocUp)
  }

  private handleDocMove(e: PointerEvent) {
    const dx = e.clientX - this.startX
    const dy = e.clientY - this.startY
    const vw = window.innerWidth
    const vh = window.innerHeight
    const r = this.startRect
    const ratio = this.videoRatio

    if (!this.activeResize) {
      // 移动
      const left = clamp(r.left + dx, 0, vw - r.width)
      const top = clamp(r.top + dy, 0, vh - r.height)
      this.state.left = left
      this.state.top = top
      this.applyRect(this.state)
      return
    }

    let left = r.left
    let top = r.top
    let width = r.width
    let height = r.height
    const dir = this.activeResize

    // 先按拖拽方向计算原始宽高（不强制比例）
    if (dir.includes("e")) width = r.width + dx
    if (dir.includes("s")) height = r.height + dy
    if (dir.includes("w")) {
      width = r.width - dx
      left = r.left + dx
    }
    if (dir.includes("n")) {
      height = r.height - dy
      top = r.top + dy
    }

    // 保持视频比例：横向拖拽优先以宽度为准，纵向优先以高度为准，
    // 角点拖拽取变化更明显的那一维。
    const horizontal = dir.includes("e") || dir.includes("w")
    const vertical = dir.includes("n") || dir.includes("s")

    if (horizontal && !vertical) {
      width = Math.max(MIN_WIDTH, width)
      height = Math.round(width / ratio)
      if (dir.includes("w")) left = r.left + r.width - width
      top = r.top
    } else if (vertical && !horizontal) {
      height = Math.max(MIN_HEIGHT, height)
      width = Math.round(height * ratio)
      if (dir.includes("n")) top = r.top + r.height - height
      left = r.left
    } else {
      // 角点：以宽度变化为主导，高度按比例
      width = Math.max(MIN_WIDTH, width)
      height = Math.round(width / ratio)
      if (height < MIN_HEIGHT) {
        height = MIN_HEIGHT
        width = Math.round(height * ratio)
      }
      if (dir.includes("w")) left = r.left + r.width - width
      if (dir.includes("n")) top = r.top + r.height - height
    }

    // 边界约束（保持比例的前提下，尽量不要越界；越界则整体收缩）
    if (left < 0) {
      width += left
      left = 0
      height = Math.round(width / ratio)
    }
    if (top < 0) {
      height += top
      top = 0
      width = Math.round(height * ratio)
    }
    if (left + width > vw) {
      width = vw - left
      height = Math.round(width / ratio)
    }
    if (top + height > vh) {
      height = vh - top
      width = Math.round(height * ratio)
    }

    width = Math.max(MIN_WIDTH, width)
    height = Math.max(MIN_HEIGHT, height)

    this.state.left = left
    this.state.top = top
    this.state.width = width
    this.state.height = height
    this.applyRect(this.state)
  }

  private handleDocUp() {
    this.activeResize = null
    document.removeEventListener("pointermove", this.onDocMove)
    document.removeEventListener("pointerup", this.onDocUp)
    saveState(this.state)
  }

  private applyRect(rect: FloatRect) {
    if (!this.wrapper) return
    this.wrapper.style.left = `${rect.left}px`
    this.wrapper.style.top = `${rect.top}px`
    this.wrapper.style.width = `${rect.width}px`
    this.wrapper.style.height = `${rect.height}px`

    // 根据当前尺寸打标记类，供 CSS 针对小尺寸浮窗优化控件布局
    const w = rect.width
    const h = rect.height
    const cls = this.wrapper.classList
    cls.toggle("is-tiny", w < 320 || h < 200)
    cls.toggle("is-small", !(w < 320 || h < 200) && (w < 480 || h < 300))
  }
}
