import {
  Badge,
  Box,
  Button,
  HStack,
  Td,
  Text,
  Tr,
  useColorModeValue,
  VStack,
  Progress,
  ProgressIndicator,
  ProgressLabel,
} from "@hope-ui/solid"
import { Show } from "solid-js"
import { useFetch, useRouter, useT } from "~/hooks"
import { getMainColor } from "~/store"
import { MountDetails, PEmptyResp, PResp, Storage } from "~/types"
import {
  handleResp,
  handleRespWithNotifySuccess,
  joinBase,
  notify,
  r,
  showDiskUsage,
  usedPercentage,
  toReadableUsage,
  nearlyFull,
} from "~/utils"
import { DeletePopover } from "../common/DeletePopover"

interface StorageProps {
  storage: Storage
  refresh: () => void
}

function StorageOp(props: StorageProps) {
  const t = useT()
  const { to } = useRouter()
  const [deleteLoading, deleteStorage] = useFetch((): PEmptyResp =>
    r.post(`/admin/storage/delete?id=${props.storage.id}`),
  )
  const [enableOrDisableLoading, enableOrDisable] = useFetch((): PEmptyResp =>
    r.post(
      `/admin/storage/${props.storage.disabled ? "enable" : "disable"}?id=${
        props.storage.id
      }`,
    ),
  )
  // crypt 存储才有「明文 ↔ 密文」对照页；签名由后端签发，这里只负责换地址
  const [nameMapLoading, getNameMapLink] = useFetch(
    (): PResp<{ url: string; name: string }> =>
      r.get(`/admin/storage/namemap?id=${props.storage.id}`),
  )
  const openNameMap = async () => {
    // 先同步开窗：await 之后 window.open 会被浏览器当成非用户手势而拦截
    const win = window.open("", "_blank")
    const resp = await getNameMapLink()
    handleResp(
      resp,
      (data) => {
        const url = joinBase(data.url)
        if (win) {
          win.location.replace(url)
        } else {
          window.open(url, "_blank")
        }
      },
      () => {
        win?.close()
      },
    )
  }
  return (
    <>
      <Button
        onClick={() => {
          to(`/@manage/storages/edit/${props.storage.id}`)
        }}
      >
        {t("global.edit")}
      </Button>
      <Show when={props.storage.driver === "Crypt"}>
        <Button loading={nameMapLoading()} onClick={openNameMap}>
          {t("storages.other.namemap")}
        </Button>
      </Show>
      <Button
        loading={enableOrDisableLoading()}
        colorScheme={props.storage.disabled ? "success" : "warning"}
        onClick={async () => {
          const resp = await enableOrDisable()
          handleRespWithNotifySuccess(resp, () => {
            props.refresh()
          })
        }}
      >
        {t(`global.${props.storage.disabled ? "enable" : "disable"}`)}
      </Button>
      <DeletePopover
        name={props.storage.mount_path}
        loading={deleteLoading()}
        onClick={async () => {
          const resp = await deleteStorage()
          handleResp(resp, () => {
            notify.success(t("global.delete_success"))
            props.refresh()
          })
        }}
      />
    </>
  )
}

function StorageUsage(props: { details: MountDetails | undefined }) {
  return (
    <Show when={props.details}>
      <Progress
        class="disk-usage-percentage"
        trackColor="$info3"
        rounded="$full"
        size="md"
        value={usedPercentage(props.details!)}
      >
        <ProgressIndicator
          color={nearlyFull(props.details!) ? "$danger6" : "$info6"}
          rounded="$md"
        />
        <ProgressLabel class="disk-usage-text">
          {toReadableUsage(props.details!)}
        </ProgressLabel>
      </Progress>
    </Show>
  )
}

export function StorageGridItem(props: StorageProps) {
  const t = useT()
  return (
    <VStack
      w="$full"
      spacing="$2"
      rounded="$lg"
      border="1px solid $neutral7"
      background={useColorModeValue("$neutral2", "$neutral3")()}
      // alignItems="start"
      p="$3"
      _hover={{
        border: `1px solid ${getMainColor()}`,
      }}
    >
      <HStack spacing="$2">
        <Text
          fontWeight="$medium"
          css={{
            wordBreak: "break-all",
          }}
        >
          {props.storage.mount_path}
        </Text>
        <Badge colorScheme="info">
          {t(`drivers.drivers.${props.storage.driver}`)}
        </Badge>
        <Show when={props.storage.mount_details}>
          <Badge
            colorScheme={
              nearlyFull(props.storage.mount_details!) ? "danger" : "success"
            }
          >
            {toReadableUsage(props.storage.mount_details!)}
          </Badge>
        </Show>
      </HStack>
      <HStack>
        <Text>{t("storages.common.status")}:&nbsp;</Text>
        <Box
          css={{ wordBreak: "break-all" }}
          overflowX="auto"
          innerHTML={t(
            `storages.table_fields.status.${props.storage.status}`,
            undefined,
            props.storage.status,
          )}
        />
      </HStack>
      <Text css={{ wordBreak: "break-all" }}>{props.storage.remark}</Text>
      <HStack spacing="$2">
        <StorageOp {...props} />
      </HStack>
    </VStack>
  )
}

export function StorageListItem(props: StorageProps) {
  const t = useT()
  return (
    <Tr>
      <Td>{props.storage.mount_path}</Td>
      <Td>{t(`drivers.drivers.${props.storage.driver}`)}</Td>
      <Td>{props.storage.order}</Td>
      <Td>
        <StorageUsage details={props.storage.mount_details} />
      </Td>
      <Td>
        {t(
          `storages.table_fields.status.${props.storage.status}`,
          undefined,
          props.storage.status,
        )}
      </Td>
      <Td>{props.storage.remark}</Td>
      <Td>
        <HStack spacing="$2">
          <StorageOp {...props} />
        </HStack>
      </Td>
    </Tr>
  )
}
