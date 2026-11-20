import { Menu, Item, Submenu } from "solid-contextmenu"
import { useCopyLink, useDownload, useLink, useRouter, useT } from "~/hooks"
import "solid-contextmenu/dist/style.css"
import { HStack, Icon, Text, useColorMode, Image } from "@hope-ui/solid"
import { operations } from "../toolbar/operations"
import { createMemo, For, Show } from "solid-js"
import { bus, convertURL, notify, pathJoin, torrentParse } from "~/utils"
import { ObjType, UserMethods } from "~/types"
import {
  getSettingBool,
  haveSelected,
  me,
  objStore,
  oneChecked,
  selectedObjs,
  userCan,
} from "~/store"
import { players } from "../previews/video_box"
import { getPreviews } from "../previews"
import { BsPlayCircleFill } from "solid-icons/bs"
import { FaRegularStar, FaSolidStar } from "solid-icons/fa"
import { isArchive } from "~/store/archive"
import { favoriteFolders, isPathInFolder } from "~/store"
import {
  collectToFolder,
  favoritePath,
  isObjFavorite,
  toggleObjFavorite,
} from "./collect"
import axios from "axios"

const ItemContent = (props: { name: string }) => {
  const t = useT()
  return (
    <HStack spacing="$2">
      <Icon
        p={operations[props.name].p ? "$1" : undefined}
        as={operations[props.name].icon}
        boxSize="$7"
        color={operations[props.name].color}
      />
      <Text>{t(`home.toolbar.${props.name}`)}</Text>
    </HStack>
  )
}

