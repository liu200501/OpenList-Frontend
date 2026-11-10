import { collectToFavorite, removeFavorite } from "~/utils/api"
import {
  addFavoriteEntry,
  findFavorite,
  inFavoriteMount,
  removeFavoriteEntry,
} from "~/store"
import { pathJoin, notify } from "~/utils"
import { Resp, StoreObj } from "~/types"

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
    notify.error(resp.message || "收藏操作失败")
  } catch (err) {
    notify.error(`收藏操作失败: ${err}`)
  }
  return favorited
}

/** 当前目录是否位于收藏挂载目录内（收藏目录里的取消操作需要特殊处理）。 */
export const isInFavoriteMount = (dir: string) => inFavoriteMount(dir)
