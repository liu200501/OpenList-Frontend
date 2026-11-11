export interface TaskInfo {
  id: string
  name: string
  creator: string
  creator_role: number
  state: number
  status: string
  progress: number
  start_time: string | null
  end_time: string | null
  total_bytes: number
  error: string
  // 所在存储是否支持暂停/继续（后端按驱动能力 + crypt 存储开关给出）
  pausable?: boolean
}
