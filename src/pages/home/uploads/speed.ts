import { SetUpload } from "./types"

// 上传速度 / 剩余时间估算。
//
// 之前各个上传实现都自己维护 lastLoaded / lastTimestamp，并且要求
// `duration > 1` 才更新一次速度：
//   - 第一个 1 秒里速度一直是 0，小文件传完都看不到速度；
//   - 用「距上次更新」的累计平均，速度跳变明显。
// 这里改成指数滑动平均（EMA）：每 200ms 采样一次瞬时速度，
// 再平滑一下，既有即时反馈也不会抖。
const SAMPLE_INTERVAL_MS = 200
const EMA_WEIGHT = 0.3

export function createSpeedTracker(setUpload: SetUpload, total: number) {
  let lastTime = 0
  let lastLoaded = 0
  let ema = 0

  return (loaded: number) => {
    const now = performance.now()
    if (lastTime === 0) {
      lastTime = now
      lastLoaded = loaded
      return
    }
    const deltaTime = (now - lastTime) / 1000
    if (deltaTime * 1000 < SAMPLE_INTERVAL_MS) return
    const instant = (loaded - lastLoaded) / deltaTime
    lastTime = now
    lastLoaded = loaded
    // 分片重传 / 进度回退时可能出现负值，直接忽略这次采样
    if (!isFinite(instant) || instant < 0) return
    ema = ema > 0 ? ema * (1 - EMA_WEIGHT) + instant * EMA_WEIGHT : instant
    setUpload("speed", ema)
    if (total > 0) {
      setUpload("eta", ema > 0 ? Math.max(total - loaded, 0) / ema : undefined)
    }
  }
}

// 秒数格式化成 mm:ss / h:mm:ss
export function formatETA(seconds?: number) {
  if (seconds === undefined || !isFinite(seconds) || seconds <= 0) return ""
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => n.toString().padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
