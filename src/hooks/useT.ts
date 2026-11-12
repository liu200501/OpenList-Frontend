import { currentLang, dict, i18n, languages } from "~/app/i18n"
import { firstUpperCase } from "~/utils"

const translator = i18n.translator(dict)

// DEV 下把漏翻从「静默显示 key」变成可见告警；同一个 key 只提示一次，避免刷屏
const warnedKeys = new Set<string>()
const warnMissingOnce = (key: string) => {
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  console.warn(
    `[i18n] 缺少翻译 ${key}（当前语言 ${currentLang()}）→ 请补进 src/lang/en 与 src/lang/zh-CN`,
  )
}

const resolveTranslation = (
  key: string,
  params?: i18n.BaseTemplateArgs,
): string | undefined => {
  const template = translator(key)
  if (typeof template !== "string") {
    return undefined
  }

  if (params) {
    return i18n.resolveTemplate(template, params) || template
  }

  return template
}
export const useT = () => {
  return (
    key: string,
    params?: i18n.BaseTemplateArgs | undefined,
    defaultValue?: string | undefined,
  ): string => {
    const translatedValue = resolveTranslation(key, params)

    if (translatedValue) return translatedValue
    if (defaultValue) return defaultValue
    if (import.meta.env.DEV) {
      warnMissingOnce(key)
      return key
    }

    return formatKeyAsDisplay(key)
  }
}

const formatKeyAsDisplay = (key: string): string => {
  let lastDotIndex = key.lastIndexOf(".")
  if (lastDotIndex === key.length - 1) {
    lastDotIndex = key.lastIndexOf(".", lastDotIndex - 1)
  }
  const last = key.slice(lastDotIndex + 1)
  return firstUpperCase(last).split("_").join(" ")
}
