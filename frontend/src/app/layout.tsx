import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import "./globals.css";

export const metadata: Metadata = {
  title: "Grelve — 13 agents to build a full SaaS product",
  description:
    "Grelve orchestrates 13 specialized AI agents from idea to planning, scaffold, parallel frontend and backend implementation, integration, and review.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full antialiased ${GeistSans.variable} ${GeistMono.variable}`}>
      <body className={`min-h-full ${GeistSans.className}`}>{children}</body>
    </html>
  );
}
