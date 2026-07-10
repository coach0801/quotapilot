import Link from "next/link";

const nav = [
  { href: "/playground", label: "Playground" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/docs", label: "Docs" },
  { href: "https://github.com/coach0801/quotapilot", label: "GitHub" },
];

export default function SiteLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link href="/" className="font-semibold tracking-tight">
            <span className="text-emerald-400">◈</span> QuotaPilot
          </Link>
          <nav className="flex gap-5 text-sm text-zinc-400">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="hover:text-zinc-100">
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      <footer className="border-t border-zinc-800 py-6 text-center text-xs text-zinc-500">
        Open source (MIT) · built entirely on free tiers · keys are never stored
        server-side
      </footer>
    </div>
  );
}
