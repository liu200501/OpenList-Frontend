import { createSignal } from "solid-js"
import { listCollects, FavoriteEntry } from "~/utils/api"

// 收藏挂载目录的默认路径。后端默认把收藏聚合到 "/收藏"。
export const FAVORITE_MOUNT = "/收藏"

// 收藏项集合：源路径 -> 显示名。
// 注意：在收藏目录下，后端返回的 obj.name 是“显示名”，而收藏记录的键是源路径，
// 两者并不相同，因此需要同时保留 name 才能正确判断收藏状态。
const [favoriteEntries, setFavoriteEntries] = createSignal<FavoriteEntry[]>([])

/** 判断当前是否位于收藏挂载目录（含子路径）。 */
export const inFavoriteMount = (dir: string): boolean => {
  const mount = FAVORITE_MOUNT.replace(/\/$/, "")
  return dir === mount || dir.startsWith(mount + "/")
}

/** 判断某个完整源路径是否已收藏。 */
export const isFavorite = (path: string): boolean => {
  return favoriteEntries().some((e) => e.path === path)
}

/**
 * 根据当前目录与对象名解析出对应的收藏记录。
 * - 在收藏目录内：按显示名匹配（obj.name 即收藏记录的显示名）。
 * - 在普通目录内：按 目录 + 名称 拼出的源路径匹配。
 */
export const findFavorite = (
  dir: string,
  name: string,
): FavoriteEntry | undefined => {
  const entries = favoriteEntries()
  if (inFavoriteMount(dir)) {
    return entries.find((e) => e.name === name)
  }
  const path = dir.replace(/\/$/, "") + "/" + name
  return entries.find((e) => e.path === path)
}

/** 判断当前目录下的某个对象是否已收藏。 */
export const isFavoriteObj = (dir: string, name: string): boolean => {
  return !!findFavorite(dir, name)
}

/** 本地新增收藏项（操作成功后调用，避免再请求后端）。 */
export const addFavoriteEntry = (path: string, name: string) => {
  setFavoriteEntries((prev) => {
    if (prev.some((e) => e.path === path)) return prev
    return [...prev, { path, name, line: `${name}:${path}` }]
  })
}

/** 本地移除收藏项。 */
export const removeFavoriteEntry = (path: string) => {
  setFavoriteEntries((prev) => prev.filter((e) => e.path !== path))
}

/** 从后端拉取收藏列表并刷新本地集合。 */
export const refreshFavorites = async () => {
  try {
    const resp = await listCollects()
    if (resp.code === 200 && Array.isArray(resp.data)) {
      setFavoriteEntries(resp.data)
    }
  } catch {
    // 静默失败，收藏状态不是核心功能
  }
}

export { favoriteEntries }
