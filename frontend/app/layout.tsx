import type React from "react"
import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import "./globals.css"

const _geist = Geist({ subsets: ["latin"] })
const _geistMono = Geist_Mono({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "FreeBuff AFK — Go AFK. Your AI Agent Keeps Working.",
  description:
    "FreeBuff AFK is the vendor-neutral control plane for AI coding agents. Supervise, approve, and control your agents from anywhere — your phone, tablet, or any browser.",
}

export const viewport = {
  themeColor: "#6366F1",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark bg-background">
      <body className={`font-sans antialiased`}>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
