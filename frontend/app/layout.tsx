import type React from "react";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// Loaded as CSS variables and wired into --font-sans / --font-mono in
// globals.css. They were imported before but never applied, so the whole app
// was rendering in the browser's fallback sans-serif.
const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Odysseus AFK — Go AFK. Your AI Agent Keeps Working.",
  description:
    "Odysseus AFK is the vendor-neutral control plane for AI coding agents. Supervise, approve, and control your agents from anywhere — your phone, tablet, or any browser.",
  appleWebApp: {
    capable: true,
    title: "Odysseus",
    statusBarStyle: "black-translucent",
  },
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7fb" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d14" },
  ],
  // Lets the app draw under the notch and home indicator when installed; the
  // shell pads itself with env(safe-area-inset-*).
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          {/*
            Every toast() in the app rendered nowhere until this was mounted —
            errors, confirmations and the plan-limit warning included.
          */}
          <Toaster position="top-center" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
