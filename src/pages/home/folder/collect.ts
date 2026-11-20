import { collectToFavorite, removeFavorite } from "~/utils/api"
import {
  addFavoriteEntry,
  findFavorite,
  FAVORITE_MOUNT,
  inFavoriteMount,
  isPathInFolder,
  removeFavoriteEntry,
  setPathInFolder,
} from "~/store"
import { pathJoin, notify } from "~/utils"
import { Resp, StoreObj } from "~/types"
import { useT } from "~/hooks"

/** 普通目录下的收藏源路径（目录 + 名称）。 */
export const favoritePath = (dir: string, obj: StoreObj) =>
  pathJoin(dir, obj.name)

/** 当前对象是否已收藏（自动区分普通目录与收藏目录）。 */
export const isObjFavorite = (dir: string, obj: StoreObj) => {
  return !!findFavorite(dir, obj.name)
}

/**
 * 切换单个对象的收藏状态：已收藏则取消，未收藏则加入。
 * - 在普通目录内：源路径 = 目录 + 名称。
 * - 在收藏目录内：通过显示名反查真实源路径后再取消。
 * 返回操作后的收藏状态；失败时返回原状态。
 */
export const toggleObjFavorite = async (
  dir: string,
  obj: StoreObj,
): Promise<boolean> => {
  const t = useT()
  const existing = findFavorite(dir, obj.name)
  const favorited = !!existing
  // 取消收藏时必须使用真实源路径；收藏时普通目录下用目录拼接。
  const src = existing ? existing.path : favoritePath(dir, obj)
  const displayName = existing ? existing.name : obj.name
  try {
    const resp: Resp<unknown> = favorited
      ? await removeFavorite(src)
      : await collectToFavorite(src, displayName)
    if (resp.code === 200) {
      if (favorited) {
        removeFavoriteEntry(src)
      } else {
        addFavoriteEntry(src, displayName)
      }
      return !favorited
    }
    notify.error(resp.message || t("home.toolbar.collect_failed"))
  } catch (err) {
    notify.error(
      t("home.toolbar.collect_failed_reason", { error: String(err) }),
    )
  }
  return favorited
}

/**
 * 把对象收藏到指定收藏夹（二级收藏夹就是 /收藏 下不同 Alias 挂载点）。
 * 返回操作后的状态：true = 已收藏到该夹。
 */
export const collectToFolder = async (
  dir: string,
  obj: StoreObj,
  mountPath: string,
): Promise<boolean> => {
  const t = useT()
  const src = favoritePath(dir, obj)
  const target = mountPath || FAVORITE_MOUNT
  // 先判断当前状态，决定这一下是"加入"还是"取消"；状态要在 API 调用前锁定，
  // 否则调用后本地集合已更新，再判断就会得到相反的结果。
  const wasFavorited =
    isPathInFolder(target, src) ||
    (target === FAVORITE_MOUNT && isObjFavorite(dir, obj))
  try {
    const resp: Resp<unknown> = wasFavorited
      ? await removeFavorite(src, target)
      : await collectToFavorite(src, obj.name, target)
    if (resp.code === 200) {
      const added = !wasFavorited
      setPathInFolder(target, src, added)
      if (target === FAVORITE_MOUNT) {
        if (added) addFavoriteEntry(src, obj.name)
        else removeFavoriteEntry(src)
      }
      return added
    }
    notify.error(resp.message || t("home.toolbar.collect_failed"))
  } catch (err) {
    notify.error(
      t("home.toolbar.collect_failed_reason", { error: String(err) }),
    )
  }
  return wasFavorited
}

/** 当前目录是否位于收藏挂载目录内（收藏目录里的取消操作需要特殊处理）。 */
export const isInFavoriteMount = (dir: string) => inFavoriteMount(dir)
