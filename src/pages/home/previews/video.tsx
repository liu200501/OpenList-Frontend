import { Box } from "@hope-ui/solid"
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js"
import { useRouter, useLink } from "~/hooks"
import {
  getMainColor,
  getSettingBool,
  objStore,
  setShouldKeepState,
} from "~/store"
import { Obj, ObjType } from "~/types"
import { ext, pathDir, pathJoin } from "~/utils"
import Artplayer from "artplayer"
import { type Option } from "artplayer"
import { type Setting } from "artplayer"
import { type Events } from "artplayer"
import artplayerPluginDanmuku from "artplayer-plugin-danmuku"
import { type Option as DanmukuOption } from "artplayer-plugin-danmuku"
import artplayerPluginAss from "~/components/artplayer-plugin-ass"
import mpegts from "mpegts.js"
import Hls from "hls.js"
import { currentLang } from "~/app/i18n"
import { AutoHeightPlugin, VideoBox } from "./video_box"
import { ArtPlayerIconsSubtitle } from "~/components/icons"
import { useNavigate } from "@solidjs/router"
import "./artplayer.css"

/**
 * 解析 Danmuji / Bilibili 弹幕 XML，转换为 artplayer-plugin-danmuku 能识别的数组格式。
 * 关键点：显式提取每条弹幕的秒级时间，避免插件内置 XML 解析器在遇到
 * <RecorderXmlStyle>、<?xml-stylesheet?> 等非弹幕节点时把时间字段读废，
 * 导致所有弹幕时间归零（表现为“像水流一样不跟随进度条”）。
 */
const parseDanmakuXml = (xmlText: string) => {
  const result: {
    text: string
    time: number
    color: string
    mode: number
    border?: boolean
    style?: Record<string, string>
  }[] = []

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(xmlText, "text/xml")

    // 若 XML 解析失败，parsererror 节点会出现在文档里
    if (doc.getElementsByTagName("parsererror").length > 0) {
      console.warn("[danmuku] XML 解析失败")
      return result
    }

    const nodes = doc.getElementsByTagName("d")
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      const p = node.getAttribute("p")
      const text = (node.textContent || "").trim()
      if (!p || !text) continue

      const parts = p.split(",")
      const time = parseFloat(parts[0])
      if (!isFinite(time) || time < 0) continue

      // Danmuji 与 Bilibili 的 p 字段含义一致：
      // [0]=时间(秒) [1]=模式 [2]=字号 [3]=颜色(十进制) [4]=时间戳 ...
      const modeRaw = parseInt(parts[1] || "1", 10)
      const colorRaw = parseInt(parts[3] || "16777215", 10)

      // artplayer-plugin-danmuku 的 mode 约定：
      // 0=滚动 1=顶部 2=底部
      // Bilibili: 1/2/3 滚动, 4 底部, 5 顶部
      let mode = 0
      if (modeRaw === 4) mode = 2
      else if (modeRaw === 5) mode = 1
      else mode = 0

      const color =
        "#" +
        (isFinite(colorRaw) ? colorRaw : 16777215).toString(16).padStart(6, "0")

      result.push({
        text,
        time,
        color,
        mode,
      })
    }
  } catch (e) {
    console.warn("[danmuku] 解析异常", e)
  }

  return result
}

