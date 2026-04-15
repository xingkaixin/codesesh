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
  type LucideIcon,
} from "lucide-react";

/* ─── Header ──────────────────────────────────────────── */

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--console-border)] bg-white/85 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <a href="/" className="flex items-center gap-2 text-[var(--console-text)]">
          <img src="/logo.svg" alt="CodeSesh" className="h-6 w-6 rounded-sm" />
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
            v0.1.0
          </span>
        </nav>
      </div>
    </header>
  );
}

/* ─── Hero ────────────────────────────────────────────── */

const installSteps = [
  { prompt: "$", command: "npx codesesh" },
  { prompt: "→", command: "Scanning sessions..." },
  { prompt: "✔", command: "8 sessions discovered across 3 agents" },
  { prompt: "ℹ", command: "http://localhost:4321" },
];

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
          <img src="/logo.svg" alt="CodeSesh" className="h-20 w-20" />
        </div>
        <h1 className="console-mono text-3xl font-bold tracking-tight text-[var(--console-accent-strong)] md:text-4xl">
          See every AI coding session,
          <br />
          in one place.
        </h1>
        <p className="mx-auto mt-5 max-w-md text-sm leading-relaxed text-[var(--console-muted)]">
          Your sessions are scattered across tools and directories. CodeSesh finds them all and
          puts them in one place.
        </p>

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
            <div className="space-y-1.5">
              {installSteps.map((step) => (
                <div key={step.command} className="flex items-start gap-3">
                  <span className="console-mono shrink-0 w-4 text-right text-xs text-[#64748b]">
                    {step.prompt}
                  </span>
                  <code
                    className={`console-mono text-sm ${
                      step.prompt === "$"
                        ? "font-semibold text-[#4ade80]"
                        : step.prompt === "✔"
                          ? "text-[#4ade80]"
                          : step.prompt === "ℹ"
                            ? "text-[#38bdf8]"
                            : "text-[#94a3b8]"
                    }`}
                  >
                    {step.command}
                  </code>
                </div>
              ))}
            </div>
          </div>
          <p className="console-mono mt-3 text-center text-xs text-[var(--console-accent)]">
            Requires Node.js 20+ · Works with pnpm, npm, or bun
          </p>
        </div>
      </div>
    </section>
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
    icon: Eye,
    title: "Unified Timeline",
    description: "Browse sessions across all your AI agents in a single, searchable interface.",
  },
  {
    icon: Terminal,
    title: "Full Conversation Replay",
    description: "Read every message, tool call, and reasoning step exactly as it happened.",
  },
  {
    icon: BarChart3,
    title: "Cost & Token Visibility",
    description: "See exactly how many tokens and dollars each session consumed.",
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
  {
    icon: Timer,
    title: "Instant Startup",
    description: "Scans and launches in seconds, then opens your browser automatically.",
  },
];

export function Features() {
  return (
    <section className="px-6 pb-20">
      <div className="mx-auto max-w-5xl">
        <h2 className="console-mono mb-2 text-center text-xs font-bold uppercase tracking-[0.16em] text-[var(--console-muted)]">
          Features
        </h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <FeatureCard key={f.title} {...f} />
          ))}
        </div>
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
    <section className="px-6 pb-20">
      <div className="mx-auto max-w-5xl">
        <h2 className="console-mono mb-2 text-center text-xs font-bold uppercase tracking-[0.16em] text-[var(--console-muted)]">
          Supported Agents
        </h2>
        <div className="mt-10 grid grid-cols-2 justify-items-center gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {agents.map((a) => (
            <div
              key={a.name}
              className="flex w-full max-w-[160px] flex-col items-center gap-2 rounded-sm border border-[var(--console-border)] bg-white px-4 py-5"
            >
              <img src={a.icon} alt={a.name} className="size-8 object-contain" />
              <span className="console-mono text-xs font-semibold text-[var(--console-text)]">
                {a.name}
              </span>
            </div>
          ))}
        </div>
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
