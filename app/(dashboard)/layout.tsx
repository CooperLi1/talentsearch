import { requireDashboardSession } from "@/lib/auth/gate";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireDashboardSession();
  return children;
}