const Preview = () => {
  const { pathname, searchParams } = useRouter()
  const { proxyLink } = useLink()
  const navigate = useNavigate()
  const videos = createMemo(() =>
    objStore.objs.filter((obj) => obj.type === ObjType.VIDEO),
  )
  const next_video = () => {
    const index = videos().findIndex((f) => f.name === objStore.obj.name)
    if (index < videos().length - 1) {
      navigate(
        pathJoin(pathDir(location.pathname), videos()[index + 1].name) +
          "?auto_fullscreen=" +
          player.fullscreen,
      )
    }
  }
  const previous_video = () => {
    const index = videos().findIndex((f) => f.name === objStore.obj.name)
    if (index > 0) {
      navigate(
        pathJoin(pathDir(location.pathname), videos()[index - 1].name) +
          "?auto_fullscreen=" +
          player.fullscreen,
      )
    }
  }
  let player: Artplayer
  let flvPlayer: mpegts.Player
  let hlsPlayer: Hls
  let option: Option = {
    container: "#video-player",
    volume: 1.0,
    autoplay: getSettingBool("video_autoplay"),
    autoSize: false,
    autoMini: true,
    loop: false,
    flip: true,
    playbackRate: true,
    aspectRatio: true,
    screenshot: true,
    setting: true,
    hotkey: true,
    pip: true,
    mutex: true,
    fullscreen: true,
    fullscreenWeb: true,
    subtitleOffset: true,
    miniProgressBar: false,
    playsInline: true,
    theme: getMainColor(),
    // layers: [],
    // settings: [],
    // contextmenu: [],
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
    ],
    quality: [],
    // highlight: [],
    plugins: [AutoHeightPlugin],
    whitelist: [],
    settings: [],
    // subtitle:{}
    moreVideoAttr: {
      // @ts-ignore
      "webkit-playsinline": true,
      playsInline: true,
      crossOrigin: "anonymous",
    },
    customType: {
      flv: function (video: HTMLMediaElement, url: string) {
        flvPlayer?.destroy()
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
        hlsPlayer?.destroy()
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
    // 关闭长按快进（移动端长按改为全屏，避免冲突）
    fastForward: false,
    autoPlayback: true,
    autoOrientation: true,
    airplay: true,
  }
  const subtitleAndDanmu = createMemo(() => {
    const subtitle: Obj[] = []
    let danmu: Obj | undefined
    for (const obj of objStore.related) {
      const name = obj.name.toLowerCase()
      if (
        name.endsWith(".srt") ||
        name.endsWith(".ass") ||
        name.endsWith(".vtt")
      ) {
        subtitle.push(obj)
      } else if (!danmu && name.endsWith(".xml")) {
        danmu = obj
      }
    }
    return { subtitle, danmu }
  })

  // TODO: add a switch in manage panel to choose whether to enable `libass-wasm`
  const enableEnhanceAss = true

  const switchUrl = (url: string) => {
    const { playing } = player
    player.pause()
    player.option.id = pathname()
    player.option.type = ext(objStore.obj.name)
    player.switchUrl(url).finally(() => playing && player.play())

    const { subtitle, danmu } = subtitleAndDanmu()
    let isEnhanceAssMode = false
    const setSubtitleVisible = (visible: boolean) => {
      const type = isEnhanceAssMode ? "ass" : "webvtt"

      switch (type) {
        case "ass":
          player.subtitle.show = false
          player.emit("artplayer-plugin-ass:visible" as keyof Events, visible)
          break

        case "webvtt":
        default:
          player.subtitle.show = visible
          player.emit("artplayer-plugin-ass:visible" as keyof Events, false)
          break
      }
    }
    if (subtitle.length) {
      // render subtitle toggle menu
      const innerMenu: Setting[] = [
        {
          name: "setting_subtitle_display",
          html: "Display",
          tooltip: "Show",
          switch: true,
          onSwitch: function (item: Setting) {
            item.tooltip = item.switch ? "Hide" : "Show"
            setSubtitleVisible(!item.switch)

            // sync menu subtitle tooltip
            const menu_sub = this.setting.find("setting_subtitle")
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

      const onSelect = function (this: Artplayer, item: Setting) {
        if (enableEnhanceAss && ext(item.name).toLowerCase() === "ass") {
          isEnhanceAssMode = true
          if (!player.plugins.artplayerPluginAss) {
            player.plugins.add(artplayerPluginAss({ subUrl: item.url }))
          } else {
            this.emit("artplayer-plugin-ass:switch" as keyof Events, item.url)
          }
          setSubtitleVisible(true)
        } else {
          isEnhanceAssMode = false
          this.subtitle.switch(item.url, { name: item.name })
          this.once("subtitleLoad", setSubtitleVisible.bind(this, true))
        }

        const switcher = innerMenu.find(
          (_) => _.name === "setting_subtitle_display",
        )

        if (switcher && !switcher.switch) switcher.$html?.click?.()

        // sync from display switcher
        return switcher?.tooltip
      }
      player.setting.update({
        name: "setting_subtitle",
        html: "Subtitle",
        tooltip: "Show",
        icon: ArtPlayerIconsSubtitle({ size: 24 }) as HTMLElement,
        selector: innerMenu,
        onSelect,
      })
      onSelect.call(player, innerMenu[1])
    } else {
      player.setting.find("setting_subtitle") &&
        player.setting.remove("setting_subtitle")
      setSubtitleVisible(false)
    }

    // ============ 弹幕：手动拉取 XML 并解析为数组，交给插件 ============
    const danmukuPlugin = player.plugins.artplayerPluginDanmuku as ReturnType<
      ReturnType<typeof artplayerPluginDanmuku>
    >
    if (danmukuPlugin) {
      danmukuPlugin.reset()
      danmukuPlugin.option.danmuku = []
    }

    if (danmu) {
      const danmuUrl = proxyLink(danmu, true)
      // 先 fetch 原始 XML 文本，手动解析出带正确时间的弹幕数组，
      // 避免插件内置 XML 解析器把时间字段读废。
      fetch(danmuUrl)
        .then((resp) => {
          if (!resp.ok) throw new Error("danmuku fetch failed")
          return resp.text()
        })
        .then((xmlText) => {
          const parsed = parseDanmakuXml(xmlText)
          console.log("[danmuku] parsed count:", parsed.length)
          if (!parsed.length) return

          const existing = player.plugins.artplayerPluginDanmuku as ReturnType<
            ReturnType<typeof artplayerPluginDanmuku>
          >
          if (existing) {
            existing.reset()
            existing.option.danmuku = parsed as any
            existing.load()
          } else {
            player.plugins.add(
              artplayerPluginDanmuku({
                speed: 5,
                opacity: 1,
                fontSize: 25,
                mode: 0,
                antiOverlap: false,
                synchronousPlayback: false,
                theme: "dark",
                heatmap: true,
                ...JSON.parse(localStorage.getItem("danmuku_config") || "{}"),
                emitter: false,
                danmuku: parsed as any,
              }),
            )
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
        })
        .catch((e) => {
          console.warn("[danmuku] load failed", e)
        })
    }
  }

  // ============ 移动端触摸事件：单击播放/暂停，长按全屏 ============
  let longPressTimer: ReturnType<typeof setTimeout> | null = null
  let longPressTriggered = false
  const LONG_PRESS_DURATION = 500

  // 是否移动端（只在移动端启用自定义手势）
  const isMobile = () =>
    /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent) ||
    ("ontouchstart" in window && navigator.maxTouchPoints > 0)

  // 阻止长按弹出系统菜单
  const preventContextMenu = (e: Event) => {
    e.preventDefault()
  }

  const handleTouchStart = (e: TouchEvent) => {
    // 阻止浏览器默认长按行为（弹出菜单/选中文字）
    e.preventDefault()
    longPressTriggered = false
    longPressTimer = setTimeout(() => {
      longPressTriggered = true
      if (player) {
        player.fullscreen = !player.fullscreen
        // 如需网页全屏，改用：player.fullscreenWeb = !player.fullscreenWeb
      }
      longPressTimer = null
    }, LONG_PRESS_DURATION)
  }

  const handleTouchEnd = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
    // 已触发长按，松手不再执行单击
    if (longPressTriggered) {
      longPressTriggered = false
      return
    }
    // 单击：立即播放/暂停，无延迟
    if (player) {
      player.playing ? player.pause() : player.play()
    }
  }

  const handleTouchCancel = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
    longPressTriggered = false
  }

  onMount(() => {
    player = new Artplayer(option)
    createEffect(on(() => objStore.raw_url, switchUrl))
    let auto_fullscreen: boolean
    switch (searchParams["auto_fullscreen"]) {
      case "true":
        auto_fullscreen = true
      case "false":
        auto_fullscreen = false
      default:
        auto_fullscreen = false
    }
    player.on("ready", () => {
      player.fullscreen = auto_fullscreen
    })
    const onFullscreen = () =>
      setShouldKeepState(player.fullscreen || player.fullscreenWeb)
    player.on("fullscreen", onFullscreen)
    player.on("fullscreenWeb", onFullscreen)
    player.on("video:ended", () => {
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

    // 只在移动端启用自定义触摸手势
    if (isMobile() && player.video) {
      player.video.addEventListener("touchstart", handleTouchStart, {
        passive: false,
      })
      player.video.addEventListener("touchend", handleTouchEnd, {
        passive: false,
      })
      player.video.addEventListener("touchcancel", handleTouchCancel, {
        passive: false,
      })
      // 阻止长按弹出菜单
      player.video.addEventListener("contextmenu", preventContextMenu)
    }
  })

  onCleanup(() => {
    setShouldKeepState(false)
    if (player) {
      if (player.video && isMobile()) {
        player.video.removeEventListener("touchstart", handleTouchStart)
        player.video.removeEventListener("touchend", handleTouchEnd)
        player.video.removeEventListener("touchcancel", handleTouchCancel)
        player.video.removeEventListener("contextmenu", preventContextMenu)
      }
      player.fullscreenWeb = false
      player.fullscreen = false
      player.pip && (player.pip = false)
      player.destroy()
    }
    if (longPressTimer) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
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
