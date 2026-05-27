import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "@mysten/dapp-kit/dist/index.css";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://suisub-sui.vercel.app"),
  title: "SuiSub | Decentralized Recurring Payments on Sui",
  description: "SuiSub is a decentralized, non-custodial recurring payment and subscription protocol on Sui. Gate premium digital content, manage billing cycles, and automate payouts securely.",
  keywords: [
    "SuiSub",
    "Sui Network",
    "Web3 Subscriptions",
    "Recurring Payments",
    "Content Gating",
    "Decentralized Finance",
    "Smart Contract Subscriptions",
    "SUI token"
  ],
  authors: [{ name: "SuiSub Team" }],
  creator: "SuiSub",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://suisub-sui.vercel.app",
    title: "SuiSub | Decentralized Recurring Payments on Sui",
    description: "Decentralized, non-custodial recurring payments and subscription protocols on the Sui Network. Enable automated billing cycles and gated digital content.",
    siteName: "SuiSub",
    images: [
      {
        url: "/logo.png",
        width: 512,
        height: 512,
        alt: "SuiSub - Recurring Payments on Sui",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "SuiSub | Decentralized Recurring Payments on Sui",
    description: "Non-custodial, automated recurring payments and premium digital content gating protocol on the Sui Network.",
    images: ["/logo.png"],
  },
  icons: {
    icon: "/icon.png",
    shortcut: "/icon.png",
    apple: "/icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
