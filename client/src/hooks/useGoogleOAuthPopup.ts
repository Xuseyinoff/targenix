/**
 * useGoogleOAuthPopup — Phase 4, Commit 5c.3.
 *
 * Reusable hook that drives the Google OAuth popup dance. Previously the
 * logic lived inside GoogleConnectionsSection; inlining the same 80+ lines
 * into ConnectionPicker (so the user could connect a Google account without
 * leaving the v2 wizard) would duplicate three subtle pieces:
 *
 *   • Cross-origin message handling (window.postMessage AND BroadcastChannel
 *     — different browsers / incognito modes support each differently).
 *   • Popup closed-by-user detection (setInterval polling on popup.closed,
 *     cleaned up on unmount and on success).
 *   • Idempotent result routing so we don't fire the caller's success
 *     callback twice if both the message and the polling fire in the same
 *     tick.
 *
 * Wrapping that logic once lets every caller (Connections page,
 * ConnectionPicker, future wizards) stay trivial: call `start()`, pass an
 * `onConnected` callback, render a button that reads `isConnecting`.
 */

import * as React from "react";

const GOOGLE_OAUTH_CHANNEL = "targenix_google_oauth";

/**
 * Shape of messages posted by /auth/google/callback to this window. Kept in
 * lockstep with server/routes/googleOAuth.ts — if you extend it, extend the
 * server and the type union below together.
 */
export type GoogleOAuthMessage =
  | { type: "google_oauth_success"; accountId: number; email?: string }
  | { type: "google_oauth_error"; error?: string };

export interface UseGoogleOAuthPopupOptions {
  /** Called when OAuth completes successfully. */
  onConnected?: (accountId: number, email?: string) => void;
  /** Called when OAuth fails or the popup is blocked / closed early. */
  onError?: (message: string) => void;
}

export interface UseGoogleOAuthPopupResult {
  /** Kick off the OAuth flow: fetch the URL, open a centred popup, listen. */
  start: () => Promise<void>;
  /** True while the popup is open, false once a message or close is seen. */
  isConnecting: boolean;
}

export function useGoogleOAuthPopup(
  options: UseGoogleOAuthPopupOptions = {},
): UseGoogleOAuthPopupResult {
  const { onConnected, onError } = options;

  const [isConnecting, setIsConnecting] = React.useState(false);

  const popupRef = React.useRef<Window | null>(null);
  const pollRef = React.useRef<number | null>(null);
  const completedRef = React.useRef(false);

  // Keep the latest callbacks in refs so listeners registered on mount always
  // dispatch to the freshest prop references without re-running the effect.
  const onConnectedRef = React.useRef(onConnected);
  const onErrorRef = React.useRef(onError);
  React.useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);
  React.useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const stopPopupWatch = React.useCallback(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    const handleResult = (msg: GoogleOAuthMessage) => {
      if (completedRef.current) return;
      completedRef.current = true;
      stopPopupWatch();
      setIsConnecting(false);

      if (msg.type === "google_oauth_success") {
        onConnectedRef.current?.(msg.accountId, msg.email);
      } else {
        onErrorRef.current?.(msg.error ?? "Google OAuth failed.");
      }
    };

    const bc = new BroadcastChannel(GOOGLE_OAUTH_CHANNEL);
    const bcHandler = (e: MessageEvent) => {
      const data = e.data as GoogleOAuthMessage | undefined;
      if (
        data?.type === "google_oauth_success" ||
        data?.type === "google_oauth_error"
      ) {
        handleResult(data);
      }
    };
    bc.addEventListener("message", bcHandler);

    const winHandler = (e: MessageEvent) => {
      // postMessage-based flow sends from the callback page — which lives on
      // the same origin — so we tighten the origin check defensively even
      // though the channel is scoped by type.
      if (e.origin !== window.location.origin) return;
      const data = e.data as GoogleOAuthMessage | undefined;
      if (
        data?.type === "google_oauth_success" ||
        data?.type === "google_oauth_error"
      ) {
        handleResult(data);
      }
    };
    window.addEventListener("message", winHandler);

    return () => {
      bc.removeEventListener("message", bcHandler);
      bc.close();
      window.removeEventListener("message", winHandler);
      stopPopupWatch();
    };
  }, [stopPopupWatch]);

  const start = React.useCallback(async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    completedRef.current = false;

    try {
      const res = await fetch("/api/auth/google/initiate", {
        credentials: "include",
      });
      const data = (await res.json()) as { oauthUrl?: string; error?: string };
      if (!res.ok || !data.oauthUrl) {
        throw new Error(data.error ?? "Could not initiate Google OAuth.");
      }

      const width = 520;
      const height = 640;
      const left = Math.max(
        0,
        Math.floor(window.screenX + (window.outerWidth - width) / 2),
      );
      const top = Math.max(
        0,
        Math.floor(window.screenY + (window.outerHeight - height) / 2),
      );
      const popup = window.open(
        data.oauthUrl,
        "targenix_google_oauth_popup",
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`,
      );
      if (!popup) {
        setIsConnecting(false);
        onErrorRef.current?.(
          "Popup was blocked. Allow popups for this site and try again.",
        );
        return;
      }
      popupRef.current = popup;
      pollRef.current = window.setInterval(() => {
        if (popup.closed) {
          stopPopupWatch();
          if (!completedRef.current) {
            completedRef.current = true;
            setIsConnecting(false);
          }
        }
      }, 600);
    } catch (err) {
      setIsConnecting(false);
      onErrorRef.current?.(
        err instanceof Error ? err.message : "Could not initiate Google OAuth.",
      );
    }
  }, [isConnecting, stopPopupWatch]);

  return { start, isConnecting };
}
