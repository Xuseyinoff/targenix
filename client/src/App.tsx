import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, useLocation, type RouteComponentProps } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { LocaleProvider } from "./contexts/LocaleContext";
import { useAuth } from "./_core/hooks/useAuth";
import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from "react";

// Eagerly loaded — shown before auth resolves or on the critical path
import LandingPage from "./pages/LandingPage";
import Login from "./pages/Login";
import NotFound from "@/pages/NotFound";

// Lazily loaded — only downloaded when the user navigates to these routes
const Home = lazy(() => import("./pages/Home"));
const Leads = lazy(() => import("./pages/Leads"));
const WebhookHealth = lazy(() => import("./pages/WebhookHealth"));
const Integrations = lazy(() => import("./pages/Integrations"));
const Connections = lazy(() => import("./pages/Connections"));
const TargetWebsites = lazy(() => import("./pages/TargetWebsites"));
const Register = lazy(() => import("./pages/Register"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const IntegrationWizardV2 = lazy(() => import("./pages/IntegrationWizardV2"));
const Privacy = lazy(() => import("./pages/Privacy"));
const Terms = lazy(() => import("./pages/Terms"));
const DataDeletion = lazy(() => import("./pages/DataDeletion"));
const AdminLogs = lazy(() => import("./pages/AdminLogs"));
const AdminBackfill = lazy(() => import("./pages/AdminBackfill"));
const AdminTemplates = lazy(() => import("./pages/AdminTemplates"));
const AdminLeads = lazy(() => import("./pages/AdminLeads"));
const AdminCrmAccounts = lazy(() => import("./pages/AdminCrmAccounts"));
const AdminCrmOrders = lazy(() => import("./pages/AdminCrmOrders"));
const LeadDetail = lazy(() => import("./pages/LeadDetail"));
const Settings = lazy(() => import("./pages/Settings"));
const SettingsProfile = lazy(() => import("./pages/SettingsProfile"));
const SettingsTelegram = lazy(() => import("./pages/SettingsTelegram"));
const AdAccounts = lazy(() => import("./pages/AdAccounts"));
const Analytics = lazy(() => import("./pages/Analytics"));
const DestinationAnalytics = lazy(() => import("./pages/DestinationAnalytics"));
const Campaigns = lazy(() => import("./pages/Campaigns"));
const AdSets = lazy(() => import("./pages/AdSets"));
const DevFormPreview = lazy(() => import("./pages/DevFormPreview"));

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
  return (
    <Suspense fallback={<PageLoader />}>
    <Switch>
      <Route path="/" component={RootRoute} />
      {/* Dashboard routes — /overview is the main dashboard */}
      <Route path="/overview" component={Home} />
      <Route path="/leads" component={Leads} />
      <Route path="/webhook" component={WebhookHealth} />
      <Route path="/integrations" component={Integrations} />
      <Route path="/integrations/new-routing" component={LegacyLeadRoutingNewRedirect} />
      <Route path="/integrations/edit-routing/:id" component={LegacyLeadRoutingEditRedirect} />
      <Route path="/integrations/new-v2" component={IntegrationWizardV2} />
      <Route path="/integrations/edit-v2/:id" component={IntegrationWizardV2} />
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
      <Route path="/admin/crm/accounts" component={AdminCrmAccounts} />
      <Route path="/admin/crm/orders" component={AdminCrmOrders} />
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
