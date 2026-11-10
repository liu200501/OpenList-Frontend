import { Box } from "@hope-ui/solid"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useRouter, useLink } from "~/hooks"
import { getMainColor, getSettingBool, objStore, ObjStore } from "~/store"
import { ObjType } from "~/types"
import { ext, notify, pathDir, pathJoin } from "~/utils"
import Artplayer, { type Option, type Setting, type Events } from "artplayer"
import artplayerPluginDanmuku from "artplayer-plugin-danmuku"
import { type Option as DanmukuOption } from "artplayer-plugin-danmuku"
import artplayerPluginAss from "~/components/artplayer-plugin-ass"
import mpegts from "mpegts.js"
import Hls from "hls.js"
import { currentLang } from "~/app/i18n"
import { AutoHeightPlugin, VideoBox } from "./video_box"
import { FloatingPlayer } from "./floating_player"
import { ArtPlayerIconsSubtitle } from "~/components/icons"
import { useNavigate } from "@solidjs/router"
import "./artplayer.css"
import { useT } from "~/hooks"
import { isObjFavorite, toggleObjFavorite } from "../folder/collect"

// 本地安全 JSON 解析：解析失败返回 undefined，不抛异常
function safeJsonParse<T = unknown>(str: string | null): T | undefined {
  if (!str) return undefined
  try {
    return JSON.parse(str) as T
  } catch {
    return undefined
  }
}

