import { getSettingBool, objStore } from "~/store"
import { FormUpload } from "./form"
import { StreamUpload } from "./stream"
import { HttpDirectUpload } from "./direct"
import { MultipartUpload } from "./multipart"
import { Upload } from "./types"

type Uploader = {
  upload: Upload
  name: string
  // 显示给用户的名称所用的 i18n key，name 仅作为内部标识
  labelKey: string
  available: () => boolean
}

// All upload methods
//
// 分片上传统一采用官方 multipart 协议（/fs/multipart/*），GO / TS 后端共用
// 同一 API 契约；后端实现可不同（TS 内部桥接到会话分片）。后端对不支持分片
// 的存储返回 data:null，前端 multipart 自动回退到流式上传。
const AllUploads: Uploader[] = [
  {
    name: "Multipart",
    labelKey: "home.upload.methods.multipart",
    upload: MultipartUpload,
    available: () => getSettingBool("multipart_enabled"),
  },
  {
    name: "HTTP Direct",
    labelKey: "home.upload.methods.http_direct",
    upload: HttpDirectUpload,
    available: () => {
      return objStore.direct_upload_tools?.includes("HttpDirect") || false
    },
  },
  {
    name: "Stream",
    labelKey: "home.upload.methods.stream",
    upload: StreamUpload,
    available: () => true,
  },
  {
    name: "Form",
    labelKey: "home.upload.methods.form",
    upload: FormUpload,
    available: () => true,
  },
]

export const getUploads = (): Pick<
  Uploader,
  "name" | "labelKey" | "upload"
>[] => {
  return AllUploads.filter((u) => u.available())
}