export const ContextMenu = () => {
  const t = useT()
  const { colorMode } = useColorMode()
  const { copySelectedRawLink, copySelectedPreviewPage } = useCopyLink()
  const { batchDownloadSelected, sendToAria2, playlistDownloadSelected } =
    useDownload()
  const canPackageDownload = () => {
    return UserMethods.is_admin(me()) || getSettingBool("package_download")
  }
  const { rawLink } = useLink()
  const { isShare, pushHref, to, pathname } = useRouter()
  // 当前选中项是否都已收藏（用于决定切换方向）。
  const selectedAllFavorited = () => {
    const objs = selectedObjs()
    if (objs.length === 0) return false
    const dir = pathname()
    return objs.every((obj) => isObjFavorite(dir, obj))
  }
  // 单击"收藏"：直接收藏/取消到默认根目录 /收藏。
  const toggleCollect = async () => {
    const objs = selectedObjs()
    if (objs.length === 0) return
    const dir = pathname()
    const unfavorite = selectedAllFavorited()
    let okCount = 0
    for (const obj of objs) {
      const favorited = isObjFavorite(dir, obj)
      // 取消时只处理已收藏的，加入时只处理未收藏的。
      if (unfavorite !== favorited) continue
      const now = await toggleObjFavorite(dir, obj)
      if (now !== favorited) okCount++
    }
    if (okCount > 0) notify.success(`${t("home.toolbar.collect")} (${okCount})`)
  }
  const openWithPreviews = createMemo(() => {
    const objs = selectedObjs()
    if (objs.length !== 1) return []
    const obj = objs[0]
    if (obj.is_dir) return []
    return getPreviews({ ...obj, provider: objStore.provider })
    // .filter((p) => p.key !== "download")
  })
  return (
    <Menu
      id={1}
      animation="scale"
      theme={colorMode() !== "dark" ? "light" : "dark"}
      style="z-index: var(--hope-zIndices-popover)"
    >
      <Show when={openWithPreviews().length > 0}>
        <Submenu label={<ItemContent name="open_with" />}>
          <For each={openWithPreviews()}>
            {(preview) => (
              <Item
                onClick={({ props }) => {
                  to(`${pushHref(props.name)}?preview=${preview.key}`)
                }}
              >
                {preview.name}
              </Item>
            )}
          </For>
        </Submenu>
      </Show>
      <For each={["rename", "move", "copy", "delete"] as const}>
        {(name) => (
          <Item
            hidden={!userCan(name) || !objStore.write || isShare()}
            onClick={() => {
              bus.emit("tool", name)
            }}
          >
            <ItemContent name={name} />
          </Item>
        )}
      </For>
      <Item
        hidden={!userCan("share") || isShare()}
        onClick={() => {
          bus.emit("tool", "share")
        }}
      >
        <ItemContent name="share" />
      </Item>
      {/* 收藏到...：单击 label 放进收藏根目录 /收藏；hover 展开后点二级夹放进对应夹 */}
      <Submenu
        hidden={isShare() || !objStore.write}
        label={
          <HStack
            spacing="$2"
            onClick={(e) => {
              // 阻止冒泡到 Submenu，避免点击 label 触发菜单开合；submenu 靠 hover 展开。
              e.stopPropagation()
              toggleCollect()
            }}
          >
            <Icon
              as={selectedAllFavorited() ? FaSolidStar : FaRegularStar}
              boxSize="$7"
              color={
                selectedAllFavorited() ? operations.collect.color : "$neutral8"
              }
            />
            <Text>{t("home.toolbar.collect_to")}</Text>
          </HStack>
        }
      >
        <For each={favoriteFolders()}>
          {(folder) => {
            const favorited = () =>
              selectedObjs().length > 0 &&
              selectedObjs().every((obj) =>
                isPathInFolder(folder.mountPath, favoritePath(pathname(), obj)),
              )
            return (
              <Item
                onClick={async () => {
                  const objs = selectedObjs()
                  if (objs.length === 0) return
                  const remove = favorited()
                  let okCount = 0
                  for (const obj of objs) {
                    const now = await collectToFolder(
                      pathname(),
                      obj,
                      folder.mountPath,
                    )
                    if (now !== remove) okCount++
                  }
                  if (okCount > 0) {
                    notify.success(`${folder.name} (${okCount})`)
                  }
                }}
              >
                <HStack spacing="$2">
                  <Icon
                    as={favorited() ? FaSolidStar : FaRegularStar}
                    boxSize="$5"
                    color={favorited() ? operations.collect.color : "$neutral8"}
                  />
                  <Text>{folder.name}</Text>
                </HStack>
              </Item>
            )
          }}
        </For>
      </Submenu>
      <Item
        hidden={() => {
          return (
            isShare() ||
            !userCan("decompress") ||
            !objStore.write ||
            selectedObjs().some((o) => o.is_dir) ||
            selectedObjs().some((o) => !isArchive(o.name))
          )
        }}
        onClick={() => {
          bus.emit("tool", "decompress")
        }}
      >
        <ItemContent name="decompress" />
      </Item>
      <Item
        hidden={() => {
          return (
            isShare() ||
            !userCan("offline_download") ||
            !objStore.write ||
            !oneChecked() ||
            selectedObjs().some((o) => o.is_dir) ||
            !selectedObjs().every((o) =>
              o.name.toLowerCase().endsWith(".torrent"),
            )
          )
        }}
        onClick={async () => {
          const obj = selectedObjs()[0]
          if (!obj) return
          try {
            // 获取 torrent 文件的下载链接并下载内容
            const link = rawLink(obj, false)
            const resp = await axios.get(link, { responseType: "arraybuffer" })
            const buffer = resp.data as ArrayBuffer
            const bytes = new Uint8Array(buffer)
            let binary = ""
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i])
            }
            const base64Data = btoa(binary)

            // 调用解析 API
            const parseResp = await torrentParse(base64Data)
            if (parseResp.code === 200) {
              bus.emit("torrent_parsed", {
                torrentData: base64Data,
                info: parseResp.data,
              })
            } else {
              notify.error(
                parseResp.message || t("home.toolbar.parse_torrent_failed"),
              )
            }
          } catch (err) {
            notify.error(
              t("home.toolbar.parse_torrent_failed_reason", {
                error: String(err),
              }),
            )
          }
        }}
      >
        <ItemContent name="offline_download_torrent" />
      </Item>
      <Show when={oneChecked()}>
        <Item
          onClick={({ props }) => {
            if (props.is_dir) {
              copySelectedPreviewPage()
            } else {
              copySelectedRawLink(true)
            }
          }}
        >
          <ItemContent name="copy_link" />
        </Item>
        <Item
          onClick={({ props }) => {
            if (props.is_dir) {
              if (!canPackageDownload()) {
                notify.warning(t("home.toolbar.package_download_disabled"))
                return
              }
              bus.emit("tool", "package_download")
            } else {
              batchDownloadSelected()
            }
          }}
        >
          <ItemContent name="download" />
        </Item>
        <Submenu
          hidden={({ props }) => {
            return props.type !== ObjType.VIDEO
          }}
          label={
            <HStack spacing="$2">
              <Icon
                as={BsPlayCircleFill}
                boxSize="$7"
                p="$0_5"
                color="$info9"
              />
              <Text>{t("home.preview.play_with")}</Text>
            </HStack>
          }
        >
          <For each={players}>
            {(player) => (
              <Item
                onClick={({ props }) => {
                  const href = convertURL(player.scheme, {
                    raw_url: "",
                    name: props.name,
                    d_url: rawLink(props, true),
                  })
                  window.open(href, "_self")
                }}
              >
                <HStack spacing="$2">
                  <Image
                    m="0 auto"
                    boxSize="$7"
                    src={`${window.__dynamic_base__}/images/${player.icon}.webp`}
                  />
                  <Text>{player.name}</Text>
                </HStack>
              </Item>
            )}
          </For>
        </Submenu>
      </Show>
      <Show when={!oneChecked() && haveSelected()}>
        <Submenu label={<ItemContent name="copy_link" />}>
          <Item onClick={copySelectedPreviewPage}>
            {t("home.toolbar.preview_page")}
          </Item>
          <Item onClick={() => copySelectedRawLink()}>
            {t("home.toolbar.down_link")}
          </Item>
          <Item onClick={() => copySelectedRawLink(true)}>
            {t("home.toolbar.encode_down_link")}
          </Item>
        </Submenu>
        <Submenu label={<ItemContent name="download" />}>
          <Item onClick={batchDownloadSelected}>
            {t("home.toolbar.batch_download")}
          </Item>
          <Show
            when={
              UserMethods.is_admin(me()) || getSettingBool("package_download")
            }
          >
            <Item onClick={() => bus.emit("tool", "package_download")}>
              {t("home.toolbar.package_download")}
            </Item>
            <Item onClick={playlistDownloadSelected}>
              {t("home.toolbar.playlist_download")}
            </Item>
          </Show>
          <Item onClick={sendToAria2}>{t("home.toolbar.send_aria2")}</Item>
        </Submenu>
      </Show>
    </Menu>
  )
}
