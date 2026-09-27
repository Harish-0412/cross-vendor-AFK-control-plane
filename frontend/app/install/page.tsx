import type { Metadata } from "next";

import { InstallGuide } from "@/components/install/InstallGuide";

export const metadata: Metadata = {
  title: "Install Odysseus — connect your computer",
  description:
    "Install the Odysseus gateway with one command on Windows, macOS or Linux, pair your computer, and control your AI coding agents from anywhere.",
};

export default function InstallPage() {
  return <InstallGuide />;
}
