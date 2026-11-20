import {
  Box,
  Button,
  FormHelperText,
  HStack,
  Input,
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
  Switch as HopeSwitch,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  VStack,
} from "@hope-ui/solid"
import { createMemo, For } from "solid-js"
import { useT } from "~/hooks"

interface Rule {
  enabled: boolean
  driver: string
  path: string
  interval: number
  depth: number
}

const emptyRule = (): Rule => ({
  enabled: true,
  driver: "",
  path: "",
  interval: 600,
  depth: 2,
})

const parseRules = (raw: string): Rule[] => {
  try {
    const value = JSON.parse(raw || "[]")
    if (!Array.isArray(value)) return []
    return value.map((r: any) => ({
      enabled: !!r.enabled,
      driver: String(r.driver ?? ""),
      path: String(r.path ?? ""),
      interval: Number(r.interval ?? 600),
      depth: Number(r.depth ?? 0),
    }))
  } catch {
    return []
  }
}

interface IndexWatchRulesProps {
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
}

// 「索引监听规则」专用编辑器：一条规则一行，每个字段独立输入，
// 驱动名和是否启用做成下拉框，保存时仍序列化成后端期望的 JSON 数组。
const IndexWatchRules = (props: IndexWatchRulesProps) => {
  const t = useT()
  const rules = createMemo(() => parseRules(props.value))
  const driverOptions = ["", "139Yun", "Local", "Crypt"]
  const label = (key: string) => t(`settings.index_watch_rules_fields.${key}`)

  const commit = (next: Rule[]) => {
    props.onChange(JSON.stringify(next))
  }
  const update = (index: number, patch: Partial<Rule>) => {
    commit(rules().map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  return (
    <VStack w="$full" alignItems="start" spacing="$2">
      <BoxScroll>
        <Table dense w="$full">
          <Thead>
            <Tr>
              <Th>{label("enabled")}</Th>
              <Th>{label("driver")}</Th>
              <Th>{label("path")}</Th>
              <Th>{label("interval")}</Th>
              <Th>{label("depth")}</Th>
              <Th>{t("global.operations")}</Th>
            </Tr>
          </Thead>
          <Tbody>
            <For each={rules()}>
              {(rule, index) => (
                <Tr>
                  <Td>
                    <Select
                      size="sm"
                      value={rule.enabled ? "true" : "false"}
                      onChange={(e) =>
                        update(index(), { enabled: e === "true" || e === "1" })
                      }
                      readOnly={props.readOnly}
                    >
                      <SelectTrigger>
                        <SelectValue />
                        <SelectIcon />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectListbox>
                          <SelectOption value="true">
                            <SelectOptionText>
                              {t("global.yes")}
                            </SelectOptionText>
                            <SelectOptionIndicator />
                          </SelectOption>
                          <SelectOption value="false">
                            <SelectOptionText>
                              {t("global.no")}
                            </SelectOptionText>
                            <SelectOptionIndicator />
                          </SelectOption>
                        </SelectListbox>
                      </SelectContent>
                    </Select>
                  </Td>
                  <Td>
                    <Select
                      size="sm"
                      value={rule.driver}
                      onChange={(e) => update(index(), { driver: e ?? "" })}
                      readOnly={props.readOnly}
                    >
                      <SelectTrigger>
                        <SelectValue />
                        <SelectIcon />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectListbox>
                          <For each={driverOptions}>
                            {(driver) => (
                              <SelectOption value={driver}>
                                <SelectOptionText>
                                  {driver || label("any_driver")}
                                </SelectOptionText>
                                <SelectOptionIndicator />
                              </SelectOption>
                            )}
                          </For>
                        </SelectListbox>
                      </SelectContent>
                    </Select>
                  </Td>
                  <Td>
                    <Input
                      size="sm"
                      value={rule.path}
                      placeholder="/移动云盘/追剧"
                      onInput={(e) =>
                        update(index(), { path: e.currentTarget.value })
                      }
                      readOnly={props.readOnly}
                    />
                  </Td>
                  <Td>
                    <Input
                      size="sm"
                      type="number"
                      value={String(rule.interval)}
                      onInput={(e) =>
                        update(index(), {
                          interval: Number(e.currentTarget.value) || 0,
                        })
                      }
                      readOnly={props.readOnly}
                    />
                  </Td>
                  <Td>
                    <Input
                      size="sm"
                      type="number"
                      value={String(rule.depth)}
                      onInput={(e) =>
                        update(index(), {
                          depth: Number(e.currentTarget.value) || 0,
                        })
                      }
                      readOnly={props.readOnly}
                    />
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      colorScheme="danger"
                      disabled={props.readOnly}
                      onClick={() =>
                        commit(rules().filter((_, i) => i !== index()))
                      }
                    >
                      {t("global.delete")}
                    </Button>
                  </Td>
                </Tr>
              )}
            </For>
          </Tbody>
        </Table>
      </BoxScroll>
      <HStack spacing="$2">
        <Button
          size="sm"
          disabled={props.readOnly}
          onClick={() => commit([...rules(), emptyRule()])}
        >
          {t("global.add")}
        </Button>
      </HStack>
      <FormHelperText>{t("settings.index_watch_rules-tips")}</FormHelperText>
    </VStack>
  )
}

// 规则较多时横向滚动，避免挤压旁边的设置项。
const BoxScroll = (props: { children: any }) => (
  <Box w="$full" overflowX="auto">
    {props.children}
  </Box>
)

export { IndexWatchRules }
