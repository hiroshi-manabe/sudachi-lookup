"use client";

import { useEffect, useRef, useState } from "react";
import type { LookupResult, WorkerResponse } from "./lookup-types";

const INITIAL_QUERY = "選挙";

export function LookupApp() {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const [query, setQuery] = useState(INITIAL_QUERY);
  const [results, setResults] = useState<LookupResult[]>([]);
  const [status, setStatus] = useState("Loading local dictionary…");
  const [dataset, setDataset] = useState("sample");
  const [activeIndex, setActiveIndex] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("./search.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        setDataset(message.dataset);
        setStatus(`${message.entries} entries · ${message.aliases} searchable forms`);
        search(INITIAL_QUERY, worker);
      } else if (message.type === "results") {
        if (message.requestId !== requestIdRef.current) return;
        setResults(message.results);
        setActiveIndex(0);
        setExpandedId(null);
      } else {
        setStatus(message.message);
      }
    };

    worker.postMessage({ type: "init" });
    return () => worker.terminate();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function search(nextQuery: string, worker = workerRef.current) {
    if (!worker) return;
    const requestId = ++requestIdRef.current;
    worker.postMessage({ type: "search", requestId, query: nextQuery });
  }

  function updateQuery(nextQuery: string) {
    setQuery(nextQuery);
    if (!composingRef.current) search(nextQuery);
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && results[activeIndex]?.splits) {
      event.preventDefault();
      const result = results[activeIndex];
      setExpandedId((id) => (id === result.id ? null : result.id));
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">酢</span>
          <span>Sudachi Lookup</span>
        </div>
        <span className="edition">{
          dataset === "sample"
            ? "Sample dataset"
            : dataset.startsWith("full-") ? "SudachiDict Full" : "SudachiDict Core"
        }</span>
      </header>

      <section className="search-panel" aria-label="Dictionary search">
        <label className="search-label" htmlFor="lookup-query">Search the Sudachi lexicon</label>
        <div className="search-row">
          <input
            ref={inputRef}
            id="lookup-query"
            className="search-input"
            value={query}
            placeholder="選挙管理委員会"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => updateQuery(event.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              updateQuery(event.currentTarget.value);
            }}
            onKeyDown={handleInputKeyDown}
            aria-controls="lookup-results"
            aria-activedescendant={results[activeIndex] ? `result-${results[activeIndex].id}` : undefined}
          />
          <kbd className="shortcut">⌘ K</kbd>
        </div>
        <div className="search-meta">
          <span className="privacy-note">Queries stay in this browser</span>
          <span>{status}</span>
        </div>
      </section>

      <section aria-labelledby="results-heading" aria-live="polite">
        <div className="results-header">
          <h2 className="results-title" id="results-heading">Matches</h2>
          <span className="result-count">
            {results.length} {results.length === 1 ? "result" : "results"}
          </span>
        </div>

        <div className="results" id="lookup-results" role="listbox">
          {results.map((result, index) => {
            const expanded = expandedId === result.id;
            return (
              <button
                type="button"
                className="result-card"
                id={`result-${result.id}`}
                key={result.id}
                role="option"
                aria-selected={index === activeIndex}
                aria-expanded={result.splits ? expanded : undefined}
                data-active={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => result.splits && setExpandedId(expanded ? null : result.id)}
              >
                <span className="result-main">
                  <span>
                    <span className="surface" lang="ja">{result.surface}</span>
                    <span className="reading" lang="ja">{result.readingForm}</span>
                  </span>
                  <span className="details">
                    <span className="form-line"><span className="form-label">Part of speech</span>{result.pos}</span>
                    <span className="form-line"><span className="form-label">Normalized</span>{result.normalizedForm}</span>
                  </span>
                  {result.splits ? (
                    <span className="expand-hint">
                      Split modes <span className="expand-symbol" aria-hidden="true">+</span>
                    </span>
                  ) : <span className="expand-hint">Single unit</span>}
                </span>
                {expanded && result.splits ? <SplitPanel result={result} /> : null}
              </button>
            );
          })}
          {!results.length ? (
            <div className="empty">No prefix matches.</div>
          ) : null}
        </div>
      </section>

      <footer className="footer">
        <span>{
          dataset === "sample"
            ? "Small local development fixture"
            : dataset.startsWith("full-") ? "SudachiDict Full 20260428" : "SudachiDict Core 20260428"
        }</span>
        <span>Binary data decoded and searched inside a Web Worker</span>
      </footer>
    </div>
  );
}

function SplitPanel({ result }: { result: LookupResult }) {
  if (!result.splits) return null;
  return (
    <span className="split-panel">
      <SplitRow mode="C" segments={result.splits.c} />
      <SplitRow mode="B" segments={result.splits.b} />
      <SplitRow mode="A" segments={result.splits.a} />
    </span>
  );
}

function SplitRow({ mode, segments }: { mode: string; segments: string[] }) {
  return (
    <span className="split-row">
      <span className="mode">{mode}</span>
      <span className="segments" lang="ja">
        {segments.map((segment, index) => (
          <span key={`${segment}-${index}`}>
            {index > 0 ? <span className="separator"> / </span> : null}
            {segment}
          </span>
        ))}
      </span>
    </span>
  );
}
