import { createSignal } from "solid-js"
import {
  listCollects,
  listFineFavoriteFolders,
  FavoriteEntry,
} from "~/utils/api"

// 收藏挂载目录的默认路径。后端默认把收藏聚合到 "/收藏"。
export const FAVORITE_MOUNT = "/收藏"

// 收藏别名存储的占位根条目名。
// 后端为了解决「只收藏一条时 Alias 把唯一项当成根目录」的问题，
// 会在收藏存储的 paths 中固定写入一行 `__favorite_root__:/`。
// 该条目不是真实收藏，前端不应展示给用户。
export const FAVORITE_ROOT_PLACEHOLDER = "__favorite_root__"

/** 判断某个目录项是否为收藏占位根条目（需要在前端隐藏）。 */
export const isFavoritePlaceholder = (name: string): boolean =>
  name === FAVORITE_ROOT_PLACEHOLDER

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

// 每个收藏夹里已有的源路径集合，用于右键子菜单标记「已收藏到该夹」。
// key 是收藏夹挂载路径（/收藏 或 /收藏/子夹）。
const [folderFavoritePaths, setFolderFavoritePaths] = createSignal<
  Record<string, string[]>
>({})

/** 某个源路径是否已收藏到指定收藏夹。 */
export const isPathInFolder = (mountPath: string, path: string): boolean =>
  (folderFavoritePaths()[mountPath] ?? []).includes(path)

/** 更新某个收藏夹里的源路径集合（收藏/取消成功后调用）。 */
export const setPathInFolder = (
  mountPath: string,
  path: string,
  added: boolean,
) => {
  setFolderFavoritePaths((prev) => {
    const current = prev[mountPath] ?? []
    const next = added
      ? current.includes(path)
        ? current
        : [...current, path]
      : current.filter((p) => p !== path)
    return { ...prev, [mountPath]: next }
  })
}

/** 刷新时同步根目录的收藏成员关系（子夹暂不预取，只在操作后更新）。 */
export const syncFolderFavoritePaths = (entries: FavoriteEntry[]) => {
  setFolderFavoritePaths((prev) => ({
    ...prev,
    [FAVORITE_MOUNT]: entries.map((e) => e.path),
  }))
}

/** 一个可收藏到的目标收藏夹。 */
export interface FavoriteFolder {
  /** 收藏别名存储的挂载路径，传给 collect/remove API。 */
  mountPath: string
  /** 右键菜单里显示的名字。 */
  name: string
}

// 二级收藏夹列表：来自 /收藏 的 fine_favorites 配置。
// 只包含收藏夹，不含根目录 /收藏，也不含目录里的文件；
// 顺序严格按配置文本里的行顺序（后端已按该顺序返回）。
const [favoriteFolders, setFavoriteFolders] = createSignal<FavoriteFolder[]>([])

// 收藏夹列表变化很少，做 5 秒节流，避免每次列目录都额外请求一次。
let lastFolderRefresh = 0
/** 刷新可收藏到的收藏夹列表。 */
export const refreshFavoriteFolders = async (force = false) => {
  if (!force && Date.now() - lastFolderRefresh < 5000) return
  lastFolderRefresh = Date.now()
  try {
    const resp = await listFineFavoriteFolders()
    if (resp.code === 200 && Array.isArray(resp.data)) {
      const folders: FavoriteFolder[] = resp.data.map((f) => ({
        name: f.name,
        mountPath: f.mount_path,
      }))
      setFavoriteFolders(folders)
      // 拉取每个子夹里已收藏的源路径，右键子菜单才能正确标记 ✓。
      // 子夹数量由 fine_favorites 配置决定，通常很少，可并行拉取。
      await Promise.all(
        folders.map(async (folder) => {
          try {
            const listResp = await listCollects(folder.mountPath)
            if (listResp.code === 200 && Array.isArray(listResp.data)) {
              setFolderFavoritePaths((prev) => ({
                ...prev,
                [folder.mountPath]: listResp.data.map((e) => e.path),
              }))
            }
          } catch {
            // 单个子夹失败不影响其它
          }
        }),
      )
    }
  } catch {
    // 静默失败：收藏状态不是核心功能
  }
}

/** 从后端拉取收藏列表并刷新本地集合。 */
export const refreshFavorites = async () => {
  try {
    const resp = await listCollects()
    if (resp.code === 200 && Array.isArray(resp.data)) {
      setFavoriteEntries(resp.data)
      syncFolderFavoritePaths(resp.data)
    }
  } catch {
    // 静默失败，收藏状态不是核心功能
  }
  refreshFavoriteFolders()
}

export { favoriteEntries, favoriteFolders }