const Preview = () => {
  const t = useT()
  const { pathname, searchParams } = useRouter()
  const { proxyLink, rawLink } = useLink()
  const navigate = useNavigate()
  // 直接访问文件 URL 时 objStore.objs 不会被填充，只有 related 有同目录文件列表；
  // 从目录点进来时两者都可能有，合并去重以兼容两种入口。
  const videos = createMemo(() => {
    const map = new Map<string, (typeof objStore.related)[number]>()
    for (const obj of [...objStore.related, ...objStore.objs]) {
      if (obj.type === ObjType.VIDEO && !map.has(obj.name)) {
        map.set(obj.name, obj)
      }
    }
    const list = [...map.values()]
    // 保证当前视频在列表中，即使 related 未包含自身
    if (objStore.obj?.name && !list.some((o) => o.name === objStore.obj.name)) {
      list.push(objStore.obj)
    }
    return list
  })
  const wasFullscreen = () => {
    if (!player) return false
    return !!(player.fullscreen || player.fullscreenWeb)
  }
  // 需要走路由重建播放器的格式（自定义 customType 无法通过 switchUrl 直接换源）
  const NEED_RELOAD_EXTS = ["flv", "m2ts", "m3u8"]
  const needReload = (name: string) =>
    NEED_RELOAD_EXTS.includes(ext(name).toLowerCase())

  // 原地切换：不销毁播放器、不跳路由，全屏状态可以保持
  const switchInPlace = async (obj: (typeof objStore.related)[number]) => {
    const nextUrl = rawLink(obj)
    try {
      // switchUrl 会保留当前播放器实例与全屏状态
      await player.switchUrl(nextUrl)
    } catch (e) {
      console.log("switchUrl failed, fallback to route:", e)
      return false
    }
    // 同步 store，让标题、右键菜单、截图文件名等指向新视频
    ObjStore.setObj(obj)
    ObjStore.setRawUrl(nextUrl)
    // 同步播放器标题（Artplayer 通过 attr 控制 title 显示）
    player.attr("title", obj.name)
    // 切换视频后刷新收藏按钮状态
    applyFavoriteUI()
    // 用 replaceState 更新地址栏，避免路由变化导致组件重建
    const pageUrl =
      pathJoin(pathDir(pathname()), obj.name) +
      "?auto_fullscreen=" +
      wasFullscreen()
    window.history.replaceState(window.history.state, "", pageUrl)
    return true
  }

  const switchTo = (target?: string) => {
    if (!target) return
    const obj = videos().find((v) => v.name === target)
    // 找到目标对象且格式支持原位切换时，走 switchUrl；否则退回路由跳转
    if (obj && !needReload(obj.name) && player) {
      switchInPlace(obj)
      return
    }
    const fullscreen = wasFullscreen()
    const url =
      pathJoin(pathDir(pathname()), target) + "?auto_fullscreen=" + fullscreen
    // 先主动退出全屏，避免全屏元素被路由卸载时浏览器强制退出导致的时序错乱
    if (document.fullscreenElement) {
      document
        .exitFullscreen()
        .catch(() => {})
        .finally(() => navigate(url))
    } else {
      navigate(url)
    }
  }
  const next_video = () => {
    const list = videos()
    const index = list.findIndex((f) => f.name === objStore.obj.name)
    if (index >= 0 && index < list.length - 1) {
      switchTo(list[index + 1].name)
    }
  }
  const previous_video = () => {
    const list = videos()
    const index = list.findIndex((f) => f.name === objStore.obj.name)
    if (index > 0) {
      switchTo(list[index - 1].name)
    }
  }
  let disposed = false
  let player: Artplayer
  let flvPlayer: mpegts.Player
  let hlsPlayer: Hls
  let floatingPlayer: FloatingPlayer

  // 浮窗（可调任意尺寸的画中画）图标
  const FLOAT_ON_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"></path><rect x="3" y="4" width="18" height="14" rx="2"></rect><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"></rect></svg>'
  const FLOAT_OFF_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"></path><rect x="3" y="4" width="18" height="14" rx="2"></rect><path d="M12 11l7 5m0 -5l-7 5" opacity="0.6"></path></svg>'
  const applyFloatUI = (on: boolean) => {
    const btn = (player?.controls as any)?.["float-button"] as
      HTMLElement | undefined
    if (btn) {
      btn.innerHTML = on ? FLOAT_ON_ICON : FLOAT_OFF_ICON
      btn.style.opacity = on ? "1" : "0.7"
    }
  }
  const toggleFloat = () => {
    if (!floatingPlayer) return
    floatingPlayer.toggle()
    applyFloatUI(floatingPlayer.enabled)
    notify.info(
      floatingPlayer.enabled ? "已切换到浮窗（可拖动/缩放）" : "已还原播放器",
    )
  }

  // 循环播放：Artplayer 的 option.loop 只在初始化时生效，运行时需直接操作原生 video.loop
  const LOOP_ON_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M4 12v-3a3 3 0 0 1 3 -3h11"></path><polyline points="14 3 17 6 14 9"></polyline><path d="M20 12v3a3 3 0 0 1 -3 3h-11"></path><polyline points="10 21 7 18 10 15"></polyline></svg>'
  // 关闭态使用同一图标的淡化样式（opacity 降低），保持视觉一致
  const LOOP_OFF_ICON = LOOP_ON_ICON.replace(
    'stroke="currentColor"',
    'stroke="currentColor" opacity="0.4"',
  )
  const LOOP_KEY = "video_loop"
  const applyLoopUI = (on: boolean) => {
    // Artplayer 在 Component.add 中按 name 把节点挂到实例上，键名即 "loop-button"
    const btn = (player?.controls as any)?.["loop-button"] as
      HTMLElement | undefined
    if (btn) {
      btn.innerHTML = on ? LOOP_ON_ICON : LOOP_OFF_ICON
      btn.style.opacity = on ? "1" : "0.6"
    }
  }
  // 是否循环播放。
  // 抖音式无缝：在距离结尾还有一小段（数据已缓冲）时就提前 seek 回 0，
  // 避免走到 ended 后再重新初始化/重新取首帧造成的停顿。
  // 不使用原生 video.loop，避免与提前回绕双重触发。
  const LOOP_REWIND_AHEAD = 0.3 // 秒
  let loopEnabled = false
  let loopRewinding = false
  const applyLoopState = () => {
    if (player?.video) player.video.loop = false
    loopRewinding = false
    applyLoopUI(loopEnabled)
  }
  const syncLoop = () => applyLoopState()
  const toggleLoop = () => {
    if (!player?.video) return
    loopEnabled = !loopEnabled
    applyLoopState()
    localStorage.setItem(LOOP_KEY, String(loopEnabled))
    notify.info(loopEnabled ? "循环播放已开启" : "循环播放已关闭")
  }
  // 提前回绕：仅在播放中、未 seek、且接近结尾时触发一次
  const tryRewindForLoop = () => {
    if (!loopEnabled || loopRewinding || !player?.video) return
    const v = player.video
    const d = v.duration
    if (!d || d === Infinity || v.seeking || v.paused) return
    if (d - v.currentTime <= LOOP_REWIND_AHEAD) {
      loopRewinding = true
      v.currentTime = 0
    }
  }

  // ── 滚轮切集开关 ──
  // 开启后：滚轮上 = 上一条视频，滚轮下 = 下一条视频；关闭恢复播放器默认行为。
  const WHEEL_SWITCH_KEY = "video_wheel_switch"
  let wheelSwitchEnabled = localStorage.getItem(WHEEL_SWITCH_KEY) === "true"
  let wheelLocked = false
  let wheelLockTimer: number | undefined
  const onPlayerWheel = (e: WheelEvent) => {
    if (!wheelSwitchEnabled) return
    // 只处理纵向滚动；横向滚轮（触控板左右滑）忽略
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    // 阻止播放器默认的音量/进度滚轮行为
    e.preventDefault()
    e.stopPropagation()
    if (wheelLocked) return
    // 节流：一次滚动手势只切一集，避免触控板惯性连切
    wheelLocked = true
    if (wheelLockTimer !== undefined) window.clearTimeout(wheelLockTimer)
    wheelLockTimer = window.setTimeout(() => {
      wheelLocked = false
    }, 350)
    if (e.deltaY < 0) previous_video()
    else next_video()
  }
  // 右键菜单项文案元素（随开关状态更新）
  const wheelSwitchLabelEl = document.createElement("span")
  const renderWheelSwitchLabel = () => {
    wheelSwitchLabelEl.textContent = wheelSwitchEnabled
      ? "滚轮切集：开"
      : "滚轮切集：关"
  }
  renderWheelSwitchLabel()
  const setWheelSwitch = (on: boolean) => {
    wheelSwitchEnabled = on
    wheelLocked = false
    if (wheelLockTimer !== undefined) {
      window.clearTimeout(wheelLockTimer)
      wheelLockTimer = undefined
    }
    localStorage.setItem(WHEEL_SWITCH_KEY, String(on))
    renderWheelSwitchLabel()
    notify.info(on ? "滚轮切集已开启" : "滚轮切集已关闭")
  }

  // ── 总是静音启动开关 ──
  // 开启后：每次（含切集）启动播放器都默认静音；关闭恢复正常音量启动。
  const MUTE_ON_START_KEY = "video_mute_on_start"
  let muteOnStartEnabled = localStorage.getItem(MUTE_ON_START_KEY) === "true"
  const muteSwitchLabelEl = document.createElement("span")
  const renderMuteSwitchLabel = () => {
    muteSwitchLabelEl.textContent = muteOnStartEnabled
      ? "静音启动：开"
      : "静音启动：关"
  }
  renderMuteSwitchLabel()
  const setMuteOnStart = (on: boolean) => {
    muteOnStartEnabled = on
    localStorage.setItem(MUTE_ON_START_KEY, String(on))
    renderMuteSwitchLabel()
    // 立即把当前播放器同步到目标状态，避免开关后无反馈
    if (player?.video) player.muted = on
    notify.info(on ? "已开启静音启动" : "已关闭静音启动")
  }

  // ── 全屏选集面板 ──
  // 挂到播放器容器内部，跟随全屏元素显示；用绝对定位覆盖在视频上方。
  const EPISODE_LIST_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"></path><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="18" x2="20" y2="18"></line></svg>'
  let episodePanel: HTMLDivElement | undefined

  const closeEpisodePanel = () => {
    if (episodePanel) {
      episodePanel.remove()
      episodePanel = undefined
    }
  }

  const openEpisodePanel = () => {
    if (!player) return
    if (episodePanel) {
      closeEpisodePanel()
      return
    }
    const list = videos()
    if (list.length === 0) return

    const panel = document.createElement("div")
    panel.className = "art-episode-panel"
    // 阻止点击事件冒泡到播放器，避免触发暂停/播放
    panel.addEventListener("click", (e) => e.stopPropagation())

    const header = document.createElement("div")
    header.className = "art-episode-panel__header"
    header.textContent = `选集（共 ${list.length} 集）`
    const closeBtn = document.createElement("button")
    closeBtn.className = "art-episode-panel__close"
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'
    closeBtn.onclick = (e) => {
      e.stopPropagation()
      closeEpisodePanel()
    }
    header.appendChild(closeBtn)

    const listEl = document.createElement("div")
    listEl.className = "art-episode-panel__list"
    list.forEach((item, i) => {
      const row = document.createElement("button")
      row.className = "art-episode-panel__item"
      if (item.name === objStore.obj.name) {
        row.classList.add("is-active")
      }
      const indexEl = document.createElement("span")
      indexEl.className = "art-episode-panel__index"
      indexEl.textContent = String(i + 1)
      const nameEl = document.createElement("span")
      nameEl.className = "art-episode-panel__name"
      nameEl.title = item.name
      nameEl.textContent = item.name
      row.appendChild(indexEl)
      row.appendChild(nameEl)
      row.onclick = (e) => {
        e.stopPropagation()
        closeEpisodePanel()
        if (item.name !== objStore.obj.name) switchTo(item.name)
      }
      listEl.appendChild(row)
    })

    panel.appendChild(header)
    panel.appendChild(listEl)
    player.template.$player.appendChild(panel)
    episodePanel = panel
  }

  // 自定义截图：文件名 = 视频名（去扩展名） + 『hh-mm-ss』
  const doScreenshot = () => {
    if (!player) return
    const baseName = objStore.obj.name
      .replace(/\.[^.]+$/, "")
      .replace(/[\\/:*?"<>|]/g, "_")

    const totalSeconds = Math.floor(player.currentTime)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    const pad = (n: number) => String(n).padStart(2, "0")
    // 固定 hh-mm-ss，始终补零到两位，并用 『』 包裹
    const timeStr = `『${pad(hours)}-${pad(minutes)}-${pad(seconds)}』`

    player.screenshot(`${baseName}_${timeStr}`)
  }

  // ── 收藏按钮 ──
  // 当前视频是否已收藏（目录 = 当前文件所在目录）。
  const currentDir = () => pathDir(pathname())
  const isFavorited = () => isObjFavorite(currentDir(), objStore.obj)
  const starIcon = (favorited: boolean) => {
    const color = favorited ? "#f59e0b" : "currentColor"
    const d = favorited
      ? '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z" fill="currentColor"></path>'
      : '<path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z" fill="none" stroke="currentColor" stroke-width="2"></path>'
    return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:${color}">${d}</svg>`
  }
  const applyFavoriteUI = () => {
    const btn = (player?.controls as any)?.["favorite-button"] as
      HTMLElement | undefined
    if (btn) {
      btn.innerHTML = starIcon(isFavorited())
    }
  }
  const toggleFavorite = async () => {
    // toggleObjFavorite 内部处理成功/失败状态与提示，这里只同步按钮图标
    await toggleObjFavorite(currentDir(), objStore.obj)
    applyFavoriteUI()
  }

  // 唯一 id，避免路由切换时新旧播放器争抢同一容器
  const playerId = `video-player-${pathname()}-${Date.now()}`
  let option: Option = {
    id: playerId,
    container: "#video-player",
    url: objStore.raw_url,
    title: objStore.obj.name,
    volume: 1.0,
    autoplay: getSettingBool("video_autoplay"),
    autoSize: false,
    autoMini: true,
    loop: false,
    flip: true,
    playbackRate: true,
    aspectRatio: true,
    // 关闭默认截图按钮，改用自定义控件
    screenshot: false,
    setting: true,
    hotkey: true,
    // 关闭浏览器原生画中画，改用自定义可调尺寸浮窗
    pip: false,
    mutex: true,
    fullscreen: true,
    fullscreenWeb: true,
    subtitleOffset: true,
    miniProgressBar: false,
    playsInline: true,
    theme: getMainColor(),
    controls: [
      {
        name: "previous-button",
        index: 10,
        position: "left",
        html: '<svg fill="none" stroke-width="2" xmlns="http://www.w3.org/2000/svg" height="22" width="22" class="icon icon-tabler icon-tabler-player-track-prev-filled" width="1em" height="1em" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="overflow: visible; color: currentcolor;"><path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M20.341 4.247l-8 7a1 1 0 0 0 0 1.506l8 7c.647 .565 1.659 .106 1.659 -.753v-14c0 -.86 -1.012 -1.318 -1.659 -.753z" stroke-width="0" fill="currentColor"></path><path d="M9.341 4.247l-8 7a1 1 0 0 0 0 1.506l8 7c.647 .565 1.659 .106 1.659 -.753v-14c0 -.86 -1.012 -1.318 -1.659 -.753z" stroke-width="0" fill="currentColor"></path></svg>',
        tooltip: "Previous",
        click: function () {
          previous_video()
        },
      },
      {
        name: "next-button",
        index: 11,
        position: "left",
        html: '<svg fill="none" stroke-width="2" xmlns="http://www.w3.org/2000/svg" height="22" width="22" class="icon icon-tabler icon-tabler-player-track-next-filled" width="1em" height="1em" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="overflow: visible; color: currentcolor;"><path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M2 5v14c0 .86 1.012 1.318 1.659 .753l8 -7a1 1 0 0 0 0 -1.506l-8 -7c-.647 -.565 -1.659 -.106 -1.659 .753z" stroke-width="0" fill="currentColor"></path><path d="M13 5v14c0 .86 1.012 1.318 1.659 .753l8 -7a1 1 0 0 0 0 -1.506l-8 -7c-.647 -.565 -1.659 -.106 -1.659 .753z" stroke-width="0" fill="currentColor"></path></svg>',
        tooltip: "Next",
        click: function () {
          next_video()
        },
      },
      {
        name: "favorite-button",
        index: 8,
        position: "right",
        html: starIcon(isObjFavorite(pathDir(pathname()), objStore.obj)),
        tooltip: t("home.toolbar.collect"),
        click: function () {
          toggleFavorite()
        },
      },
      {
        name: "loop-button",
        index: 12,
        position: "right",
        html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M4 12v-3a3 3 0 0 1 3 -3h11"></path><polyline points="14 3 17 6 14 9"></polyline><path d="M20 12v3a3 3 0 0 1 -3 3h-11"></path><polyline points="10 21 7 18 10 15"></polyline></svg>',
        tooltip: "Loop: Off",
        click: function () {
          toggleLoop()
        },
      },
      {
        name: "episode-button",
        index: 9,
        position: "right",
        html: EPISODE_LIST_ICON,
        tooltip: "选集",
        click: function () {
          openEpisodePanel()
        },
      },
      {
        name: "float-button",
        index: 14,
        position: "right",
        html: FLOAT_OFF_ICON,
        tooltip: "Float Window",
        click: function () {
          toggleFloat()
        },
      },
      {
        name: "custom-screenshot",
        index: 13,
        position: "right",
        html: '<svg xmlns="http://www.w3.org/2000/svg" height="22" width="22" viewBox="0 0 50 50"><path d="M 19.402344 6 C 17.019531 6 14.96875 7.679688 14.5 10.011719 L 14.097656 12 L 9 12 C 6.238281 12 4 14.238281 4 17 L 4 38 C 4 40.761719 6.238281 43 9 43 L 41 43 C 43.761719 43 46 40.761719 46 38 L 46 17 C 46 14.238281 43.761719 12 41 12 L 35.902344 12 L 35.5 10.011719 C 35.03125 7.679688 32.980469 6 30.597656 6 Z M 25 17 C 30.519531 17 35 21.480469 35 27 C 35 32.519531 30.519531 37 25 37 C 19.480469 37 15 32.519531 15 27 C 15 21.480469 19.480469 17 25 17 Z M 25 19 C 20.589844 19 17 22.589844 17 27 C 17 31.410156 20.589844 35 25 35 C 29.410156 35 33 31.410156 33 27 C 33 22.589844 29.410156 19 25 19 Z"></path></svg>',
        tooltip: "Screenshot",
        click: function () {
          doScreenshot()
        },
      },
    ],
    quality: [],
    plugins: [AutoHeightPlugin],
    whitelist: [],
    settings: [],
    moreVideoAttr: {
      // @ts-ignore
      "webkit-playsinline": true,
      playsInline: true,
      crossOrigin: "anonymous",
      // 提前缓冲，减少循环回绕时的重新加载卡顿
      preload: "auto",
    },
    type: ext(objStore.obj.name),
    customType: {
      flv: function (video: HTMLMediaElement, url: string) {
        flvPlayer = mpegts.createPlayer(
          {
            type: "flv",
            url: url,
          },
          { referrerPolicy: "same-origin" },
        )
        flvPlayer.attachMediaElement(video)
        flvPlayer.load()
      },
      m2ts: function (video: HTMLMediaElement, url: string) {
        flvPlayer?.destroy()
        flvPlayer = mpegts.createPlayer(
          {
            type: "m2ts",
            url: url,
          },
          { referrerPolicy: "same-origin" },
        )
        flvPlayer.attachMediaElement(video)
        flvPlayer.load()
      },
      m3u8: function (video: HTMLMediaElement, url: string) {
        hlsPlayer = new Hls()
        hlsPlayer.loadSource(url)
        hlsPlayer.attachMedia(video)
        if (!video.src) {
          video.src = url
        }
      },
    },
    lang: ["en", "zh-cn", "zh-tw"].includes(currentLang().toLowerCase())
      ? (currentLang().toLowerCase() as string)
      : "en",
    lock: true,
    fastForward: true,
    autoPlayback: true,
    autoOrientation: true,
    airplay: true,
    // 自定义右键菜单：滚轮切集开关、静音启动开关
    contextmenu: [
      {
        name: "wheel-switch",
        // Artplayer 的 html 只接受 string | HTMLElement，用元素承载动态文案
        html: wheelSwitchLabelEl,
        click: () => {
          setWheelSwitch(!wheelSwitchEnabled)
        },
      },
      {
        name: "mute-switch",
        html: muteSwitchLabelEl,
        click: () => {
          setMuteOnStart(!muteOnStartEnabled)
        },
      },
    ],
  }
  const subtitle = objStore.related.filter((obj) => {
    for (const ext of [".srt", ".ass", ".vtt"]) {
      if (obj.name.endsWith(ext)) {
        return true
      }
    }
    return false
  })
  const danmu = objStore.related.find((obj) => {
    for (const ext of [".xml"]) {
      if (obj.name.endsWith(ext)) {
        return true
      }
    }
    return false
  })

  const enableEnhanceAss = true

  if (subtitle.length != 0) {
    let isEnhanceAssMode = false

    const defaultSubtitle = subtitle[0]
    if (enableEnhanceAss && ext(defaultSubtitle.name).toLowerCase() === "ass") {
      isEnhanceAssMode = true
      option.plugins?.push(
        artplayerPluginAss({
          subUrl: proxyLink(defaultSubtitle, true),
        }),
      )
    } else {
      option.subtitle = {
        url: proxyLink(defaultSubtitle, true),
        type: ext(defaultSubtitle.name),
        escape: false,
      }
    }

    const innerMenu: Setting[] = [
      {
        id: "setting_subtitle_display",
        html: "Display",
        tooltip: "Show",
        switch: true,
        onSwitch: function (item: Setting) {
          item.tooltip = item.switch ? "Hide" : "Show"
          setSubtitleVisible(!item.switch)

          const menu_sub = option.settings?.find(
            (s) => s.id === "setting_subtitle",
          )
          menu_sub && (menu_sub.tooltip = item.tooltip)

          return !item.switch
        },
      },
    ]
    subtitle.forEach((item, i) => {
      innerMenu.push({
        default: i === 0,
        html: (
          <span
            title={item.name}
            style={{
              "max-width": "200px",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "word-break": "break-all",
              "white-space": "normal",
              display: "-webkit-box",
              "-webkit-line-clamp": "2",
              "-webkit-box-orient": "vertical",
              "font-size": "12px",
            }}
          >
            {item.name}
          </span>
        ) as HTMLElement,
        name: item.name,
        url: proxyLink(item, true),
      })
    })

    option.settings?.push({
      id: "setting_subtitle",
      html: "Subtitle",
      tooltip: "Show",
      icon: ArtPlayerIconsSubtitle({ size: 24 }) as HTMLElement,
      selector: innerMenu,
      onSelect: function (item: Setting) {
        if (enableEnhanceAss && ext(item.name).toLowerCase() === "ass") {
          isEnhanceAssMode = true
          this.emit("artplayer-plugin-ass:switch" as any, item.url)
          setSubtitleVisible(true)
        } else {
          isEnhanceAssMode = false
          this.subtitle.switch(item.url, { name: item.name })
          this.once("subtitleLoad", setSubtitleVisible.bind(this, true))
        }

        const switcher = innerMenu.find(
          (_) => _.id === "setting_subtitle_display",
        )

        if (switcher && !switcher.switch) switcher.$html?.click?.()

        return switcher?.tooltip
      },
    })

    function setSubtitleVisible(visible: boolean) {
      const type = isEnhanceAssMode ? "ass" : "webvtt"

      switch (type) {
        case "ass":
          player.subtitle.show = false
          player.emit("artplayer-plugin-ass:visible" as any, visible)
          break

        case "webvtt":
        default:
          player.subtitle.show = visible
          player.emit("artplayer-plugin-ass:visible" as any, false)
          break
      }
    }
  }

  if (danmu) {
    option.plugins?.push(
      artplayerPluginDanmuku({
        speed: 5,
        opacity: 1,
        fontSize: 25,
        mode: 0,
        antiOverlap: false,
        synchronousPlayback: false,
        theme: "dark",
        heatmap: true,
        ...safeJsonParse<Partial<DanmukuOption>>(
          localStorage.getItem("danmuku_config"),
        ),
        emitter: false,
        danmuku: proxyLink(danmu, true),
      }),
    )
  }

  onMount(async () => {
    if (disposed) return

    player = new Artplayer(option)
    // 暴露给自定义内容脚本（Ctrl + 滚轮调节音量等）使用
    ;(window as any).art = player
    floatingPlayer = new FloatingPlayer(player, (enabled) => {
      applyFloatUI(enabled)
    })
    // 若持久化状态为浮窗，启动后同步按钮图标
    player.once("ready", () => applyFloatUI(floatingPlayer.enabled))
    // 应用持久化的循环状态到原生 video.loop
    loopEnabled = localStorage.getItem(LOOP_KEY) === "true"
    player.once("ready", syncLoop)
    // 收藏状态可能在收藏列表异步加载后才准确，ready 后再同步一次图标
    player.once("ready", applyFavoriteUI)
    const auto_fullscreen = searchParams["auto_fullscreen"] === "true"
    // 浏览器要求 Fullscreen 必须由用户手势触发，ready 回调里自动进入全屏可能被拒绝；
    // 这里仅在允许时尝试，并吞掉异常，避免切换视频时报错。
    if (auto_fullscreen) {
      const enterFullscreen = () => {
        try {
          player.fullscreen = true
        } catch (e) {
          console.log("Auto fullscreen rejected by browser:", e)
        }
      }
      player.once("ready", enterFullscreen)
    }
    if (danmu) {
      player.on("artplayerPluginDanmuku:config", (option) => {
        const {
          speed,
          margin,
          opacity,
          mode,
          modes,
          fontSize,
          antiOverlap,
          synchronousPlayback,
          heatmap,
          visible,
        } = option as DanmukuOption
        localStorage.setItem(
          "danmuku_config",
          JSON.stringify({
            speed,
            margin,
            opacity,
            mode,
            modes,
            fontSize,
            antiOverlap,
            synchronousPlayback,
            heatmap,
            visible,
          }),
        )
      })
    }
    // 静音启动：恢复持久化状态并应用到播放器
    muteOnStartEnabled = localStorage.getItem(MUTE_ON_START_KEY) === "true"
    renderMuteSwitchLabel()
    if (muteOnStartEnabled) {
      player.once("ready", () => {
        if (player?.video) player.muted = true
      })
      player.muted = true
    }
    // 滚轮切集：恢复持久化状态并绑定监听（监听在播放器根元素上，浮窗的 wheel 会转发到这里）
    wheelSwitchEnabled = localStorage.getItem(WHEEL_SWITCH_KEY) === "true"
    const $playerEl = player.template.$player as HTMLElement | undefined
    $playerEl?.addEventListener("wheel", onPlayerWheel, { passive: false })
    // 提前回绕：每次时间推进时检查是否接近结尾
    player.video.addEventListener("timeupdate", tryRewindForLoop)
    // seek 完成后复位标记，允许下一轮再次触发
    player.video.addEventListener("seeked", () => {
      loopRewinding = false
    })
    // 兜底：若因极短音频/浏览器行为错过了提前回绕，ended 时再回绕一次
    player.on("video:ended", () => {
      if (loopEnabled) {
        loopRewinding = false
        player.video.currentTime = 0
        player.video.play().catch(() => {})
        return
      }
      if (!autoNext()) return
      next_video()
    })
    player.on("error", () => {
      if (player.video.crossOrigin) {
        console.log(
          "Error detected. Trying to remove Cross-Origin attribute. Screenshot may not be available.",
        )
        player.video.crossOrigin = null
      }
    })
  })
  onCleanup(() => {
    disposed = true
    // 清理全局实例引用，避免自定义脚本持有已销毁的播放器
    if ((window as any).art === player) {
      ;(window as any).art = undefined
    }
    if (wheelLockTimer !== undefined) {
      window.clearTimeout(wheelLockTimer)
      wheelLockTimer = undefined
    }
    const $playerEl = player?.template?.$player as HTMLElement | undefined
    $playerEl?.removeEventListener("wheel", onPlayerWheel)
    if (player?.video) {
      player.video.removeEventListener("timeupdate", tryRewindForLoop)
    }
    closeEpisodePanel()
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
    floatingPlayer?.destroy()
    // 先销毁播放器（会处理 video.src），再销毁自定义类型播放器
    player?.destroy()
    flvPlayer?.destroy()
    hlsPlayer?.destroy()
  })
  const [autoNext, setAutoNext] = createSignal()
  return (
    <VideoBox onAutoNextChange={setAutoNext}>
      <Box w="$full" h="60vh" id="video-player" />
    </VideoBox>
  )
}

export default Preview
