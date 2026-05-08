/**
 * useOAuth2Popup — generic OAuth2 integration popup hook.
 *
 * Drives the popup flow for any non-Google OAuth2 provider (HubSpot, Kommo,
 * Pipedrive, …). Works identically to useGoogleOAuthPopup but listens on the
 * provider-specific BroadcastChannel `targenix_oauth_{appKey}` and calls the
 * generic initiate endpoint `/api/oauth/{appKey}/initiate`.
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
  appKey: string;
  onConnected?: (connectionId: number | null, email: string, displayName?: string) => void;
  onError?: (message: string) => void;
}

export function useOAuth2Popup({
  appKey,
  onConnected,
  onError,
}: UseOAuth2PopupOptions) {
  const [isConnecting, setIsConnecting] = React.useState(false);

  const channel = `targenix_oauth_${appKey}`;
  const popupRef = React.useRef<Window | null>(null);
  const pollRef = React.useRef<number | null>(null);
  const completedRef = React.useRef(false);

  const onConnectedRef = React.useRef(onConnected);
  const onErrorRef = React.useRef(onError);
  React.useEffect(() => { onConnectedRef.current = onConnected; }, [onConnected]);
  React.useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const stopWatch = React.useCallback(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    const handleResult = (msg: OAuth2IntegrationMessage) => {
      if (completedRef.current) return;
      completedRef.current = true;
      stopWatch();
      setIsConnecting(false);
      if (msg.type === "oauth_integration_success") {
        onConnectedRef.current?.(msg.connectionId, msg.email, msg.displayName);
      } else {
        onErrorRef.current?.(msg.error ?? "OAuth connection failed.");
      }
    };

    const bc = new BroadcastChannel(channel);
    const bcHandler = (e: MessageEvent) => {
      const data = e.data as OAuth2IntegrationMessage | undefined;
      if (
        data?.type === "oauth_integration_success" ||
        data?.type === "oauth_integration_error"
      ) {
        handleResult(data);
      }
    };
    bc.addEventListener("message", bcHandler);

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
    window.addEventListener("message", winHandler);

    return () => {
      bc.removeEventListener("message", bcHandler);
      bc.close();
      window.removeEventListener("message", winHandler);
      stopWatch();
    };
  }, [channel, stopWatch]);

  const start = React.useCallback(async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    completedRef.current = false;

    try {
      const res = await fetch(`/api/oauth/${appKey}/initiate`, {
        credentials: "include",
      });
      const data = (await res.json()) as { oauthUrl?: string; error?: string };
      if (!res.ok || !data.oauthUrl) {
        throw new Error(data.error ?? `Could not initiate ${appKey} OAuth.`);
      }

      const width = 520;
      const height = 640;
      const left = Math.max(0, Math.floor(window.screenX + (window.outerWidth - width) / 2));
      const top = Math.max(0, Math.floor(window.screenY + (window.outerHeight - height) / 2));
      const popup = window.open(
        data.oauthUrl,
        `targenix_oauth_${appKey}_popup`,
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`,
      );
      if (!popup) {
        setIsConnecting(false);
        onErrorRef.current?.("Popup was blocked. Allow popups for this site and try again.");
        return;
      }
      popupRef.current = popup;
      pollRef.current = window.setInterval(() => {
        if (popup.closed) {
          stopWatch();
          if (!completedRef.current) {
            completedRef.current = true;
            setIsConnecting(false);
          }
        }
      }, 600);
    } catch (err) {
      setIsConnecting(false);
      onErrorRef.current?.(
        err instanceof Error ? err.message : `Could not initiate ${appKey} OAuth.`,
      );
    }
  }, [appKey, isConnecting, stopWatch]);

  return { start, isConnecting };
}
