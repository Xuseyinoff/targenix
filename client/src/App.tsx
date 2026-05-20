import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, useLocation, type RouteComponentProps } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { LocaleProvider } from "./contexts/LocaleContext";
import { useAuth } from "./_core/hooks/useAuth";
import { Suspense, useEffect, type ComponentType, type ReactNode } from "react";
import { lazyWithRetry } from "./lib/lazyWithRetry";

// Eagerly loaded — shown before auth resolves or on the critical path
import LandingPage from "./pages/LandingPage";
import Login from "./pages/Login";
import NotFound from "@/pages/NotFound";

// Lazily loaded — only downloaded when the user navigates to these routes
const Home = lazyWithRetry(() => import("./pages/Home"));
const Leads = lazyWithRetry(() => import("./pages/Leads"));
const Insights = lazyWithRetry(() => import("./pages/Insights"));
const CampaignDrilldown = lazyWithRetry(() => import("./pages/CampaignDrilldown"));
const WebhookHealth = lazyWithRetry(() => import("./pages/WebhookHealth"));
const Integrations = lazyWithRetry(() => import("./pages/Integrations"));
const Connections = lazyWithRetry(() => import("./pages/Connections"));
// Destinations Cleanup Sprint, PR 4/4 — page deleted. Bookmarks to
// /destinations or /target-websites resolve to this thin redirect
// component, which bounces the user to /integrations with replace:true
// (no flash, no 404, no back-button loop).
const LegacyDestinationsRedirect = lazyWithRetry(
  () => import("./pages/LegacyDestinationsRedirect"),
);
const Register = lazyWithRetry(() => import("./pages/Register"));
const ForgotPassword = lazyWithRetry(() => import("./pages/ForgotPassword"));
const ResetPassword = lazyWithRetry(() => import("./pages/ResetPassword"));
const IntegrationWizardV2 = lazyWithRetry(() => import("./pages/IntegrationWizardV2"));
const IntegrationBuilderV3 = lazyWithRetry(() => import("./pages/IntegrationBuilderV3"));
const Privacy = lazyWithRetry(() => import("./pages/Privacy"));
const Terms = lazyWithRetry(() => import("./pages/Terms"));
const DataDeletion = lazyWithRetry(() => import("./pages/DataDeletion"));
const AdminLogs = lazyWithRetry(() => import("./pages/AdminLogs"));
const AdminBackfill = lazyWithRetry(() => import("./pages/AdminBackfill"));
const AdminTemplates = lazyWithRetry(() => import("./pages/AdminTemplates"));
const AdminLeads = lazyWithRetry(() => import("./pages/AdminLeads"));
const AdminCrmAccounts = lazyWithRetry(() => import("./pages/AdminCrmAccounts"));
const AdminCrmOrders = lazyWithRetry(() => import("./pages/AdminCrmOrders"));
const AdminDlq = lazyWithRetry(() => import("./pages/AdminDlq"));
const AdminApps = lazyWithRetry(() => import("./pages/AdminApps"));
const AdminMetrics = lazyWithRetry(() => import("./pages/AdminMetrics"));
const LeadDetail = lazyWithRetry(() => import("./pages/LeadDetail"));
const Settings = lazyWithRetry(() => import("./pages/Settings"));
const SettingsProfile = lazyWithRetry(() => import("./pages/SettingsProfile"));
const SettingsTelegram = lazyWithRetry(() => import("./pages/SettingsTelegram"));
const AdAccounts = lazyWithRetry(() => import("./pages/AdAccounts"));
const Analytics = lazyWithRetry(() => import("./pages/Analytics"));
const DestinationAnalytics = lazyWithRetry(() => import("./pages/DestinationAnalytics"));
const Campaigns = lazyWithRetry(() => import("./pages/Campaigns"));
const AdSets = lazyWithRetry(() => import("./pages/AdSets"));
const DevFormPreview = lazyWithRetry(() => import("./pages/DevFormPreview"));
const Triggers = lazyWithRetry(() => import("./pages/Triggers"));
const Workflows = lazyWithRetry(() => import("./pages/Workflows"));
const WorkflowCanvas = lazyWithRetry(() => import("./pages/WorkflowCanvas"));
const ExecutionDebugger = lazyWithRetry(() => import("./pages/ExecutionDebugger"));

