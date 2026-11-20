import { Center, Heading } from "@hope-ui/solid"
import { useManageTitle, useT } from "~/hooks"

const Dashboard = () => {
  const t = useT()
  useManageTitle("manage.sidemenu.dashboard")
  return (
    <Center h="$full">
      <Heading>{t("manage.sidemenu.dashboard")}</Heading>
    </Center>
  )
}

export default Dashboard
