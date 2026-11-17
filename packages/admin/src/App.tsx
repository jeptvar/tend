import { lazy, Suspense } from "react";
import { Redirect, Route, Router, Switch } from "wouter";
import { Loading } from "./components/AuthLayout.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { Toaster } from "./components/Toast.tsx";
import { SetupProvider } from "./lib/setup-state.tsx";
import { AcceptInvite, Recover, ResetPassword } from "./routes/Access.tsx";
import { Account } from "./routes/Account.tsx";
import { DesignPage } from "./routes/Design.tsx";
import { PageList, PostList } from "./routes/Entries.tsx";
import { ForgotPassword, Login } from "./routes/Login.tsx";
import { MediaLibrary } from "./routes/Media.tsx";
import { Overview } from "./routes/Overview.tsx";
import { People } from "./routes/People.tsx";
import { SettingsPage } from "./routes/Settings.tsx";
import {
  SetupAccount,
  SetupBackup,
  SetupCode,
  SetupName,
  SetupStart,
  SetupWelcome,
} from "./routes/Setup.tsx";
import { SiteMenu } from "./routes/SiteMenu.tsx";

// The editor is by far the largest part of the admin, so it only loads when it's needed.
const PostEditor = lazy(() =>
  import("./routes/Editor.tsx").then((module) => ({ default: module.PostEditor })),
);
const PageEditor = lazy(() =>
  import("./routes/Editor.tsx").then((module) => ({ default: module.PageEditor })),
);

export function App() {
  return (
    <Router base="/admin">
      <SetupProvider>
        <ErrorBoundary>
          <Suspense fallback={<Loading />}>
            <Switch>
              <Route path="/" component={Overview} />
              <Route path="/posts" component={PostList} />
              <Route path="/posts/:id" component={PostEditor} />
              <Route path="/pages" component={PageList} />
              <Route path="/pages/:id" component={PageEditor} />
              <Route path="/media" component={MediaLibrary} />
              <Route path="/menu" component={SiteMenu} />
              <Route path="/design" component={DesignPage} />
              <Route path="/people" component={People} />
              <Route path="/account" component={Account} />
              <Route path="/settings" component={SettingsPage} />
              <Route path="/settings/:section" component={SettingsPage} />
              <Route path="/setup" component={SetupWelcome} />
              <Route path="/setup/code" component={SetupCode} />
              <Route path="/setup/name" component={SetupName} />
              <Route path="/setup/account" component={SetupAccount} />
              <Route path="/setup/start" component={SetupStart} />
              <Route path="/setup/backup" component={SetupBackup} />
              <Route path="/login" component={Login} />
              <Route path="/login/forgot" component={ForgotPassword} />
              <Route path="/recover" component={Recover} />
              <Route path="/reset" component={ResetPassword} />
              <Route path="/invite" component={AcceptInvite} />
              <Route>
                <Redirect to="/" replace />
              </Route>
            </Switch>
          </Suspense>
        </ErrorBoundary>
        <Toaster />
      </SetupProvider>
    </Router>
  );
}
