declare const __APP_VERSION__: string;

import { useState } from "react";
import {
  Terminal,
  Eye,
  BarChart3,
  Settings,
  Shield,
  Timer,
  Check,
  Copy,
  Search,
  Database,
  ChevronLeft,
  ChevronRight,
  Expand,
  Bookmark,
  ListTree,
  Keyboard,
  type LucideIcon,
} from "lucide-react";

interface ProductScene {
  image: string;
  title: string;
  description: string;
}

const productScenes: ProductScene[] = [
  {
    image: "/demo/dashboard.png",
    title: "Dashboard",
    description: "Track cross-agent activity, token trends, and bookmarked sessions at a glance.",
  },
  {
    image: "/demo/search.png",
    title: "Search",
    description: "Search titles and message content to jump straight to the right session.",
  },
  {
    image: "/demo/session-detail.png",
    title: "Session Replay",
    description: "Replay messages, tool runs, and file changes in a single timeline.",
  },
  {
    image: "/demo/shortcuts.png",
    title: "Keyboard Shortcuts",
    description: "Navigate, search, and move through groups without leaving the keyboard.",
  },
];

/* ─── Header ──────────────────────────────────────────── */

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--console-border)] bg-white/85 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <a href="/" className="flex items-center gap-2 text-[var(--console-text)]">
          <img src="/logo.svg?v=2" alt="CodeSesh" className="h-6 w-6 rounded-sm" />
          <span className="console-mono text-sm font-semibold uppercase tracking-[0.05em]">
            CodeSesh
          </span>
        </a>
        <nav className="flex items-center gap-4">
          <a
            href="https://github.com/xingkaixin/codesesh"
            target="_blank"
            rel="noopener noreferrer"
            className="console-mono text-xs text-[var(--console-muted)] transition-colors hover:text-[var(--console-text)]"
          >
            GitHub
          </a>
          <span className="console-mono rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-2 py-1 text-[10px] font-semibold text-[var(--console-muted)]">
            v{__APP_VERSION__}
          </span>
        </nav>
      </div>
    </header>
  );
}

/* ─── Hero ────────────────────────────────────────────── */

