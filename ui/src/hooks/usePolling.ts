import { useState, useEffect, useRef, useCallback } from "react";

interface UsePollingResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
  stale: boolean;
  refresh: () => void;
}

export function usePolling<T>(url: string, intervalMs: number): UsePollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const mountedRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    // Abort any in-flight request
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json() as T;
      if (mountedRef.current) {
        setData(json);
        setError(null);
        setLastUpdated(Date.now());
        setLoading(false);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (mountedRef.current) {
        setError(String(err));
        setLoading(false);
      }
    }
  }, [url]);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    const id = setInterval(fetchData, intervalMs);
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      clearInterval(id);
    };
  }, [fetchData, intervalMs]);

  // Stale if last update was more than 2x the polling interval ago
  const stale = lastUpdated !== null && Date.now() - lastUpdated > intervalMs * 2;

  return { data, loading, error, lastUpdated, stale, refresh: fetchData };
}
