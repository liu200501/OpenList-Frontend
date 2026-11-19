import { Icon } from "@hope-ui/solid"
import { TbCopy } from "solid-icons/tb"
import { Show } from "solid-js"
import { useT, useUtil } from "~/hooks"
import { objStore } from "~/store"
import { StoreObj } from "~/types"

export const CipherCopyButton = (props: { obj: StoreObj }) => {
  const t = useT()
  const { copy } = useUtil()
  const stop = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }
  return (
    <Show when={objStore.provider === "Crypt" && props.obj.encrypted_name}>
      <Icon
        class="icon"
        as={TbCopy}
        boxSize="$5"
        color="$neutral11"
        cursor="pointer"
        title={t("home.toolbar.copy_cipher_name")}
        aria-label={t("home.toolbar.copy_cipher_name")}
        on:mousedown={stop}
        on:click={(e: MouseEvent) => {
          stop(e)
          void copy(props.obj.encrypted_name!)
        }}
        on:contextmenu={stop}
      />
    </Show>
  )
}
