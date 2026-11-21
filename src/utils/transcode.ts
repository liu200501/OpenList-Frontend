import { r } from "~/utils"
import type { Resp } from "~/types"

/**
 * 转码播放响应（与后端 server/handles/transcode.go 的 respondTranscodeJob 对应）
 *  - transcode=false → 走原有直链播放（原因见 reason，例如体积未达阈值/未开启）
 *  - transcode=true  → 使用 master_url（HLS）播放
 */
export interface TrackRef {
  index: number
  name: string
  language?: string
  codec?: string
  channels?: number
  default?: boolean
  /** 该轨是否已被转码输出（音频轨数量与 audio_tracks 一致时全部 true） */
  active?: boolean
}

export interface SubtitleRef {
  /** 字幕轨在源文件字幕流中的序号（用于 /sub/{index}.vtt） */
  index: number
  name: string
  language?: string
  codec?: string
  url: string
}

export interface TranscodePlayResult {
  transcode: boolean
  reason?: string
  job_id?: string
  master_url?: string
  profile?: string
  /** 是否多轨转码（多视频轨或多音轨，播放器可切换） */
  multi_track?: boolean
  audio_tracks?: TrackRef[]
  video_tracks?: TrackRef[]
  subtitles?: SubtitleRef[]
}

/**
 * 申请转码播放
 * 后端根据后缀/体积/轨道情况自行决策：
 *  - 视频只做分辨率缩放 + 码率控制
 *  - 音频统一重编码为 AAC；多条音轨各自一条 rendition，可在播放器切换
 *  - 内嵌文本字幕轨可按需转成 WebVTT 直接加载
 */
export const requestTranscodePlay = (path: string) =>
  r.post("/fs/transcode/play", { path }) as Promise<Resp<TranscodePlayResult>>
