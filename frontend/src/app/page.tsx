import { getApiBaseUrl } from "@/lib/api";

export const dynamic = "force-dynamic";

type HealthPayload = { status?: string };

async function fetchHealth(): Promise<HealthPayload | null> {
  const base = getApiBaseUrl();
  try {
    const response = await fetch(`${base}/api/v1/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    return (await response.json()) as HealthPayload;
  } catch {
    return null;
  }
}

export default async function Home() {
  const health = await fetchHealth();
  const connected = health?.status === "ok";

  return (
    <div className="relative isolate min-h-screen overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_55%_at_50%_-10%,rgba(99,102,241,0.22),transparent),radial-gradient(60%_40%_at_100%_0%,rgba(14,165,233,0.18),transparent),radial-gradient(50%_35%_at_0%_100%,rgba(244,63,94,0.12),transparent)] dark:bg-[radial-gradient(80%_55%_at_50%_-10%,rgba(129,140,248,0.28),transparent),radial-gradient(60%_40%_at_100%_0%,rgba(56,189,248,0.2),transparent),radial-gradient(50%_35%_at_0%_100%,rgba(251,113,133,0.14),transparent)]"
      />
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-20 sm:px-10">
        <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">
          Monorepo
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Next.js + FastAPI
        </h1>
        <p className="mt-4 max-w-xl text-lg leading-relaxed text-muted">
          A minimal, typed stack: React Server Components on the web, OpenAPI
          on the API. Run both dev servers and this page confirms they are
          wired together.
        </p>

        <div className="mt-10 rounded-2xl border border-ring bg-card p-6 shadow-[0_1px_0_rgba(255,255,255,0.06)_inset] backdrop-blur-xl dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${connected ? "bg-emerald-500 shadow-[0_0_0_6px_rgba(16,185,129,0.18)]" : "bg-amber-500 shadow-[0_0_0_6px_rgba(245,158,11,0.2)]"}`}
            />
            <p className="text-sm font-medium text-foreground">
              {connected ? "API reachable" : "API offline or unreachable"}
            </p>
          </div>
          <dl className="mt-6 grid gap-4 font-mono text-xs text-muted sm:grid-cols-2">
            <div className="rounded-lg bg-background/50 p-3 ring-1 ring-ring">
              <dt className="text-[0.65rem] tracking-wider uppercase">
                Frontend
              </dt>
              <dd className="mt-1 text-foreground">Next.js · React · TS</dd>
            </div>
            <div className="rounded-lg bg-background/50 p-3 ring-1 ring-ring">
              <dt className="text-[0.65rem] tracking-wider uppercase">
                Backend
              </dt>
              <dd className="mt-1 text-foreground">FastAPI · Python 3.11+</dd>
            </div>
            <div className="rounded-lg bg-background/50 p-3 ring-1 ring-ring sm:col-span-2">
              <dt className="text-[0.65rem] tracking-wider uppercase">
                Health
              </dt>
              <dd className="mt-1 break-all text-foreground">
                {getApiBaseUrl()}/api/v1/health
              </dd>
            </div>
          </dl>
        </div>

        <p className="mt-10 text-sm text-muted">
          See <span className="font-mono text-foreground">README.md</span> at
          the repo root for run instructions and environment variables.
        </p>
      </div>
    </div>
  );
}
