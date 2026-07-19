"use client";

import { useEffect, useRef, useState } from "react";
import type { LookupResult, UnitMode, WorkerResponse } from "./lookup-types";

const INITIAL_QUERY = "";
const INITIAL_RESULT_SLOTS = 20;
type SearchState = "loading" | "idle" | "searching" | "hydrating" | "settled" | "error";
type ResultSlot = { id: number | null; result: LookupResult | null };

export function LookupApp() {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const loadingMoreRequestRef = useRef(false);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const queryRef = useRef(INITIAL_QUERY);
  const [query, setQuery] = useState(INITIAL_QUERY);
  const [resultSlots, setResultSlots] = useState<ResultSlot[]>([]);
  const [status, setStatus] = useState("Loading local dictionary…");
  const [dataset, setDataset] = useState("sample");
  const [activeIndex, setActiveIndex] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [automaticLoadBlocked, setAutomaticLoadBlocked] = useState(false);
  const [searchState, setSearchState] = useState<SearchState>("loading");

  useEffect(() => {
    const initialQuery = queryFromLocation();
    queryRef.current = initialQuery;
    setQuery(initialQuery);

    const worker = new Worker(new URL("./search.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        setDataset(message.dataset);
        setStatus(`${message.entries} entries · ${message.aliases} searchable forms`);
        search(queryRef.current, worker);
      } else if (message.type === "result-slots") {
        if (message.requestId !== requestIdRef.current) return;
        setResultSlots((current) => message.append
          ? appendUniqueSlots(current, message.ids)
          : message.ids.map((id) => ({ id, result: null })),
        );
        setHasMore(message.hasMore);
        if (!message.append) {
          setActiveIndex(0);
          setExpandedId(null);
          setSearchState(message.ids.length ? "hydrating" : "settled");
        }
      } else if (message.type === "result-batch") {
        if (message.requestId !== requestIdRef.current) return;
        setResultSlots((current) => fillResultSlots(current, message.results));
        if (message.complete) {
          loadingMoreRequestRef.current = false;
          setLoadingMore(false);
          setAutomaticLoadBlocked(false);
          setSearchState("settled");
        }
      } else {
        if (message.requestId && message.requestId !== requestIdRef.current) return;
        loadingMoreRequestRef.current = false;
        setLoadingMore(false);
        setAutomaticLoadBlocked(true);
        setSearchState("error");
        setStatus(message.message);
      }
    };

    const onPopState = () => {
      const nextQuery = queryFromLocation();
      queryRef.current = nextQuery;
      setQuery(nextQuery);
      search(nextQuery, worker);
    };

    window.addEventListener("popstate", onPopState);
    worker.postMessage({ type: "init" });
    return () => {
      window.removeEventListener("popstate", onPopState);
      worker.terminate();
    };
  }, []);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMore || loadingMore || automaticLoadBlocked) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) requestMore();
      },
      { rootMargin: "500px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [automaticLoadBlocked, hasMore, loadingMore, resultSlots.length]);

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
    loadingMoreRequestRef.current = false;
    setResultSlots([]);
    setActiveIndex(0);
    setExpandedId(null);
    setHasMore(false);
    setLoadingMore(false);
    setAutomaticLoadBlocked(false);
    if (!nextQuery.normalize("NFKC").trim()) {
      setSearchState("idle");
      return;
    }
    setResultSlots(createPendingSlots(INITIAL_RESULT_SLOTS));
    setSearchState("searching");
    worker.postMessage({ type: "search", requestId, query: nextQuery });
  }

  function requestMore() {
    const worker = workerRef.current;
    if (!worker || !hasMore || loadingMoreRequestRef.current) return;
    loadingMoreRequestRef.current = true;
    setLoadingMore(true);
    setAutomaticLoadBlocked(false);
    worker.postMessage({
      type: "more",
      requestId: requestIdRef.current,
      query: queryRef.current,
    });
  }

  function updateQuery(nextQuery: string) {
    queryRef.current = nextQuery;
    setQuery(nextQuery);
    if (composingRef.current) return;
    updateQueryUrl(nextQuery, "replace");
    search(nextQuery);
  }

  function navigateToComponent(nextQuery: string) {
    queryRef.current = nextQuery;
    setQuery(nextQuery);
    setExpandedId(null);
    updateQueryUrl(nextQuery, "push");
    search(nextQuery);
    inputRef.current?.focus();
  }

  function toggleResult(result: LookupResult) {
    if (!result.splits) return;
    setExpandedId((id) => (id === result.id ? null : result.id));
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => findLoadedSlot(resultSlots, index, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => findLoadedSlot(resultSlots, index, -1));
    } else if (event.key === "Enter" && resultSlots[activeIndex]?.result?.splits) {
      event.preventDefault();
      toggleResult(resultSlots[activeIndex].result);
    }
  }

  const loadedCount = resultSlots.reduce((count, slot) => count + Number(Boolean(slot.result)), 0);

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
          />
          <kbd className="shortcut">⌘ K</kbd>
        </div>
        <div className="search-meta">
          <span className="privacy-note">Queries stay in this browser</span>
          <span>{status}</span>
        </div>
      </section>

      <section
        aria-labelledby="results-heading"
        aria-live="polite"
        aria-busy={searchState === "loading" || searchState === "searching" || searchState === "hydrating"}
      >
        <div className="results-header">
          <h2 className="results-title" id="results-heading">Matches</h2>
          <span className="result-count">{
            searchState === "loading"
              ? "Loading…"
              : searchState === "idle"
                ? "0 results"
              : searchState === "searching"
                ? "Searching…"
                : searchState === "hydrating"
                  ? `${loadedCount} of ${resultSlots.length} loaded`
                : searchState === "error"
                  ? "Unavailable"
                  : `${loadedCount}${hasMore ? "+" : ""} ${loadedCount === 1 ? "result" : "results"}`
          }</span>
        </div>

        <div className="results" id="lookup-results" role="list">
          {resultSlots.map((slot, index) => {
            const result = slot.result;
            if (!result) return <ResultSkeleton key={slot.id ?? `pending-${index}`} />;
            const expanded = expandedId === result.id;
            const panelId = `split-${result.id}`;
            return (
              <article
                className="result-card"
                id={`result-${result.id}`}
                key={result.id}
                role="listitem"
                data-active={index === activeIndex}
                data-expandable={Boolean(result.splits)}
                data-expanded={expanded}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => toggleResult(result)}
              >
                <div className="result-main">
                  <div className="entry-identity">
                    <div className="entry-heading" lang="ja">
                      <UnitBadge mode={result.unit} />
                      <ComponentSequence
                        segments={result.structure}
                        interactive={
                          result.unit !== "A" || shouldNavigateToSurface(query, result.surface)
                        }
                        onNavigate={navigateToComponent}
                      />
                    </div>
                    <span className="reading" lang="ja">{result.readingForm}</span>
                  </div>
                  <div className="details">
                    <span className="form-line"><span className="form-label">Part of speech</span>{result.pos}</span>
                    <span className="form-line"><span className="form-label">Normalized</span>{result.normalizedForm}</span>
                  </div>
                  {result.splits ? (
                    <button
                      type="button"
                      className="expand-control"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      aria-label={`${expanded ? "Hide" : "Show"} split modes for ${result.surface}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleResult(result);
                      }}
                    >
                      <span>Split modes</span>
                      <span className="expand-symbol" aria-hidden="true">+</span>
                    </button>
                  ) : <span className="expand-hint">A unit</span>}
                </div>
                {expanded && result.splits ? (
                  <SplitPanel id={panelId} result={result} onNavigate={navigateToComponent} />
                ) : null}
              </article>
            );
          })}
          {!resultSlots.length ? (
            <div className="empty">{
              searchState === "loading"
                ? "Loading dictionary…"
                : searchState === "idle"
                  ? "Enter a word to search."
                : searchState === "searching"
                  ? "Searching…"
                  : searchState === "error"
                    ? "Search unavailable."
                    : "No prefix matches."
            }</div>
          ) : null}
        </div>
        {resultSlots.length ? (
          <div className="result-continuation">
            {hasMore ? (
              <button
                ref={loadMoreRef}
                type="button"
                className="load-more"
                disabled={loadingMore}
                onClick={requestMore}
              >
                {loadingMore
                  ? "Loading more…"
                  : automaticLoadBlocked ? "Retry loading more" : "Load more results"}
              </button>
            ) : <span className="result-end">End of results</span>}
          </div>
        ) : null}
      </section>

      <footer className="footer">
        <span>{
          dataset === "sample"
            ? "Small local development fixture"
            : dataset.startsWith("full-") ? "SudachiDict Full 20260428" : "SudachiDict Core 20260428"
        }</span>
        <span>Binary data decoded and searched inside a Web Worker</span>
        <a className="footer-link" href="/notices/">Dictionary notices</a>
      </footer>
    </div>
  );
}

function createPendingSlots(count: number): ResultSlot[] {
  return Array.from({ length: count }, () => ({ id: null, result: null }));
}

function appendUniqueSlots(current: ResultSlot[], ids: number[]) {
  const currentIds = new Set(current.flatMap((slot) => slot.id === null ? [] : [slot.id]));
  return [
    ...current,
    ...ids.filter((id) => !currentIds.has(id)).map((id) => ({ id, result: null })),
  ];
}

function fillResultSlots(current: ResultSlot[], results: LookupResult[]) {
  if (!results.length) return current;
  const byId = new Map(results.map((result) => [result.id, result]));
  return current.map((slot) => slot.id !== null && byId.has(slot.id)
    ? { ...slot, result: byId.get(slot.id)! }
    : slot,
  );
}

function findLoadedSlot(slots: ResultSlot[], current: number, direction: 1 | -1) {
  for (let index = current + direction; index >= 0 && index < slots.length; index += direction) {
    if (slots[index].result) return index;
  }
  return current;
}

function ResultSkeleton() {
  return (
    <article className="result-card result-skeleton" role="listitem" aria-hidden="true">
      <div className="result-main">
        <div className="skeleton-group">
          <span className="skeleton-line skeleton-heading" />
          <span className="skeleton-line skeleton-reading" />
        </div>
        <div className="skeleton-group">
          <span className="skeleton-line skeleton-detail" />
          <span className="skeleton-line skeleton-detail skeleton-detail-short" />
        </div>
        <span className="skeleton-line skeleton-action" />
      </div>
    </article>
  );
}

function SplitPanel({
  id,
  result,
  onNavigate,
}: {
  id: string;
  result: LookupResult;
  onNavigate: (query: string) => void;
}) {
  if (!result.splits) return null;
  return (
    <div className="split-panel" id={id}>
      {result.unit === "C" && result.splits.b ? (
        <SplitRow mode="B" segments={result.splits.b} onNavigate={onNavigate} />
      ) : null}
      <SplitRow mode="A" segments={result.splits.a} onNavigate={onNavigate} />
    </div>
  );
}

function SplitRow({
  mode,
  segments,
  onNavigate,
}: {
  mode: UnitMode;
  segments: string[];
  onNavigate: (query: string) => void;
}) {
  return (
    <div className="split-row">
      <UnitBadge mode={mode} />
      <ComponentSequence segments={segments} interactive onNavigate={onNavigate} />
    </div>
  );
}

function UnitBadge({ mode }: { mode: UnitMode }) {
  return <span className="mode" aria-label={`${mode} unit`}>{mode}</span>;
}

function ComponentSequence({
  segments,
  interactive,
  onNavigate,
}: {
  segments: string[];
  interactive: boolean;
  onNavigate: (query: string) => void;
}) {
  return (
    <span className="segments">
      {segments.map((segment, index) => (
        <span className="segment-item" key={`${segment}-${index}`}>
          {index > 0 ? <span className="separator" aria-hidden="true">/</span> : null}
          {interactive ? (
            <button
              type="button"
              className="component-link"
              aria-label={`Search for ${segment}`}
              onClick={(event) => {
                event.stopPropagation();
                onNavigate(segment);
              }}
            >
              {segment}
            </button>
          ) : <span className="surface">{segment}</span>}
        </span>
      ))}
    </span>
  );
}

function queryFromLocation() {
  return new URL(window.location.href).searchParams.get("q") || INITIAL_QUERY;
}

function updateQueryUrl(query: string, mode: "push" | "replace") {
  const url = new URL(window.location.href);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  window.history[`${mode}State`]({ query }, "", url);
}

function shouldNavigateToSurface(query: string, surface: string) {
  return normalizeNavigationText(query) !== normalizeNavigationText(surface);
}

function normalizeNavigationText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("ja-JP").trim();
}
