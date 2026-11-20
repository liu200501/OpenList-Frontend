import { BoxWithFullScreen } from "~/components"
import { objStore } from "~/store"
import { hope, Tooltip, IconButton } from "@hope-ui/solid"
import { convertURL } from "~/utils"
import { Component, createMemo } from "solid-js"
import { useLink, useT } from "~/hooks"
import { TbExternalLink } from "solid-icons/tb"

const IframePreview = (props: { scheme: string }) => {
  const t = useT()
  const { currentObjLink } = useLink()
  const iframeSrc = createMemo(() => {
    return convertURL(props.scheme, {
      raw_url: objStore.raw_url,
      name: objStore.obj.name,
      d_url: currentObjLink(true),
      ts: true,
    })
  })
  return (
    <BoxWithFullScreen
      w="$full"
      h="70vh"
      extraButtons={
        <Tooltip label={t("home.preview.open_in_new_tab")} withArrow>
          <IconButton
            aria-label={t("home.preview.open_in_new_tab")}
            icon={<TbExternalLink />}
            onClick={() => {
              window.open(iframeSrc(), "_blank")
            }}
            colorScheme="neutral"
            size="sm"
          />
        </Tooltip>
      }
    >
      <hope.iframe w="$full" h="$full" src={iframeSrc()} />
    </BoxWithFullScreen>
  )
}

export const generateIframePreview = (scheme: string): Component => {
  return () => {
    return <IframePreview scheme={scheme} />
  }
}