function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

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

/** Old stepped lead-routing wizard URLs → IntegrationWizardV2 (bookmarks). */
function LegacyLeadRoutingNewRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation("/integrations/new-v2");
  }, [setLocation]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

function LegacyLeadRoutingEditRedirect({
  params,
}: RouteComponentProps<{ id: string }>) {
  const [, setLocation] = useLocation();
  useEffect(() => {
    const id = params?.id;
    if (id) setLocation(`/integrations/edit-v2/${encodeURIComponent(id)}`);
    else setLocation("/integrations");
  }, [setLocation, params?.id]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

function Router() {
  // Per-route ErrorBoundary: a crash inside one lazy-loaded page (e.g. a
  // chunk that fails to load, or a render-time throw) is contained here
  // instead of bubbling up to the app-level boundary that requires a
  // full reload. The user keeps their URL + can navigate away without
  // losing in-flight state in other tabs / browser history.
  return (
    <ErrorBoundary>
    <Suspense fallback={<PageLoader />}>
    <Switch>
      <Route path="/" component={RootRoute} />
      {/* Dashboard routes — /overview is the main dashboard */}
      <Route path="/overview" component={Home} />
      <Route path="/leads" component={Leads} />
      <Route path="/insights" component={Insights} />
      <Route path="/insights/campaign/:campaignId" component={CampaignDrilldown} />
      <Route path="/webhook" component={WebhookHealth} />
      <Route path="/integrations" component={Integrations} />
      <Route path="/integrations/new-routing" component={LegacyLeadRoutingNewRedirect} />
      <Route path="/integrations/edit-routing/:id" component={LegacyLeadRoutingEditRedirect} />
      <Route path="/integrations/new-v2" component={IntegrationWizardV2} />
      <Route path="/integrations/edit-v2/:id" component={IntegrationWizardV2} />
      {/* Albato-style step-by-step builder — opt-in, non-destructive.
          Lives alongside the V2 wizard above so the existing flow keeps
          working untouched. Edit mode comes in a later phase. */}
      <Route path="/integrations/builder-v3" component={IntegrationBuilderV3} />
      <Route path="/connections" component={Connections} />
      <Route path="/triggers" component={Triggers} />
      <Route path="/workflows" component={Workflows} />
      <Route path="/workflows/:id/canvas" component={WorkflowCanvas} />
      <Route path="/workflows/:wfId/executions/:execId" component={ExecutionDebugger} />
      {/* Legacy redirects kept for any bookmarks */}
      <Route path="/facebook" component={Connections} />
      <Route path="/facebook-accounts" component={Connections} />
      {/* Destinations Cleanup Sprint, PR 4/4 — the standalone Destinations
          management page is gone. Bookmark-safety redirects send anyone
          who still visits /destinations or /target-websites to the
          Integrations page, where every former Destinations capability
          now lives (PR 1 Edit-destination, PR 2 inline-HTTP, PR 3
          cascade-delete on Connections). */}
      <Route path="/destinations" component={LegacyDestinationsRedirect} />
      <Route path="/target-websites" component={LegacyDestinationsRedirect} />
      <Route path="/activity" component={LegacyLogsRedirect} />
      <Route path="/logs" component={LegacyLogsRedirect} />
      <Route path="/admin/logs" component={AdminLogs} />
      <Route path="/admin/leads" component={AdminLeads} />
      <Route path="/admin/backfill" component={AdminBackfill} />
      <Route path="/admin/destination-templates" component={AdminTemplates} />
      <Route path="/admin/crm/accounts" component={AdminCrmAccounts} />
      <Route path="/admin/crm/orders" component={AdminCrmOrders} />
      <Route path="/admin/dlq" component={AdminDlq} />
      <Route path="/admin/apps" component={AdminApps} />
      <Route path="/admin/metrics" component={AdminMetrics} />
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
    </Suspense>
    </ErrorBoundary>
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
