import { Center, ElementType, Spinner, SpinnerProps } from "@hope-ui/solid"
import { JSXElement, mergeProps, Show } from "solid-js"
import { getMainColor } from "~/store"

export const FullScreenLoading = () => {
  return null
}

export const FullLoading = (_props: {
  py?: string
  size?: string
  thickness?: number
  ref?: any
}) => {
  return null
}

export const MaybeLoading = (props: {
  children?: JSXElement
  loading?: boolean
}) => {
  // loading 为 true 时不渲染 children，等资源就绪后再挂载，
  // 避免子组件在依赖（如 monaco）未初始化时提前执行。
  return <Show when={!props.loading}>{props.children}</Show>
}

export const CenterLoading = <C extends ElementType = "div">(
  _props: SpinnerProps<C>,
) => {
  return null
}
// 把 FullLoading.tsx 里的四个组件改成不同文字：
