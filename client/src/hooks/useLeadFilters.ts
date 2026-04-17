/**
 * Lead list filters synced to the URL query string (survives refresh & history back).
 * This app uses Wouter (not react-router-dom); `useLocation` + `useSearch` match the
 * usual React Router `useSearchParams` + `replace: true` pattern.
 */
import {
  useState,
  useCallback,
  useDeferredValue,
  useMemo,
} from "react";
import { useLocation, useSearch } from "wouter";

export interface LeadFilters {
  page: number;
  search: string;
  statusFilter: string;
  platformFilter: string;
  pageIdFilter: string;
  formIdFilter: string;
  deferredSearch: string;
  hasActiveFilters: boolean;
  setPage: (page: number) => void;
  handleSearchChange: (val: string) => void;
  handleStatusChange: (val: string) => void;
  handlePlatformChange: (val: string) => void;
  handlePageIdChange: (val: string) => void;
  handleFormIdChange: (val: string) => void;
  clearFilters: () => void;
}

/** Query keys for /leads — match product URL shape (platform, status, page, form). */
const Q = {
  platform: "platform",
  status: "status",
  page: "page",
  form: "form",
} as const;

function parsePlatform(sp: URLSearchParams): string {
  const v = sp.get(Q.platform);
  if (v === "fb" || v === "ig") return v;
  return "ALL";
}

function parseStatus(sp: URLSearchParams): string {
  const v = sp.get(Q.status);
  if (v === "PENDING" || v === "RECEIVED" || v === "FAILED") return v;
  return "ALL";
}

function parsePageId(sp: URLSearchParams): string {
  const v = sp.get(Q.page);
  if (!v || v === "ALL") return "ALL";
  return v;
}

function parseFormId(sp: URLSearchParams): string {
  const v = sp.get(Q.form);
  if (!v || v === "ALL") return "ALL";
  return v;
}

export function useLeadFilters(): LeadFilters {
  const [path, navigate] = useLocation();
  const searchFromUrl = useSearch();

  const {
    platformFilter,
    statusFilter,
    pageIdFilter,
    formIdFilter,
  } = useMemo(() => {
    const sp = new URLSearchParams(searchFromUrl || "");
    return {
      platformFilter: parsePlatform(sp),
      statusFilter: parseStatus(sp),
      pageIdFilter: parsePageId(sp),
      formIdFilter: parseFormId(sp),
    };
  }, [searchFromUrl]);

  const setSearchParams = useCallback(
    (
      nextInit:
        | URLSearchParams
        | ((prev: URLSearchParams) => URLSearchParams),
      options?: { replace?: boolean }
    ) => {
      const prev = new URLSearchParams(searchFromUrl || "");
      const next =
        typeof nextInit === "function" ? nextInit(prev) : nextInit;
      const q = next.toString();
      navigate(q ? `${path}?${q}` : path, {
        replace: options?.replace ?? false,
      });
    },
    [path, searchFromUrl, navigate]
  );

  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");

  const deferredSearch = useDeferredValue(search);

  const handleSearchChange = useCallback((val: string) => {
    setSearch(val);
    setPage(0);
  }, []);

  const handleStatusChange = useCallback(
    (val: string) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (val === "ALL") p.delete(Q.status);
          else p.set(Q.status, val);
          return p;
        },
        { replace: true }
      );
      setPage(0);
    },
    [setSearchParams]
  );

  const handlePlatformChange = useCallback(
    (val: string) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (val === "ALL") p.delete(Q.platform);
          else p.set(Q.platform, val);
          return p;
        },
        { replace: true }
      );
      setPage(0);
    },
    [setSearchParams]
  );

  const handlePageIdChange = useCallback(
    (val: string) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (val === "ALL") p.delete(Q.page);
          else p.set(Q.page, val);
          p.delete(Q.form);
          return p;
        },
        { replace: true }
      );
      setPage(0);
    },
    [setSearchParams]
  );

  const handleFormIdChange = useCallback(
    (val: string) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (val === "ALL") p.delete(Q.form);
          else p.set(Q.form, val);
          return p;
        },
        { replace: true }
      );
      setPage(0);
    },
    [setSearchParams]
  );

  const clearFilters = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: true });
    setSearch("");
    setPage(0);
  }, [setSearchParams]);

  const hasActiveFilters =
    statusFilter !== "ALL" ||
    platformFilter !== "ALL" ||
    pageIdFilter !== "ALL" ||
    formIdFilter !== "ALL" ||
    !!search;

  return {
    page,
    setPage,
    search,
    statusFilter,
    platformFilter,
    pageIdFilter,
    formIdFilter,
    deferredSearch,
    hasActiveFilters,
    handleSearchChange,
    handleStatusChange,
    handlePlatformChange,
    handlePageIdChange,
    handleFormIdChange,
    clearFilters,
  };
}
