import {
  Badge,
  Box,
  Button,
  Grid,
  Heading,
  HStack,
  Select,
  SelectContent,
  SelectIcon,
  SelectListbox,
  SelectOption,
  SelectOptionIndicator,
  SelectOptionText,
  SelectPlaceholder,
  SelectTrigger,
  SelectValue,
  Table,
  Tbody,
  Th,
  Thead,
  Tr,
  VStack,
  Switch as HopeSwitch,
} from "@hope-ui/solid"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js"
import { useFetch, useManageTitle, useRouter, useT } from "~/hooks"
import { handleResp, notify, r } from "~/utils"
import { EmptyResp, PageResp, Storage } from "~/types"
import { StorageGridItem, StorageListItem } from "./Storage"
import { createStorageSignal } from "@solid-primitives/storage"

type DriverSort = "none" | "asc" | "desc"

// 折叠状态：模块级单例，所有分组共享同一份 signal，并持久化到 localStorage。
// 必须提供 serializer/deserializer，否则数组会被存成 "A,B" 字符串后无法正确读回。
const [collapsedDrivers, setCollapsedDrivers] = createStorageSignal<string[]>(
  "storages-collapsed-drivers",
  [],
  {
    serializer: (value) => JSON.stringify(value ?? []),
    deserializer: (value) => {
      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    },
  },
)

