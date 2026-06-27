// Server component — force-dynamic prevents static prerendering
export const dynamic = "force-dynamic";

import DashboardClient from "./DashboardClient";

export default function Page() {
  return <DashboardClient />;
}