export function Hero() {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText("npx codesesh").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <section className="px-6 pb-20 pt-24 text-center">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex justify-center">
          <img src="/logo.svg?v=2" alt="CodeSesh" className="h-20 w-20" />
        </div>
        <h1 className="console-mono text-3xl font-bold tracking-tight text-[var(--console-accent-strong)] md:text-4xl">
          See every AI coding session,
          <br />
          in one place.
        </h1>
        <p className="mx-auto mt-5 max-w-md text-sm leading-relaxed text-[var(--console-muted)]">
          CodeSesh finds sessions across tools and directories, then turns them into a live
          dashboard, full-text search, and a replayable history backed by local SQLite storage.
        </p>

        <ProductShowcase />

        {/* Terminal demo — part of hero */}
        <div className="mx-auto mt-10 max-w-lg">
          <div className="rounded-sm border border-[var(--console-border-strong)] bg-[#0f172a] p-5 text-left">
            <div className="mb-3 flex items-center gap-2">
              <span className="console-mono inline-block size-2.5 rounded-full bg-[#ef4444]" />
              <span className="console-mono inline-block size-2.5 rounded-full bg-[#eab308]" />
              <span className="console-mono inline-block size-2.5 rounded-full bg-[#22c55e]" />
              <button
                onClick={handleCopy}
                className="ml-auto rounded-sm p-1 text-[#64748b] transition-colors hover:text-[#94a3b8]"
                title="Copy command"
              >
                {copied ? (
                  <Check className="size-3.5 text-[#4ade80]" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            </div>
            <pre className="console-mono overflow-x-auto text-sm leading-relaxed text-[#94a3b8]">
              <span className="font-semibold text-[#4ade80]">$ npx codesesh</span>
              {"\n"}
              {"\n"}
              <span className="text-[#64748b]"> ╭─────────────CodeSesh───────────────╮</span>
              {"\n"}
              <span className="text-[#64748b]"> │ │</span>
              {"\n"}
              <span className="text-[#64748b]"> │ </span>
              <span className="text-[#e2e8f0]">v{__APP_VERSION__} • 123 sessions discovered</span>
              <span className="text-[#64748b]"> │</span>
              {"\n"}
              <span className="text-[#64748b]"> │ │</span>
              {"\n"}
              <span className="text-[#64748b]"> ╰────────────────────────────────────╯</span>
              {"\n"}
              {"\n"} <span className="text-[#4ade80]">✔</span> Claude Code 91 sessions
              {"\n"} <span className="text-[#f87171]">✖</span> OpenCode not found
              {"\n"} <span className="text-[#4ade80]">✔</span> Kimi-Cli 2 sessions
              {"\n"} <span className="text-[#4ade80]">✔</span> Codex 30 sessions
              {"\n"} <span className="text-[#f87171]">✖</span> Cursor not found
              {"\n"}
              {"\n"}
              <span className="text-[#38bdf8]">ℹ Active: 3/5 agents</span>
              {"\n"}
              {"\n"} <span className="text-[#38bdf8]">http://localhost:4321</span>
            </pre>
          </div>
          <p className="console-mono mt-3 text-center text-xs text-[var(--console-accent)]">
            Requires Node.js 18+ · Works with pnpm, npm, or bun
          </p>
        </div>
      </div>
    </section>
  );
}

export function ProductShowcase() {
  const [activeSceneIndex, setActiveSceneIndex] = useState<number | null>(null);
  const marqueeScenes = [...productScenes, ...productScenes];
  const activeScene = activeSceneIndex === null ? null : productScenes[activeSceneIndex];

  function openScene(index: number) {
    setActiveSceneIndex(index);
  }

  function closeScene() {
    setActiveSceneIndex(null);
  }

  function showPreviousScene() {
    setActiveSceneIndex((current) => {
      if (current === null) return current;
      return (current - 1 + productScenes.length) % productScenes.length;
    });
  }

  function showNextScene() {
    setActiveSceneIndex((current) => {
      if (current === null) return current;
      return (current + 1) % productScenes.length;
    });
  }

  return (
    <>
      <section className="mt-12">
        <div className="mx-auto max-w-6xl">
        <div className="mx-auto max-w-2xl text-center">
          <p className="console-mono text-xs font-bold uppercase tracking-[0.16em] text-[var(--console-muted)]">
            Product Tour
          </p>
          <h2 className="console-mono mt-3 text-2xl font-bold tracking-tight text-[var(--console-accent-strong)] md:text-3xl">
            What the product looks like in use
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-[var(--console-muted)]">
            These product shots preview the dashboard, search flow, session detail view, and
            keyboard shortcuts before installation.
          </p>
        </div>

        <div className="product-marquee-shell mt-8">
          <div className="product-marquee-track">
            {marqueeScenes.map((scene, index) => (
              <article
                key={`${scene.title}-${index}`}
                className="product-scene-card group relative w-[min(78vw,34rem)] shrink-0 overflow-hidden rounded-[1.25rem] border border-[var(--console-border)] bg-white text-left shadow-[0_20px_60px_rgba(15,23,42,0.08)]"
              >
                <div className="border-b border-[var(--console-border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(245,245,245,0.98))] px-5 py-4">
                  <div>
                    <p className="console-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--console-muted)]">
                      {scene.title}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-[var(--console-text)]">
                      {scene.description}
                    </p>
                  </div>
                </div>

                <div className="bg-[radial-gradient(circle_at_top,#ffffff,rgba(247,247,247,0.92)_55%,rgba(238,238,238,0.98))] p-4">
                  <div className="overflow-hidden rounded-[1rem] border border-[var(--console-border)] bg-[#f8f8f8] shadow-[0_12px_40px_rgba(15,23,42,0.08)]">
                    <img
                      src={scene.image}
                      alt={`${scene.title} demo`}
                      className="aspect-[1586/992] h-auto w-full object-cover object-top"
                      loading="lazy"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => openScene(index % productScenes.length)}
                  className="absolute right-6 bottom-6 inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/92 px-3 py-2 text-xs font-medium text-[var(--console-text)] opacity-0 shadow-lg transition-all duration-200 group-hover:opacity-100 group-focus-within:opacity-100 hover:scale-[1.02]"
                  aria-label={`Expand ${scene.title}`}
                >
                  <Expand className="size-3.5" />
                  Expand
                </button>
              </article>
            ))}
          </div>
        </div>
        </div>
      </section>

      {activeScene ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
          onClick={closeScene}
          role="dialog"
          aria-modal="true"
          aria-label={`${activeScene.title} preview`}
        >
          <div
            className="relative flex max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-[1.5rem] border border-white/20 bg-[#f7f7f7] shadow-[0_40px_120px_rgba(15,23,42,0.45)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-[var(--console-border)] bg-white px-5 py-4">
              <div>
                <p className="console-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--console-muted)]">
                  {activeScene.title}
                </p>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--console-text)]">
                  {activeScene.description}
                </p>
              </div>
              <button
                type="button"
                onClick={closeScene}
                className="rounded-full border border-[var(--console-border)] bg-[var(--console-surface-muted)] px-3 py-1.5 text-xs font-medium text-[var(--console-text)] transition-colors hover:bg-white"
              >
                Close
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 border-b border-[var(--console-border)] bg-[rgba(255,255,255,0.82)] px-4 py-3">
              <button
                type="button"
                onClick={showPreviousScene}
                className="inline-flex items-center gap-2 rounded-full border border-[var(--console-border)] bg-white px-3 py-2 text-xs font-medium text-[var(--console-text)] transition-colors hover:bg-[var(--console-surface-muted)]"
              >
                <ChevronLeft className="size-4" />
                Previous
              </button>
              <p className="console-mono text-[11px] uppercase tracking-[0.16em] text-[var(--console-muted)]">
                Click outside to close
              </p>
              <button
                type="button"
                onClick={showNextScene}
                className="inline-flex items-center gap-2 rounded-full border border-[var(--console-border)] bg-white px-3 py-2 text-xs font-medium text-[var(--console-text)] transition-colors hover:bg-[var(--console-surface-muted)]"
              >
                Next
                <ChevronRight className="size-4" />
              </button>
            </div>

            <div className="overflow-auto bg-[radial-gradient(circle_at_top,#ffffff,rgba(247,247,247,0.94)_55%,rgba(235,235,235,0.98))] p-4">
              <div className="mx-auto min-w-[56rem] overflow-hidden rounded-[1.25rem] border border-[var(--console-border)] bg-white shadow-[0_20px_60px_rgba(15,23,42,0.12)]">
                <img
                  src={activeScene.image}
                  alt={`${activeScene.title} enlarged preview`}
                  className="h-auto w-full object-cover object-top"
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ─── Features ────────────────────────────────────────── */

interface FeatureItem {
  icon: LucideIcon;
  title: string;
  description: string;
}

const features: FeatureItem[] = [
  {
    icon: BarChart3,
    title: "Dashboard & Activity Trends",
    description: "Track activity, tokens, models, bookmarks, and recent sessions at a glance.",
  },
  {
    icon: Bookmark,
    title: "Session Bookmarks",
    description: "Save important sessions and revisit them from the dashboard.",
  },
  {
    icon: Search,
    title: "Full-Text Search",
    description: "Search session titles and conversation content with highlighted matches.",
  },
  {
    icon: Eye,
    title: "Unified Timeline",
    description: "Browse sessions across all your AI agents in a single interface.",
  },
  {
    icon: Terminal,
    title: "Full Conversation Replay",
    description: "Read every message, tool call, and reasoning step exactly as it happened.",
  },
  {
    icon: ListTree,
    title: "File Change Tracking",
    description: "Jump to files that were read, edited, created, deleted, or moved.",
  },
  {
    icon: Keyboard,
    title: "Keyboard Navigation",
    description: "Navigate views, focus search, and move through groups from the keyboard.",
  },
  {
    icon: Timer,
    title: "Live Refresh",
    description: "File changes are picked up automatically, and the UI stays in sync.",
  },
  {
    icon: BarChart3,
    title: "Cost & Token Visibility",
    description: "See token totals, cache tokens, model usage, and session cost.",
  },
  {
    icon: Database,
    title: "SQLite-Backed Cache",
    description: "Reuse one local database for fast session restore and full-text indexing.",
  },
  {
    icon: Settings,
    title: "Zero Configuration",
    description: "Just run it. CodeSesh auto-discovers everything on your filesystem.",
  },
  {
    icon: Shield,
    title: "100% Local & Private",
    description: "Nothing leaves your machine. No accounts, no cloud sync, no telemetry.",
  },
];

export function Features() {
  return (
    <section className="px-6 pb-20" aria-label="Features">
      <div className="mx-auto max-w-5xl">
        <h2 className="console-mono mb-2 text-center text-xs font-bold uppercase tracking-[0.16em] text-[var(--console-muted)]">
          Features
        </h2>
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <li key={f.title}>
              <FeatureCard {...f} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function FeatureCard({ icon: Icon, title, description }: FeatureItem) {
  return (
    <div className="rounded-sm border border-[var(--console-border)] bg-white p-5">
      <div className="mb-3 flex size-8 items-center justify-center rounded-sm border border-[var(--console-border)] bg-[var(--console-surface-muted)]">
        <Icon className="size-4 text-[var(--console-accent)]" />
      </div>
      <h3 className="console-mono text-xs font-bold text-[var(--console-text)]">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--console-muted)]">{description}</p>
    </div>
  );
}

/* ─── Agents ──────────────────────────────────────────── */

const agents = [
  { name: "Claude Code", icon: "/icon/agent/claudecode.svg" },
  { name: "Cursor", icon: "/icon/agent/cursor.svg" },
  { name: "Kimi", icon: "/icon/agent/kimi.svg" },
  { name: "Codex", icon: "/icon/agent/codex.svg" },
  { name: "OpenCode", icon: "/icon/agent/opencode.svg" },
];

export function Agents() {
  return (
    <section className="px-6 pb-20" aria-label="Supported AI Agents">
      <div className="mx-auto max-w-5xl">
        <h2 className="console-mono mb-2 text-center text-xs font-bold uppercase tracking-[0.16em] text-[var(--console-muted)]">
          Supported Agents
        </h2>
        <ul className="mt-10 grid grid-cols-2 justify-items-center gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {agents.map((a) => (
            <li
              key={a.name}
              className="flex w-full max-w-[160px] flex-col items-center gap-2 rounded-sm border border-[var(--console-border)] bg-white px-4 py-5"
            >
              <img src={a.icon} alt={a.name} className="size-8 object-contain" width="32" height="32" loading="lazy" />
              <span className="console-mono text-xs font-semibold text-[var(--console-text)]">
                {a.name}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ─── Footer ──────────────────────────────────────────── */

export function Footer() {
  return (
    <footer className="border-t border-[var(--console-border)] px-6 py-8">
      <div className="mx-auto flex max-w-5xl items-center justify-between">
        <span className="console-mono text-xs text-[var(--console-muted)]">CodeSesh</span>
        <span className="console-mono text-xs text-[var(--console-muted)]">
          &copy; {new Date().getFullYear()}
        </span>
      </div>
    </footer>
  );
}
