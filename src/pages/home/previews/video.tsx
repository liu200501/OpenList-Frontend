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
import {
  requestTranscodePlay,
  type TranscodePlayResult,
} from "~/utils/transcode"
import { fetchDanmaku, type DanmuItem } from "~/utils/danmaku_parser"

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
  const NEED_RELOAD_EXTS = ["flv", "ts", "m2ts", "m3u8"]
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
  // 转码返回的轨道信息（多音轨/多视频轨/内嵌字幕），用于生成切换菜单
  let transcodeTracks: TranscodePlayResult | undefined
  let transcodeMenusApplied = false
  // 播放端齿轮开关：视频/音频是否转码。切换时用新的组合重新申请转码流。
  let videoTranscodeOn = true
  let audioTranscodeOn = true
  // 原始直链 url，齿轮切换转码关时回退到这里
  const directUrl = objStore.raw_url

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
      floatingPlayer.enabled
        ? t("home.preview.float_on")
        : t("home.preview.float_off"),
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
    notify.info(
      loopEnabled ? t("home.preview.loop_on") : t("home.preview.loop_off"),
    )
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
      ? t("home.preview.wheel_switch_on")
      : t("home.preview.wheel_switch_off")
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
    notify.info(
      on
        ? t("home.preview.wheel_switch_enabled")
        : t("home.preview.wheel_switch_disabled"),
    )
  }

  // ── 总是静音启动开关 ──
  // 开启后：每次（含切集）启动播放器都默认静音；关闭恢复正常音量启动。
  const MUTE_ON_START_KEY = "video_mute_on_start"
  let muteOnStartEnabled = localStorage.getItem(MUTE_ON_START_KEY) === "true"
  const muteSwitchLabelEl = document.createElement("span")
  const renderMuteSwitchLabel = () => {
    muteSwitchLabelEl.textContent = muteOnStartEnabled
      ? t("home.preview.mute_start_on")
      : t("home.preview.mute_start_off")
  }
  renderMuteSwitchLabel()
  const setMuteOnStart = (on: boolean) => {
    muteOnStartEnabled = on
    localStorage.setItem(MUTE_ON_START_KEY, String(on))
    renderMuteSwitchLabel()
    // 立即把当前播放器同步到目标状态，避免开关后无反馈
    if (player?.video) player.muted = on
    notify.info(
      on
        ? t("home.preview.mute_start_enabled")
        : t("home.preview.mute_start_disabled"),
    )
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
    header.textContent = t("home.preview.episodes_header", {
      total: list.length,
    })
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
        tooltip: t("home.preview.previous"),
        click: function () {
          previous_video()
        },
      },
      {
        name: "next-button",
        index: 11,
        position: "left",
        html: '<svg fill="none" stroke-width="2" xmlns="http://www.w3.org/2000/svg" height="22" width="22" class="icon icon-tabler icon-tabler-player-track-next-filled" width="1em" height="1em" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="overflow: visible; color: currentcolor;"><path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M2 5v14c0 .86 1.012 1.318 1.659 .753l8 -7a1 1 0 0 0 0 -1.506l-8 -7c-.647 -.565 -1.659 -.106 -1.659 .753z" stroke-width="0" fill="currentColor"></path><path d="M13 5v14c0 .86 1.012 1.318 1.659 .753l8 -7a1 1 0 0 0 0 -1.506l-8 -7c-.647 -.565 -1.659 -.106 -1.659 .753z" stroke-width="0" fill="currentColor"></path></svg>',
        tooltip: t("home.preview.next"),
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
        tooltip: t("home.preview.loop"),
        click: function () {
          toggleLoop()
        },
      },
      {
        name: "episode-button",
        index: 9,
        position: "right",
        html: EPISODE_LIST_ICON,
        tooltip: t("home.preview.episodes"),
        click: function () {
          openEpisodePanel()
        },
      },
      {
        name: "float-button",
        index: 14,
        position: "right",
        html: FLOAT_OFF_ICON,
        tooltip: t("home.preview.float_window"),
        click: function () {
          toggleFloat()
        },
      },
      {
        name: "custom-screenshot",
        index: 13,
        position: "right",
        html: '<svg xmlns="http://www.w3.org/2000/svg" height="22" width="22" viewBox="0 0 50 50"><path d="M 19.402344 6 C 17.019531 6 14.96875 7.679688 14.5 10.011719 L 14.097656 12 L 9 12 C 6.238281 12 4 14.238281 4 17 L 4 38 C 4 40.761719 6.238281 43 9 43 L 41 43 C 43.761719 43 46 40.761719 46 38 L 46 17 C 46 14.238281 43.761719 12 41 12 L 35.902344 12 L 35.5 10.011719 C 35.03125 7.679688 32.980469 6 30.597656 6 Z M 25 17 C 30.519531 17 35 21.480469 35 27 C 35 32.519531 30.519531 37 25 37 C 19.480469 37 15 32.519531 15 27 C 15 21.480469 19.480469 17 25 17 Z M 25 19 C 20.589844 19 17 22.589844 17 27 C 17 31.410156 20.589844 35 25 35 C 29.410156 35 33 31.410156 33 27 C 33 22.589844 29.410156 19 25 19 Z"></path></svg>',
        tooltip: t("home.preview.screenshot"),
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
      // .ts（标准 MPEG-TS，188 字节包）走 mpegts.js 的 m2ts demuxer。
      // mpegts.createPlayer 不接受 type:"ts"（会落到 NativePlayer 并抛错），
      // 复用 m2ts handler 即可正确解复用 TS 流。
      ts: function (video: HTMLMediaElement, url: string) {
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
        html: t("home.preview.subtitle_display"),
        tooltip: t("home.preview.show"),
        switch: true,
        onSwitch: function (item: Setting) {
          item.tooltip = item.switch
            ? t("home.preview.hide")
            : t("home.preview.show")
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
      html: t("home.preview.subtitle"),
      tooltip: t("home.preview.show"),
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

  // 【弹幕】用自写解析器先把 XML 解析成弹幕数组，再交给插件。
  // 不走插件内置的 URL 正则解析：它对 danmuji 抖音直播 XML 里的
  // <douyin_pk timestamp="..."> 会误吞后续 <d> 弹幕，造成约 8% 弹幕丢失。
  // 解析结果放到 this 作用域变量，onMount 里 fetch 完再喂给插件实例。
  let danmuList: DanmuItem[] = []
  if (danmu) {
    const persisted = safeJsonParse<Partial<DanmukuOption>>(
      localStorage.getItem("danmuku_config"),
    )
    option.plugins?.push(
      artplayerPluginDanmuku({
        speed: 5,
        opacity: 1,
        fontSize: 25,
        mode: 0,
        antiOverlap: false,
        // 倍速时弹幕滚动速度跟随播放速率，避免"画面快、弹幕慢"的不同步感
        synchronousPlayback: persisted?.synchronousPlayback ?? true,
        theme: "dark",
        heatmap: true,
        ...persisted,
        emitter: false,
        // 传空数组：解析完后在 onMount 里用实例的 load() 灌入，
        // 这样能精确控制加载时机（播放器 ready 之后）。
        danmuku: [],
      }),
    )
  }

  // 申请转码流：按当前齿轮开关向后端要 master_url；失败返回 null 走直链。
  // 初始化与齿轮切换"视频转码/音频转码"共用这段逻辑。
  const fetchTranscodePlay = async (videoOn: boolean, audioOn: boolean) => {
    try {
      const resp = await requestTranscodePlay(pathname(), videoOn, audioOn)
      if (resp.code === 200 && resp.data?.transcode && resp.data.master_url) {
        console.log(
          `[transcode] 使用转码播放: job=${resp.data.job_id}, 视频转码=${videoOn}, 音频转码=${audioOn}, 音轨=${(resp.data.audio_tracks ?? []).length}, 视频轨=${(resp.data.video_tracks ?? []).length}, 字幕=${(resp.data.subtitles ?? []).length}`,
        )
        return resp.data
      }
      console.log(
        `[transcode] 无需转码或转码不可用: ${resp.data?.reason ?? resp.code}`,
      )
    } catch (err) {
      console.warn("[transcode] 转码探测失败，降级为直链播放", err)
    }
    return null
  }

  // 齿轮切换视频/音频转码开关后：重新申请对应组合的转码流并切换播放地址。
  // 关掉两路时直接回到原始直链。切流保留当前播放进度。
  const switchTranscodeStream = async (videoOn: boolean, audioOn: boolean) => {
    const result = await fetchTranscodePlay(videoOn, audioOn)
    if (disposed || !player) return
    const resumeAt = player.currentTime
    transcodeTracks = result ?? undefined
    transcodeMenusApplied = false
    if (result) {
      player.switchUrl(result.master_url!)
    } else {
      player.switchUrl(directUrl)
    }
    // 新流重新挂载轨道/字幕菜单，并尽量恢复进度
    player.once("ready", () => {
      applyTranscodeTrackMenus()
      if (resumeAt > 0) {
        try {
          player.currentTime = resumeAt
        } catch (_) {
          /* 新流尚未缓冲到该位置，忽略 */
        }
      }
    })
  }

  // 【转码多轨】把后端返回的轨道信息渲染为 Artplayer 设置菜单：
  //   音轨 → hls audioTrack（或 Safari 原生 audioTracks）
  //   视频轨 → hls currentLevel（每条视频轨对应一个 variant）
  //   内嵌字幕 → 后端按需转出的 WebVTT，直接交给 Artplayer 的字幕模块
  const trackLabel = (name: string, codec?: string) => {
    if (!codec) return name
    const c = codec.toUpperCase()
    return `${name} · ${c}`
  }
  const applyTranscodeTrackMenus = () => {
    if (!player || !transcodeTracks || transcodeMenusApplied) return
    transcodeMenusApplied = true
    const audioTracks = transcodeTracks.audio_tracks ?? []
    const videoTracks = transcodeTracks.video_tracks ?? []
    const subs = transcodeTracks.subtitles ?? []

    // 音轨切换：后端把每条音轨单独编码成 AAC rendition，master 里是 EXT-X-MEDIA 音频组
    if (audioTracks.length > 1) {
      player.setting.add({
        id: "setting_audio_track",
        html: "音轨",
        selector: audioTracks.map((tr, i) => ({
          html: trackLabel(tr.name, tr.codec),
          value: i,
          default: i === 0,
        })),
        onSelect(item: any) {
          const idx = Number(item.value)
          if (hlsPlayer?.audioTracks?.length) {
            // hls.js 的 audioTracks 顺序与后端 audio_tracks（v0..vN 对应的 a0..aM）
            // 一致，但 id 未必等于数组下标：先按下标取到真实 id，再赋值，
            // 越界时回退到第一条，避免 audioTrack=-1 导致音轨全部静音。
            const target =
              hlsPlayer.audioTracks[idx] ?? hlsPlayer.audioTracks[0]
            if (target) hlsPlayer.audioTrack = target.id
          } else {
            // Safari 原生 HLS：直接操作 audioTracks
            const native = player!.video as HTMLVideoElement & {
              audioTracks?: any
            }
            const list = native.audioTracks
            if (list) {
              for (let i = 0; i < list.length; i++) list[i].enabled = i === idx
            }
          }
          return item.html
        },
      })
    }

    // 视频轨切换：多条视频轨 = master 里的多个 variant（level）
    // 注意：菜单的添加条件不能依赖 hlsPlayer——本函数在 ArtPlayer 构造后立即调用，
    // 此时 customType.m3u8 可能尚未创建 hlsPlayer；只在 onSelect 触发时才需要它。
    if (videoTracks.length > 1) {
      player.setting.add({
        id: "setting_video_track",
        html: "视频轨",
        selector: videoTracks.map((tr, i) => ({
          html: trackLabel(tr.name, tr.codec),
          value: i,
          default: i === 0,
        })),
        onSelect(item: any) {
          const idx = Number(item.value)
          if (hlsPlayer && idx >= 0 && idx < hlsPlayer.levels.length) {
            hlsPlayer.currentLevel = idx
          }
          return item.html
        },
      })
    }

    // 内嵌字幕：按需从后端抽取为 WebVTT（图形字幕不会出现在列表里）
    if (subs.length > 0) {
      player.setting.add({
        id: "setting_embedded_subtitle",
        html: "内嵌字幕",
        selector: [
          { html: "关闭", value: -1, default: !option.subtitle },
          ...subs.map((s, i) => ({ html: s.name, value: i, default: false })),
        ],
        onSelect(item: any) {
          const idx = Number(item.value)
          if (idx < 0) {
            player!.subtitle.show = false
            return "关闭"
          }
          const sub = subs[idx]
          player!.subtitle.show = true
          player!.subtitle.switch(sub.url, { name: sub.name } as any)
          return sub.name
        },
      })
    }
  }

  // 齿轮里的通用菜单：视频/音频转码开关 + 自定义字幕。
  // 与轨道菜单分开挂载——即使当前文件没触发转码，这两个能力也要可用。
  let commonMenusApplied = false
  const applyCommonMenus = () => {
    if (!player || commonMenusApplied) return
    commonMenusApplied = true

    // 视频转码开关：开=按设置的分辨率/码率重编码（可切视频轨）；关=视频流 copy
    player.setting.add({
      id: "setting_video_transcode",
      html: "视频转码",
      tooltip: videoTranscodeOn ? "开" : "关",
      switch: videoTranscodeOn,
      onSwitch: function (item: any) {
        item.switch = !item.switch
        videoTranscodeOn = item.switch
        item.tooltip = item.switch ? "开" : "关"
        switchTranscodeStream(videoTranscodeOn, audioTranscodeOn)
        return item.switch
      },
    })

    // 音频转码开关：开=把 DTS/AC3 等转成浏览器可识别的 AAC（可切音轨）；关=音频流 copy
    player.setting.add({
      id: "setting_audio_transcode",
      html: "音频转码",
      tooltip: audioTranscodeOn ? "开" : "关",
      switch: audioTranscodeOn,
      onSwitch: function (item: any) {
        item.switch = !item.switch
        audioTranscodeOn = item.switch
        item.tooltip = item.switch ? "开" : "关"
        switchTranscodeStream(videoTranscodeOn, audioTranscodeOn)
        return item.switch
      },
    })

    // 自定义字幕：输入一个字幕 URL（vtt/srt/ass）动态添加到字幕菜单
    let customSubCount = 0
    player.setting.add({
      id: "setting_custom_subtitle",
      html: "添加字幕",
      onClick: function () {
        const url = window.prompt("输入字幕地址（.vtt / .srt / .ass）：")
        if (!url || !url.trim()) return
        const u = url.trim()
        let name =
          u.split("/").pop()?.split("?")[0] || `自定义字幕 ${++customSubCount}`
        const isAss = ext(name).toLowerCase() === "ass"
        if (isAss) {
          player.emit("artplayer-plugin-ass:switch" as any, u)
          player.subtitle.show = false
        } else {
          player.subtitle.switch(u, { name } as any)
          player.once("subtitleLoad", () => (player.subtitle.show = true))
        }
        // 把自定义字幕追加进字幕菜单，方便切回
        const subMenu = player.setting.find?.("setting_subtitle")
        if (subMenu?.selector) {
          ;(subMenu.selector as any[]).push({ html: name, name, url: u })
        }
      },
    } as any)
  }

  onMount(async () => {
    if (disposed) return

    // 【弹幕】与转码探测并行拉取并解析 XML（自写解析器，兼容 danmuji 抖音直播）。
    // 两者都完成后再创建 player，避免插件加载时弹幕数组还是空的。
    const danmuReady = danmu
      ? fetchDanmaku(proxyLink(danmu, true))
      : Promise.resolve([])

    // 【转码接入】播放前先问后端是否需要转码（带上齿轮开关的默认状态）。
    // 后端按转码范围/阈值判断，并把 DTS/AC3 等浏览器不支持的音轨重编码为 AAC；
    // 需要转码时返回 master_url 走 hls.js；探测失败一律静默降级直链，不阻断播放。
    const initialTranscode = await fetchTranscodePlay(
      videoTranscodeOn,
      audioTranscodeOn,
    )
    if (initialTranscode) {
      transcodeTracks = initialTranscode
      option.url = initialTranscode.master_url!
      option.type = "m3u8"
    }
    // 等待转码响应期间用户可能已经离开页面：onCleanup 早已执行，
    // 此时再创建实例就没有人会销毁它，必须放弃初始化。
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
    // 转码多轨菜单：必须在构造后立即挂载，不能等 ready。
    // 转码首播要等 ffmpeg 切片，ready（首帧可播）可能几十秒都不触发，
    // 挂在 ready 上会导致换轨/字幕菜单永远不出现。
    // player.setting.add 不依赖 ready，构造后即可调用；customType 里创建的
    // hlsPlayer 也在构造期同步完成，音轨/视频轨的 onSelect 闭包到时再取用即可。
    applyTranscodeTrackMenus()
    // 齿轮通用菜单（视频/音频转码开关 + 自定义字幕）始终挂载，不依赖是否转码
    applyCommonMenus()
    // 兜底：若某些情况下构造期 setting 尚未就绪，ready 时再补一次（幂等）
    player.once("ready", applyTranscodeTrackMenus)
    player.once("ready", applyCommonMenus)

    // 【弹幕时间同步】B 站式：弹幕始终按它自己的 time 跟随视频时间轴显示。
    // 之前的实现在 seek 时把弹幕 time 篡改成了落点时刻并重新 emit，且暂停时
    // 插件 update 循环不发射（art.playing=false），导致"跳到时间点什么也看不到"。
    // 现在彻底删掉那套 hack：load 一次原始弹幕（time 原样），seek 时只清掉
    // 屏幕上还在飞的旧弹幕（reset），插件下一帧会按新的 currentTime 自动发射
    // time 落在落点的弹幕——全程不改 time、不重放，弹幕与进度始终一一对应。
    if (danmu) {
      const dPlugin = () =>
        (player as any).plugins?.artplayerPluginDanmuku as
          | {
              load: (d: DanmuItem[]) => Promise<void>
              reset: () => void
            }
          | undefined

      danmuReady.then(async (list) => {
        if (disposed) return
        danmuList = list
        const p = dPlugin()
        if (!p) return
        await p.load(danmuList)
        console.log(`[danmaku] loaded ${danmuList.length} items (self-parsed)`)
      })

      // seek / 快进：只清掉还在飞的旧弹幕，让弹幕重新对齐到新进度。
      // 不 emit、不改 time——插件依据弹幕自身 time 继续，落点处的弹幕会自动出现。
      player.on("video:seeked", () => {
        dPlugin()?.reset()
      })
    }
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
