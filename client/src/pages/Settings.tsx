import { Redirect } from "wouter";

/**
 * `/settings` has no content of its own — the settings area is a left-rail
 * layout (see SettingsLayout) whose first section is the profile. Redirect
 * straight there so the sidebar gear icon and any old bookmarks still land
 * somewhere useful.
 */
export default function Settings() {
  return <Redirect to="/settings/profile" replace />;
}
