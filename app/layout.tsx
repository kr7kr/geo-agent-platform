import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GeoLink · 中文地理文本空间推理 Agent",
  description: "将中文地理文本解析为可验证实体、空间范围与自适应 S2 网格。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
