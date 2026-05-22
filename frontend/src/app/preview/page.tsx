"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { getShipyardPreviewConfig, getShipyardRunMetrics, startShipyardPreview } from "@/lib/shipyard-api";
import type { ShipyardPreviewConfig, ShipyardPreviewInfo, ShipyardRunMetrics } from "@/types/shipyard";

function PreviewRunnerInner() {
  const searchParams = useSearchParams();
  const runId = searchParams.get("runId");
  const [config, setConfig] = useState<ShipyardPreviewConfig | null>(null);
  const [envText, setEnvText] = useState("");
  const [preview, setPreview] = useState<ShipyardPreviewInfo | null>(null);
  const [metrics, setMetrics] = useState<ShipyardRunMetrics | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    void Promise.all([getShipyardPreviewConfig(runId), getShipyardRunMetrics(runId)])
      .then(([nextConfig, nextMetrics]) => {
        if (cancelled) return;
        setConfig(nextConfig);
        setMetrics(nextMetrics);
        setEnvText(nextConfig.env_template);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load preview configuration.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!runId || isStarting) return;
    setError("");
    setIsStarting(true);
    try {
      setPreview(await startShipyardPreview(runId, envText));
      setMetrics(await getShipyardRunMetrics(runId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview startup failed.");
    } finally {
      setIsStarting(false);
    }
  };

  if (!runId) {
    return (
      <main className="shipyard-shell preview-page">
        <section className="preview-center-card">
          <strong>Missing run</strong>
          <p>Finish a build first, then continue to preview.</p>
          <Link className="continue-build-button" href="/">
            Back to planning
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shipyard-shell preview-page">
      <section className="preview-center-card" aria-label="Preview setup">
        {preview ? (
          <>
            <div className="preview-ready-mark" aria-hidden />
            <strong>Preview ready</strong>
            <p>The generated app is running locally.</p>
            <a className="continue-build-button" href={preview.preview_url} target="_blank" rel="noreferrer">
              Open preview
            </a>
            {metrics ? <PreviewMetrics metrics={metrics} /> : null}
            <div className="preview-command-list">
              <p>
                Frontend: <code>{preview.frontend_url}</code>
              </p>
              <p>
                Backend: <code>{preview.backend_url}</code>
              </p>
            </div>
          </>
        ) : (
          <form className="preview-center-form" onSubmit={submit}>
            <div>
              <strong>{isStarting ? "Setting up preview..." : "Start preview"}</strong>
              <p>
                {isLoading
                  ? "Checking the generated app configuration..."
                  : config?.env_required
                    ? config.env_notes
                    : "No required environment variables detected."}
              </p>
            </div>
            {config?.env_required ? (
              <textarea
                value={envText}
                onChange={(event) => setEnvText(event.target.value)}
                rows={Math.max(3, envText.split("\n").length)}
                disabled={isStarting}
                aria-label="Environment variables"
              />
            ) : null}
            {error ? <p className="preview-setup-error">{error}</p> : null}
            {metrics ? <PreviewMetrics metrics={metrics} compact /> : null}
            <button type="submit" className="continue-build-button" disabled={isLoading || isStarting}>
              {isStarting ? "Starting..." : "Continue"}
            </button>
            <Link className="preview-secondary-link" href={`/build?runId=${encodeURIComponent(runId)}`}>
              Back to build
            </Link>
          </form>
        )}
      </section>
    </main>
  );
}

function PreviewMetrics({ metrics, compact = false }: { metrics: ShipyardRunMetrics; compact?: boolean }) {
  const items = [
    ["Built in", formatDuration(metrics.built_in_seconds)],
    ["Agents run", String(metrics.agents_run)],
    ["Waves completed", String(metrics.waves_completed)],
    ["Files changed", String(metrics.files_changed)],
    ["Lines changed", `+${formatNumber(metrics.lines_added)} / -${formatNumber(metrics.lines_removed)}`],
    ["Checks passed", `${metrics.checks_passed} / ${metrics.checks_total}`],
    [metrics.token_usage_estimated ? "Tokens used est." : "Tokens used", formatCompactNumber(metrics.tokens_used)],
    ["Estimated AI cost", `$${metrics.estimated_cost_usd.toFixed(2)}`],
    ["Model", metrics.model || "deepseek-v4-pro"],
  ];

  return (
    <dl className={compact ? "preview-metrics preview-metrics-compact" : "preview-metrics"}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  if (minutes <= 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en").format(value);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export default function PreviewRunner() {
  return (
    <Suspense
      fallback={
        <main className="shipyard-shell preview-page">
          <section className="preview-center-card">
            <p className="message-meta">Loading preview...</p>
          </section>
        </main>
      }
    >
      <PreviewRunnerInner />
    </Suspense>
  );
}
