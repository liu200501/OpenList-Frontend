import { Box, Grid, HStack, Text } from "@hope-ui/solid"
import { For, Show } from "solid-js"
import { GridItem } from "./GridItem"
import "lightgallery/css/lightgallery-bundle.css"
import {
  allChecked,
  checkboxOpen,
  isIndeterminate,
  local,
  objStore,
  selectAll,
  selectedMsg,
  smartCountMsg,
} from "~/store"
import { ItemCheckbox, useSelectWithMouse } from "./helper"

const GridLayout = () => {
  const { isMouseSupported, registerSelectContainer, captureContentMenu } =
    useSelectWithMouse()
  registerSelectContainer()
  const showCount = () => local["show_count_msg"] === "visible"
  // 全选栏在勾选模式开启或需要显示计数时出现，与列表视图保持一致。
  const showHeader = () => checkboxOpen() || showCount()
  return (
    <>
      <Show when={showHeader()}>
        <HStack w="100%" px="$2" py="$1" spacing="$2" alignItems="center">
          <Show when={checkboxOpen()}>
            <ItemCheckbox
              checked={allChecked()}
              indeterminate={isIndeterminate()}
              onChange={(e: any) => {
                selectAll(e.target.checked as boolean)
              }}
            />
          </Show>
          <Show when={showCount()}>
            <Text size="sm" color="$neutral11" textAlign="left">
              {selectedMsg() || smartCountMsg()}
            </Text>
          </Show>
        </HStack>
      </Show>
      <Grid
        oncapture:contextmenu={captureContentMenu}
        class="viselect-container"
        w="$full"
        gap="$1"
        templateColumns={`repeat(auto-fill, minmax(${
          parseInt(local["grid_item_size"]) + 20
        }px,1fr))`}
      >
        <For each={objStore.objs}>
          {(obj, i) => {
            return <GridItem obj={obj} index={i()} />
          }}
        </For>
      </Grid>
    </>
  )
}

export default GridLayout
