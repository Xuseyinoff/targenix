import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
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
import Logs from "./pages/Logs";
import AdminLogs from "./pages/AdminLogs";
import AdminBackfill from "./pages/AdminBackfill";
import LeadDetail from "./pages/LeadDetail";
import Settings from "./pages/Settings";
import AdAccounts from "./pages/AdAccounts";
import Analytics from "./pages/Analytics";
import Campaigns from "./pages/Campaigns";
import { useAuth } from "./_core/hooks/useAuth";
import { useEffect } from "react";

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
      <Route path="/activity" component={Logs} />
      <Route path="/logs" component={Logs} />
      <Route path="/admin/logs" component={AdminLogs} />
      <Route path="/admin/backfill" component={AdminBackfill} />
      <Route path="/leads/:id" component={LeadDetail} />
      <Route path="/settings" component={Settings} />
      {/* Business Tools routes */}
      <Route path="/business/ad-accounts" component={AdAccounts} />
      <Route path="/business/ad-accounts/:id/campaigns" component={Campaigns} />
      <Route path="/business/analytics" component={Analytics} />
      {/* Legacy /ad-accounts redirect */}
      <Route path="/ad-accounts" component={AdAccounts} />
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
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
