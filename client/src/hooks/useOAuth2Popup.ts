/**
 * useOAuth2Popup — generic OAuth2 integration popup hook.
 *
 * Drives the popup flow for any non-Google OAuth2 provider (HubSpot, Kommo,
 * Pipedrive, …). Calls `/api/oauth/{appKey}/initiate`; completion is signaled
 * via BroadcastChannel `targenix_oauth_{appKey}` or window.postMessage.
 *
 * IMPORTANT: Prefer `start(explicitAppKey)` when the caller just called
 * `setState` with the same key — React batches updates, so the hook prop can
 * still be stale for one tick (that used to fetch `/api/oauth//initiate`).
 */

import * as React from "react";

export type OAuth2IntegrationMessage =
  | {
      type: "oauth_integration_success";
      appKey: string;
      connectionId: number | null;
      oauthTokenId: number;
      email: string;
      displayName?: string;
    }
  | { type: "oauth_integration_error"; error?: string };

export interface UseOAuth2PopupOptions {
  /**
   * Default app key when `start()` is called with no arguments.
   * Callers that set React state and `start()` in the same handler must pass
   * `start(appKey)` explicitly.
   */
  appKey?: string;
  onConnected?: (connectionId: number | null, email: string, displayName?: string) => void;
  onError?: (message: string) => void;
}

export function useOAuth2Popup({
  appKey: defaultAppKey = "",
  onConnected,
  onError,
}: UseOAuth2PopupOptions) {
  const [isConnecting, setIsConnecting] = React.useState(false);
  const popupRef = React.useRef<Window | null>(null);
  const pollRef = React.useRef<number | null>(null);
  const completedRef = React.useRef(false);
  const flowCleanupRef = React.useRef<(() => void) | null>(null);

  const defaultAppKeyRef = React.useRef(defaultAppKey);
  React.useEffect(() => {
    defaultAppKeyRef.current = defaultAppKey;
  }, [defaultAppKey]);

  const onConnectedRef = React.useRef(onConnected);
  const onErrorRef = React.useRef(onError);
  React.useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);
  React.useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const stopWatch = React.useCallback(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    return () => {
      flowCleanupRef.current?.();
      flowCleanupRef.current = null;
      stopWatch();
    };
  }, [stopWatch]);

  const start = React.useCallback(
    async (explicitAppKey?: string) => {
      const key = (explicitAppKey ?? defaultAppKeyRef.current).trim();
      if (!key) {
        onErrorRef.current?.("OAuth: app key missing.");
        return;
      }
      if (isConnecting) return;
      setIsConnecting(true);
      completedRef.current = false;

      flowCleanupRef.current?.();

      const channelName = `targenix_oauth_${key}`;
      const bc = new BroadcastChannel(channelName);

      const handleResult = (msg: OAuth2IntegrationMessage) => {
        if (completedRef.current) return;
        completedRef.current = true;
        stopWatch();
        teardownFlow();
        setIsConnecting(false);
        if (msg.type === "oauth_integration_success") {
          onConnectedRef.current?.(msg.connectionId, msg.email, msg.displayName);
        } else {
          onErrorRef.current?.(msg.error ?? "OAuth connection failed.");
        }
      };

      const bcHandler = (e: MessageEvent) => {
        const data = e.data as OAuth2IntegrationMessage | undefined;
        if (
          data?.type === "oauth_integration_success" ||
          data?.type === "oauth_integration_error"
        ) {
          handleResult(data);
        }
      };

      const winHandler = (e: MessageEvent) => {
        if (e.origin !== window.location.origin) return;
        const data = e.data as OAuth2IntegrationMessage | undefined;
        if (
          data?.type === "oauth_integration_success" ||
          data?.type === "oauth_integration_error"
        ) {
          handleResult(data);
        }
      };

      const teardownFlow = () => {
        window.removeEventListener("message", winHandler);
        bc.removeEventListener("message", bcHandler);
        bc.close();
        flowCleanupRef.current = null;
      };

      bc.addEventListener("message", bcHandler);
      window.addEventListener("message", winHandler);
      flowCleanupRef.current = teardownFlow;

      try {
        const res = await fetch(`/api/oauth/${encodeURIComponent(key)}/initiate`, {
          credentials: "include",
        });

        const ct = res.headers.get("content-type") ?? "";
        let oauthUrl: string | undefined;
        let errMsg: string | undefined;

        if (ct.includes("application/json")) {
          const data = (await res.json()) as { oauthUrl?: string; error?: string };
          oauthUrl = data.oauthUrl;
          errMsg = data.error;
        } else {
          const snippet = (await res.text()).slice(0, 160).replace(/\s+/g, " ");
          throw new Error(
            res.ok
              ? `OAuth initiate returned HTML instead of JSON (/api/oauth/${key}/initiate). Use the same origin as the API or fix Vite proxy.`
              : `OAuth initiate failed (${res.status}). ${snippet}`,
          );
        }

        if (!res.ok || !oauthUrl) {
          throw new Error(errMsg ?? `Could not initiate ${key} OAuth.`);
        }

        const width = 520;
        const height = 640;
        const left = Math.max(0, Math.floor(window.screenX + (window.outerWidth - width) / 2));
        const top = Math.max(0, Math.floor(window.screenY + (window.outerHeight - height) / 2));
        const popup = window.open(
          oauthUrl,
          `targenix_oauth_${key}_popup`,
          `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`,
        );
        if (!popup) {
          stopWatch();
          teardownFlow();
          setIsConnecting(false);
          completedRef.current = true;
          onErrorRef.current?.("Popup was blocked. Allow popups for this site and try again.");
          return;
        }
        popupRef.current = popup;
        pollRef.current = window.setInterval(() => {
          if (!popup.closed) return;
          stopWatch();
          if (!completedRef.current) {
            completedRef.current = true;
            teardownFlow();
            setIsConnecting(false);
          }
        }, 600);
      } catch (err) {
        stopWatch();
        teardownFlow();
        setIsConnecting(false);
        completedRef.current = true;
        onErrorRef.current?.(
          err instanceof Error ? err.message : `Could not initiate ${key} OAuth.`,
        );
      }
    },
    [isConnecting, stopWatch],
  );

  return { start, isConnecting };
}