// 按驱动分组的标题：大字号，点击整行即可折叠/展开该组。
// 展开状态按驱动名存 localStorage，刷新/重进页面后保持。
const DriverGroup = (props: {
  driver: string
  label: string
  count: number
  children: any
}) => {
  const collapsed = () => (collapsedDrivers() ?? []).includes(props.driver)
  const toggle = () => {
    const current = collapsedDrivers() ?? []
    setCollapsedDrivers(
      collapsed()
        ? current.filter((d) => d !== props.driver)
        : [...current, props.driver],
    )
  }
  const isOpen = () => !collapsed()
  return (
    <VStack w="$full" spacing="$2" alignItems="start">
      <HStack
        spacing="$2"
        onClick={toggle}
        cursor="pointer"
        userSelect="none"
        title={isOpen() ? "折叠" : "展开"}
      >
        <Box
          as="span"
          display="inline-block"
          css={{
            transition: "transform 150ms ease",
            transform: isOpen() ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          ▶
        </Box>
        <Heading size="lg">{props.label}</Heading>
        <Badge colorScheme="info">{props.count}</Badge>
      </HStack>
      <Show when={isOpen()}>{props.children}</Show>
    </VStack>
  )
}

const Storages = () => {
  const t = useT()
  useManageTitle("manage.sidemenu.storages")
  const { to } = useRouter()
  const [getStoragesLoading, getStorages] = useFetch(
    (): Promise<PageResp<Storage>> => r.get("/admin/storage/list"),
  )
  const [storages, setStorages] = createSignal<Storage[]>([])
  const refresh = async () => {
    const resp = await getStorages()
    handleResp(resp, (data) => setStorages(data.content))
  }
  const [selectedDrivers, setSelectedDrivers] = createSignal<string[]>([])
  refresh()

  const driverLabel = (driver: string) => t(`drivers.drivers.${driver}`)

  // 只展示当前已挂载（已存在）的驱动类型，而不是后端支持的全部驱动。
  const mountedDrivers = createMemo(() => {
    const set = new Set<string>()
    for (const s of storages()) set.add(s.driver)
    return Array.from(set).sort((a, b) =>
      driverLabel(a).localeCompare(driverLabel(b)),
    )
  })

  // 当存储变化导致某个已选驱动不再存在时，清掉失效选择。
  createEffect(() => {
    const valid = new Set(mountedDrivers())
    const next = selectedDrivers().filter((d) => valid.has(d))
    if (next.length !== selectedDrivers().length) setSelectedDrivers(next)
  })

  const loadAll = async () => {
    const resp: EmptyResp = await r.post("/admin/storage/load_all")
    handleResp(resp, () => {
      notify.success(t("storages.other.start_load_success"))
    })
  }

  const [driverSort, setDriverSort] = createSignal<DriverSort>("none")
  const toggleDriverSort = () => {
    const cur = driverSort()
    setDriverSort(cur === "asc" ? "desc" : cur === "desc" ? "none" : "asc")
  }

  const shownStorages = createMemo(() => {
    const filtered = storages().filter((storage) => {
      if (selectedDrivers().length === 0) return true
      return selectedDrivers().includes(storage.driver)
    })
    const sort = driverSort()
    if (sort === "none") return filtered
    const sign = sort === "asc" ? 1 : -1
    return [...filtered].sort((a, b) => {
      const cmp = driverLabel(a.driver).localeCompare(driverLabel(b.driver))
      return sign * (cmp !== 0 ? cmp : a.mount_path.localeCompare(b.mount_path))
    })
  })

  // 非表格布局：按驱动分组。
  const groupedStorages = createMemo(() => {
    const groups = new Map<string, Storage[]>()
    for (const s of shownStorages()) {
      const arr = groups.get(s.driver) ?? []
      arr.push(s)
      groups.set(s.driver, arr)
    }
    return Array.from(groups.entries()).sort((a, b) =>
      driverLabel(a[0]).localeCompare(driverLabel(b[0])),
    )
  })

  const [layout, setLayout] = createStorageSignal(
    "storages-layout",
    "grid" as "grid" | "table",
  )
  return (
    <VStack spacing="$3" alignItems="start" w="$full">
      <HStack
        spacing="$2"
        gap="$2"
        w="$full"
        wrap={{
          "@initial": "wrap",
          "@md": "unset",
        }}
      >
        <Button
          colorScheme="accent"
          loading={getStoragesLoading()}
          onClick={refresh}
        >
          {t("global.refresh")}
        </Button>
        <Button
          onClick={() => {
            to("/@manage/storages/add")
          }}
        >
          {t("global.add")}
        </Button>
        <Button
          colorScheme="warning"
          loading={getStoragesLoading()}
          onClick={loadAll}
        >
          {t("storages.other.load_all")}
        </Button>
        <Show when={mountedDrivers().length > 0}>
          <Select
            multiple
            value={selectedDrivers()}
            onChange={setSelectedDrivers}
          >
            <SelectTrigger>
              <SelectPlaceholder>
                {t("storages.other.filter_by_driver")}
              </SelectPlaceholder>
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectListbox>
                <For each={mountedDrivers()}>
                  {(item) => (
                    <SelectOption value={item}>
                      <SelectOptionText>{driverLabel(item)}</SelectOptionText>
                      <SelectOptionIndicator />
                    </SelectOption>
                  )}
                </For>
              </SelectListbox>
            </SelectContent>
          </Select>
        </Show>
        <HopeSwitch
          checked={layout() === "table"}
          onChange={(e: Event) => {
            setLayout(
              (e.currentTarget as HTMLInputElement).checked ? "table" : "grid",
            )
          }}
        >
          {t("storages.other.table_layout")}
        </HopeSwitch>
      </HStack>
      <Switch>
        <Match when={layout() === "grid"}>
          <VStack w="$full" spacing="$4" alignItems="start">
            <For each={groupedStorages()}>
              {([driver, items]) => (
                <DriverGroup
                  driver={driver}
                  label={driverLabel(driver)}
                  count={items.length}
                >
                  <Grid
                    w="$full"
                    gap="$2_5"
                    templateColumns={{
                      "@initial": "1fr",
                      "@lg": "repeat(auto-fill, minmax(324px, 1fr))",
                    }}
                  >
                    <For each={items}>
                      {(storage) => (
                        <StorageGridItem storage={storage} refresh={refresh} />
                      )}
                    </For>
                  </Grid>
                </DriverGroup>
              )}
            </For>
          </VStack>
        </Match>
        <Match when={layout() === "table"}>
          <Box w="$full" overflowX="auto">
            <Table highlightOnHover dense>
              <Thead>
                <Tr>
                  <Th>{t("storages.common.mount_path")}</Th>
                  <Th
                    onClick={toggleDriverSort}
                    css={{ cursor: "pointer", userSelect: "none" }}
                    title={t("storages.other.sort_by_driver")}
                  >
                    {t("storages.common.driver")}
                    <Show when={driverSort() !== "none"}>
                      <Box as="span" ml="$1">
                        {driverSort() === "asc" ? "▲" : "▼"}
                      </Box>
                    </Show>
                  </Th>
                  <Th>{t("storages.common.order")}</Th>
                  <Th>{t("storages.common.usage")}</Th>
                  <Th>{t("storages.common.status")}</Th>
                  <Th>{t("storages.common.remark")}</Th>
                  <Th>{t("global.operations")}</Th>
                </Tr>
              </Thead>
              <Tbody>
                <For each={shownStorages()}>
                  {(storage) => (
                    <StorageListItem storage={storage} refresh={refresh} />
                  )}
                </For>
              </Tbody>
            </Table>
          </Box>
        </Match>
      </Switch>
    </VStack>
  )
}

export default Storages
