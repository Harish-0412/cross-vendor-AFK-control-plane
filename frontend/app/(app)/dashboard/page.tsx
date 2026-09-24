"use client";

import { DesktopDashboard } from "@/components/dashboard/DesktopDashboard";
import { MobileDashboard } from "@/components/dashboard/MobileDashboard";
import { useIsDesktop } from "@/lib/use-device";

/**
 * The overview renders a different layout on a desktop and on a phone, not the
 * same one squeezed. Both read the same shared store, so switching between
 * them — rotating a tablet, resizing a window — costs no request.
 */
export default function DashboardPage() {
  const isDesktop = useIsDesktop();
  return isDesktop ? <DesktopDashboard /> : <MobileDashboard />;
}
