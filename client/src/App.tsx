import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { LocaleProvider } from "./contexts/LocaleContext";
import LandingPage from "./pages/LandingPage";
import Home from "./pages/Home";
import Leads from "./pages/Leads";
import WebhookHealth from "./pages/WebhookHealth";
import Integrations from "./pages/Integrations";
import Connections from "./pages/Connections";
import TargetWebsites from "./pages/TargetWebsites";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import LeadRoutingWizard from "./pages/LeadRoutingWizard";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import DataDeletion from "./pages/DataDeletion";
import AdminLogs from "./pages/AdminLogs";
import AdminBackfill from "./pages/AdminBackfill";
import AdminTemplates from "./pages/AdminTemplates";
import AdminLeads from "./pages/AdminLeads";
import LeadDetail from "./pages/LeadDetail";
import Settings from "./pages/Settings";
import SettingsProfile from "./pages/SettingsProfile";
import SettingsTelegram from "./pages/SettingsTelegram";
import AdAccounts from "./pages/AdAccounts";
import Analytics from "./pages/Analytics";
import DestinationAnalytics from "./pages/DestinationAnalytics";
import Campaigns from "./pages/Campaigns";
import AdSets from "./pages/AdSets";
import DevFormPreview from "./pages/DevFormPreview";
import { useAuth } from "./_core/hooks/useAuth";
import { useEffect, type ComponentType, type ReactNode } from "react";

/** Business Tools: admin-only until productized (sidebar already hides for non-admins). */
function AdminBusinessGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      setLocation("/login");
      return;
    }
    if (user.role !== "admin") {
      setLocation("/overview");
    }
  }, [loading, user, setLocation]);

  if (loading || !user || user.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }
  return <>{children}</>;
}

function businessToolsPage(Page: ComponentType) {
  return function BusinessToolsRoute() {
    return (
      <AdminBusinessGate>
        <Page />
      </AdminBusinessGate>
    );
  };
}

// ─── Root route: shows landing for unauth, redirects to /overview for auth ───
function RootRoute() {
  const { isAuthenticated, loading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!loading && isAuthenticated) {
      setLocation("/overview");
    }
  }, [isAuthenticated, loading, setLocation]);

  // While loading auth state, show nothing (avoids flash)
  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "#080a14" }}
      >
        <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  // Authenticated users are redirected above; show landing for unauth
  if (isAuthenticated) return null;

  return <LandingPage />;
}

/** Old Activity / logs URLs — send users to overview (page removed). */
function LegacyLogsRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation("/overview");
  }, [setLocation]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={RootRoute} />
      {/* Dashboard routes — /overview is the main dashboard */}
      <Route path="/overview" component={Home} />
      <Route path="/leads" component={Leads} />
      <Route path="/webhook" component={WebhookHealth} />
      <Route path="/integrations" component={Integrations} />
      <Route path="/integrations/new-routing" component={LeadRoutingWizard} />
      <Route path="/integrations/edit-routing/:id" component={LeadRoutingWizard} />
      <Route path="/connections" component={Connections} />
      {/* Legacy redirects kept for any bookmarks */}
      <Route path="/facebook" component={Connections} />
      <Route path="/facebook-accounts" component={Connections} />
      <Route path="/destinations" component={TargetWebsites} />
      <Route path="/target-websites" component={TargetWebsites} />
      <Route path="/activity" component={LegacyLogsRedirect} />
      <Route path="/logs" component={LegacyLogsRedirect} />
      <Route path="/admin/logs" component={AdminLogs} />
      <Route path="/admin/leads" component={AdminLeads} />
      <Route path="/admin/backfill" component={AdminBackfill} />
      <Route path="/admin/destination-templates" component={AdminTemplates} />
      <Route path="/leads/:id" component={LeadDetail} />
      <Route path="/settings" component={Settings} />
      <Route path="/settings/profile" component={SettingsProfile} />
      <Route path="/settings/telegram" component={SettingsTelegram} />
      {/* Business Tools routes (admin-only UI + deep-link guard) */}
      <Route path="/business/ad-accounts" component={businessToolsPage(AdAccounts)} />
      <Route path="/business/ad-accounts/:id/campaigns" component={businessToolsPage(Campaigns)} />
      <Route
        path="/business/ad-accounts/:accountId/campaigns/:campaignId/adsets"
        component={businessToolsPage(AdSets)}
      />
      <Route path="/business/analytics" component={businessToolsPage(Analytics)} />
      <Route path="/business/destinations" component={businessToolsPage(DestinationAnalytics)} />
      {/* Legacy /ad-accounts */}
      <Route path="/ad-accounts" component={businessToolsPage(AdAccounts)} />
      {/* Dev-only preview of the dynamic form field library (admin-gated). */}
      <Route path="/dev/form-preview" component={DevFormPreview} />
      {/* Auth pages */}
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      {/* Public pages */}
      <Route path="/privacy" component={Privacy} />
      <Route path="/terms" component={Terms} />
      <Route path="/data-deletion" component={DataDeletion} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" switchable>
        <LocaleProvider defaultLocale="uz">
          <TooltipProvider>
            <Toaster />
            <Router />
          </TooltipProvider>
        </LocaleProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
