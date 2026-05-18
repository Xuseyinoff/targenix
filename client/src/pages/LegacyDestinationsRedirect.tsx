/**
 * LegacyDestinationsRedirect — bookmark safety net for the deleted
 * /destinations page.
 *
 * Destinations Cleanup Sprint, PR 4/4 (FINAL). The /destinations page is
 * gone; its capabilities were migrated into the Integrations page (Edit
 * destination, PR 1), the Integration wizard (HTTP inline, PR 2), and
 * the Connections page (cascade delete, PR 3).
 *
 * Anyone who bookmarked /destinations or /target-websites would otherwise
 * hit a 404 after the route was removed. This component silently bounces
 * them to /integrations — the page where everything lives now.
 *
 * `replace: true` keeps the bookmark URL out of the back-button history,
 * so pressing Back doesn't land the user on /destinations again in a
 * loop.
 */

import { useEffect } from "react";
import { useLocation } from "wouter";

export default function LegacyDestinationsRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation("/integrations", { replace: true });
  }, [setLocation]);
  return null;
}
