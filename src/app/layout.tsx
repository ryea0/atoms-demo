import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppSidebar } from "@/components/shell/AppSidebar";
import "./globals.css";

// 变量名与 globals.css 的 @theme inline 映射保持一致（--font-sans / --font-mono）
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Atoms Demo — 输入想法，产出产品",
    template: "%s · Atoms Demo",
  },
  description:
    "一句话需求，交给多智能体团队：领导分派、PM/架构师/工程师接力，产出 PRD、架构设计与可预览的全栈应用。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased">
        <div className="flex min-h-dvh">
          <AppSidebar />
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
