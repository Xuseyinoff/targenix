import { useState, useCallback, useDeferredValue } from "react";

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

export function useLeadFilters(): LeadFilters {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [platformFilter, setPlatformFilter] = useState("ALL");
  const [pageIdFilter, setPageIdFilter] = useState("ALL");
  const [formIdFilter, setFormIdFilter] = useState("ALL");

  const deferredSearch = useDeferredValue(search);

  const handleSearchChange = useCallback((val: string) => { setSearch(val); setPage(0); }, []);
  const handleStatusChange = useCallback((val: string) => { setStatusFilter(val); setPage(0); }, []);
  const handlePlatformChange = useCallback((val: string) => { setPlatformFilter(val); setPage(0); }, []);
  const handlePageIdChange = useCallback((val: string) => {
    setPageIdFilter(val);
    setFormIdFilter("ALL");
    setPage(0);
  }, []);
  const handleFormIdChange = useCallback((val: string) => { setFormIdFilter(val); setPage(0); }, []);

  const clearFilters = useCallback(() => {
    setSearch("");
    setStatusFilter("ALL");
    setPlatformFilter("ALL");
    setPageIdFilter("ALL");
    setFormIdFilter("ALL");
    setPage(0);
  }, []);

  const hasActiveFilters =
    statusFilter !== "ALL" || platformFilter !== "ALL" ||
    pageIdFilter !== "ALL" || formIdFilter !== "ALL" || !!search;

  return {
    page, setPage, search, statusFilter, platformFilter, pageIdFilter, formIdFilter,
    deferredSearch, hasActiveFilters,
    handleSearchChange, handleStatusChange, handlePlatformChange,
    handlePageIdChange, handleFormIdChange, clearFilters,
  };
}
