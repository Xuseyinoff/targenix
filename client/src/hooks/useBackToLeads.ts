import { useCallback } from "react";
import { useLocation, useSearch } from "wouter";

/**
 * Navigate to `/leads` while preserving the list filter query string.
 *
 * Works when the current route carried the same params from the list (e.g.
 * `/leads/123?platform=fb&status=PENDING`). `useSearch()` returns the part
 * after `?` (no leading `?`), matching Wouter’s `useSearch` contract.
 */
export function useBackToLeads() {
  const [, setLocation] = useLocation();
  const search = useSearch();

  return useCallback(() => {
    const qs = search.trim();
    setLocation(qs ? `/leads?${qs}` : "/leads", { replace: true });
  }, [setLocation, search]);
}
