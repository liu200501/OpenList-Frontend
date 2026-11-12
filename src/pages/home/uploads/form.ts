import { password } from "~/store"
import { EmptyResp } from "~/types"
import { r } from "~/utils"
import { seedUploadHeaders, SetUpload, Upload } from "./types"
import { calculateHash } from "./util"
import { createSpeedTracker } from "./speed"
export const FormUpload: Upload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask = false,
  overwrite = false,
  rapid = false,
  seedOptions,
): Promise<undefined> => {
  const trackSpeed = createSpeedTracker(setUpload, file.size)
  const form = new FormData()
  form.append("file", file)
  let headers: { [k: string]: any } = {
    "File-Path": encodeURIComponent(uploadPath),
    "As-Task": asTask,
    "Content-Type": "multipart/form-data",
    "Last-Modified": file.lastModified,
    Password: password(),
    Overwrite: overwrite.toString(),
    ...seedUploadHeaders(seedOptions),
  }
  if (rapid) {
    setUpload("status", "hashing")
    const { md5, sha1, sha256 } = await calculateHash(file, (p) => {
      setUpload("progress", p | 0)
    })
    headers["X-File-Md5"] = md5
    headers["X-File-Sha1"] = sha1
    headers["X-File-Sha256"] = sha256
  }
  setUpload("status", "uploading")
  const resp: EmptyResp = await r.put("/fs/form", form, {
    headers: headers,
    onUploadProgress: (progressEvent) => {
      if (progressEvent.total) {
        const complete =
          ((progressEvent.loaded / progressEvent.total) * 100) | 0
        setUpload("progress", complete)
        trackSpeed(progressEvent.loaded)

        if (complete === 100) {
          setUpload("status", "backending")
        }
      }
    },
  })
  if (resp.code === 200) {
    setUpload("eta", undefined)
    return
  } else {
    throw new Error(resp.message)
  }
}
