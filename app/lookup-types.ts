export type SplitView = {
  a: string[];
  b?: string[];
};

export type UnitMode = "A" | "B" | "C";

export type LookupResult = {
  id: number;
  surface: string;
  readingForm: string;
  normalizedForm: string;
  dictionaryForm: string;
  pos: string;
  unit: UnitMode;
  structure: string[];
  splits: SplitView | null;
};

export type WorkerResponse =
  | { type: "ready"; entries: number; aliases: number; dataset: string }
  | {
      type: "result-slots";
      requestId: number;
      query: string;
      ids: number[];
      append: boolean;
      hasMore: boolean;
    }
  | {
      type: "result-batch";
      requestId: number;
      query: string;
      results: LookupResult[];
      complete: boolean;
    }
  | { type: "error"; message: string; requestId?: number };
