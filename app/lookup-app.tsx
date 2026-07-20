"use client";

import { useEffect, useRef, useState } from "react";
import type { LookupResult, StructurePosition, UnitMode, WorkerResponse } from "./lookup-types";
import releaseConfig from "../config/dictionary-release.json";

const INITIAL_QUERY = "";
const INITIAL_RESULT_SLOTS = 20;
const WEB_SEARCH_URL = "https://www.google.com/search?q=";
const SOURCE_REPOSITORY_URL = "https://github.com/hiroshi-manabe/sudachi-lookup";
type SearchState = "loading" | "idle" | "searching" | "hydrating" | "settled" | "error";
type ResultSlot = { id: number | null; result: LookupResult | null };
type StructureLookup = { componentId: number; position: StructurePosition; component: LookupResult | null };

export function LookupApp() {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const loadingMoreRequestRef = useRef(false);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchPanelRef = useRef<HTMLElement>(null);
  const structureControlRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const queryRef = useRef(INITIAL_QUERY);
  const structureRef = useRef<StructureLookup | null>(null);
  const [query, setQuery] = useState(INITIAL_QUERY);
  const [structureLookup, setStructureLookup] = useState<StructureLookup | null>(null);
  const [resultSlots, setResultSlots] = useState<ResultSlot[]>([]);
  const [status, setStatus] = useState("辞書を読み込んでいます…");
  const [dataset, setDataset] = useState("sample");
  const [activeIndex, setActiveIndex] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [automaticLoadBlocked, setAutomaticLoadBlocked] = useState(false);
  const [searchState, setSearchState] = useState<SearchState>("loading");

  useEffect(() => {
    const initialMode = lookupFromLocation();
    const initialQuery = initialMode.query;
    queryRef.current = initialQuery;
    structureRef.current = initialMode.structure;
    setQuery(initialQuery);
    setStructureLookup(initialMode.structure);

    const worker = new Worker(new URL("./search.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        setDataset(message.dataset);
        setStatus(`${message.entries.toLocaleString("ja-JP")}語 · ${message.aliases.toLocaleString("ja-JP")}検索形`);
        if (structureRef.current) searchStructure(structureRef.current, worker);
        else search(queryRef.current, worker);
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
      } else if (message.type === "structure-component") {
        if (message.requestId !== requestIdRef.current) return;
        setStructureLookup((current) => {
          if (!current || current.componentId !== message.component.id) return current;
          const next = { ...current, component: message.component };
          structureRef.current = next;
          return next;
        });
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
      const next = lookupFromLocation();
      queryRef.current = next.query;
      structureRef.current = next.structure;
      setQuery(next.query);
      setStructureLookup(next.structure);
      if (next.structure) searchStructure(next.structure, worker);
      else search(next.query, worker);
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
        if (structureRef.current) clearStructureLookup();
        else {
          inputRef.current?.focus();
          inputRef.current?.select();
        }
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

  function searchStructure(next: StructureLookup, worker = workerRef.current) {
    if (!worker) return;
    const requestId = ++requestIdRef.current;
    loadingMoreRequestRef.current = false;
    setResultSlots(createPendingSlots(INITIAL_RESULT_SLOTS));
    setActiveIndex(0);
    setExpandedId(null);
    setHasMore(false);
    setLoadingMore(false);
    setAutomaticLoadBlocked(false);
    setSearchState("searching");
    worker.postMessage({
      type: "structure-search",
      requestId,
      componentId: next.componentId,
      position: next.position,
    });
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
    structureRef.current = null;
    setStructureLookup(null);
    queryRef.current = nextQuery;
    setQuery(nextQuery);
    if (composingRef.current) return;
    updateQueryUrl(nextQuery, "replace");
    search(nextQuery);
  }

  function navigateToComponent(nextQuery: string) {
    structureRef.current = null;
    setStructureLookup(null);
    queryRef.current = nextQuery;
    setQuery(nextQuery);
    setExpandedId(null);
    updateQueryUrl(nextQuery, "push");
    search(nextQuery);
    returnToSearchControl("text");
  }

  function enterStructureLookup(result: LookupResult, position: StructurePosition) {
    const next = { componentId: result.id, position, component: result };
    structureRef.current = next;
    setStructureLookup(next);
    queryRef.current = "";
    setQuery("");
    updateStructureUrl(next, "push");
    searchStructure(next);
    returnToSearchControl("structure");
  }

  function switchStructurePosition(position: StructurePosition) {
    const current = structureRef.current;
    if (!current || current.position === position) return;
    const next = { ...current, position };
    structureRef.current = next;
    setStructureLookup(next);
    updateStructureUrl(next, "replace");
    searchStructure(next);
  }

  function clearStructureLookup() {
    structureRef.current = null;
    setStructureLookup(null);
    queryRef.current = "";
    setQuery("");
    updateQueryUrl("", "replace");
    search("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function returnToSearchControl(target: "text" | "structure") {
    requestAnimationFrame(() => {
      const control = target === "text" ? inputRef.current : structureControlRef.current;
      control?.focus({ preventScroll: true });
      searchPanelRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    });
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
            ? "サンプルデータ"
            : dataset.startsWith("full-") ? "SudachiDict Full" : "SudachiDict Core"
        }</span>
      </header>

      <section ref={searchPanelRef} className="search-panel" aria-label="辞書検索">
        {structureLookup
          ? <div className="search-label">構造一致</div>
          : <label className="search-label" htmlFor="lookup-query">Sudachi辞書を検索</label>}
        <div className="search-row">
          {structureLookup ? (
            <div
              ref={structureControlRef}
              className="structure-control"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Backspace" || event.key === "Delete") {
                  event.preventDefault();
                  clearStructureLookup();
                }
              }}
              aria-label="構造一致検索"
              aria-controls="lookup-results"
            >
              <span className="structure-token" lang="ja">
                <span>{structureLookup.component?.surface ?? "読み込み中…"}</span>
                <button type="button" onClick={clearStructureLookup} aria-label="構造一致検索を解除">×</button>
              </span>
              <span className="structure-position" aria-label="構造の位置">
                <button type="button" aria-pressed={structureLookup.position === "first"} onClick={() => switchStructurePosition("first")}>先頭</button>
                <button type="button" aria-pressed={structureLookup.position === "last"} onClick={() => switchStructurePosition("last")}>末尾</button>
              </span>
            </div>
          ) : (
            <input
              ref={inputRef}
              id="lookup-query"
              className="search-input"
              value={query}
              placeholder="見出し語を入力"
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
          )}
          <kbd className="shortcut">⌘ K</kbd>
        </div>
        <div className="search-meta">
          <span className="privacy-note">検索はブラウザ内で完結します</span>
          <span>{status}</span>
        </div>
      </section>

      <section
        aria-labelledby="results-heading"
        aria-live="polite"
        aria-busy={searchState === "loading" || searchState === "searching" || searchState === "hydrating"}
      >
        {structureLookup?.component ? (
          <p className="sr-only">
            「{structureLookup.component.surface}」を構造の{structureLookup.position === "first" ? "先頭" : "末尾"}に持つ語の検索結果
          </p>
        ) : null}
        <div className="results-header">
          <h2 className="results-title" id="results-heading">検索結果</h2>
          <span className="result-count">{
            searchState === "loading"
              ? "読み込み中…"
              : searchState === "idle"
                ? "0件"
              : searchState === "searching"
                ? "検索中…"
                : searchState === "hydrating"
                  ? `${loadedCount} / ${resultSlots.length}件を読み込み済み`
                : searchState === "error"
                  ? "利用できません"
                  : `${loadedCount.toLocaleString("ja-JP")}${hasMore ? "+" : ""}件`
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
                          result.unit !== "A" || shouldNavigateToValue(structureLookup ? "" : query, result.surface)
                        }
                        onNavigate={navigateToComponent}
                      />
                    </div>
                    <div className="entry-subline">
                      <span className="reading" lang="ja">{result.readingForm}</span>
                      <span className="entry-web-search">
                        <span className="entry-subline-separator" aria-hidden="true">·</span>
                        <a
                          className="web-search"
                          href={webSearchUrl(result.surface)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`「${result.surface}」をウェブで検索（新しいタブで開きます）`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <span>ウェブで検索</span>
                          <span aria-hidden="true">↗</span>
                        </a>
                      </span>
                      <span className="structure-match-actions">
                        <span className="entry-subline-separator" aria-hidden="true">·</span>
                        <span>構造一致:</span>
                        <button
                          type="button"
                          aria-label={`「${result.surface}」を構造の先頭に持つ語を検索`}
                          onClick={(event) => { event.stopPropagation(); enterStructureLookup(result, "first"); }}
                        >先頭</button>
                        <span aria-hidden="true">/</span>
                        <button
                          type="button"
                          aria-label={`「${result.surface}」を構造の末尾に持つ語を検索`}
                          onClick={(event) => { event.stopPropagation(); enterStructureLookup(result, "last"); }}
                        >末尾</button>
                      </span>
                    </div>
                  </div>
                  <div className="details">
                    <div className="form-line">
                      <span className="form-label">品詞</span>
                      <span className="form-value">{result.pos}</span>
                    </div>
                    <div className="form-line">
                      <span className="form-label">正規化形</span>
                      {shouldNavigateToValue(structureLookup ? "" : query, result.normalizedForm) ? (
                        <button
                          type="button"
                          className="form-link"
                          aria-label={`正規化形「${result.normalizedForm}」を検索`}
                          lang="ja"
                          onClick={(event) => {
                            event.stopPropagation();
                            navigateToComponent(result.normalizedForm);
                          }}
                        >
                          {result.normalizedForm}
                        </button>
                      ) : <span className="form-value" lang="ja">{result.normalizedForm}</span>}
                    </div>
                    {result.edition ? (
                      <div className="form-line">
                        <span className="form-label">収録</span>
                        <span className="form-value">{result.edition}</span>
                      </div>
                    ) : null}
                  </div>
                  <div className="result-actions">
                    {result.splits ? (
                      <button
                        type="button"
                        className="expand-control"
                        aria-expanded={expanded}
                        aria-controls={panelId}
                        aria-label={`「${result.surface}」の分割単位を${expanded ? "閉じる" : "開く"}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleResult(result);
                        }}
                      >
                        <span>分割単位</span>
                        <span className="expand-symbol" aria-hidden="true">+</span>
                      </button>
                    ) : <span className="expand-hint">A単位</span>}
                  </div>
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
                ? "辞書を読み込んでいます…"
                : searchState === "idle"
                  ? "検索語を入力してください。"
                : searchState === "searching"
                  ? "検索中…"
                  : searchState === "error"
                    ? "検索を利用できません。"
                    : structureLookup ? "一致する構造の語がありません。" : "一致する語がありません。"
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
                  ? "さらに読み込んでいます…"
                  : automaticLoadBlocked ? "もう一度読み込む" : "さらに読み込む"}
              </button>
            ) : <span className="result-end">すべての結果を表示しました</span>}
          </div>
        ) : null}
      </section>

      <footer className="footer">
        <span>{
          dataset === "sample"
            ? "ローカル開発用サンプル"
            : dataset.startsWith("full-")
              ? `SudachiDict Full ${releaseConfig.dictionaryVersion}`
              : `SudachiDict Core ${releaseConfig.dictionaryVersion}`
        }</span>
        <span>バイナリ辞書をWeb Worker内で検索</span>
        <span className="footer-links">
          <a className="footer-link" href="/notices/">辞書のライセンス情報</a>
          <a
            className="footer-link"
            href={SOURCE_REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHubリポジトリ（新しいタブで開きます）"
          >GitHub</a>
        </span>
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
  return <span className="mode" aria-label={`${mode}単位`}>{mode}</span>;
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
              aria-label={`「${segment}」を検索`}
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

function lookupFromLocation(): { query: string; structure: StructureLookup | null } {
  const parameters = new URL(window.location.href).searchParams;
  const position = parameters.get("structure");
  const componentId = Number(parameters.get("component"));
  if ((position === "first" || position === "last") && Number.isInteger(componentId) && componentId >= 0) {
    return { query: "", structure: { componentId, position, component: null } };
  }
  return { query: parameters.get("q") || INITIAL_QUERY, structure: null };
}

function updateQueryUrl(query: string, mode: "push" | "replace") {
  const url = new URL(window.location.href);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  url.searchParams.delete("structure");
  url.searchParams.delete("component");
  window.history[`${mode}State`]({ query }, "", url);
}

function updateStructureUrl(lookup: StructureLookup, mode: "push" | "replace") {
  const url = new URL(window.location.href);
  url.searchParams.delete("q");
  url.searchParams.set("structure", lookup.position);
  url.searchParams.set("component", String(lookup.componentId));
  window.history[`${mode}State`]({ structure: lookup.position, component: lookup.componentId }, "", url);
}

function shouldNavigateToValue(query: string, value: string) {
  return normalizeNavigationText(query) !== normalizeNavigationText(value);
}

function normalizeNavigationText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("ja-JP").trim();
}

function webSearchUrl(value: string) {
  return `${WEB_SEARCH_URL}${encodeURIComponent(value)}`;
}
