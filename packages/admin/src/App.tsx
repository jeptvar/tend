import { lazy, Suspense } from "react";
import { Redirect, Route, Router, Switch } from "wouter";
import { Loading } from "./components/AuthLayout.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { Toaster } from "./components/Toast.tsx";
import { SetupProvider } from "./lib/setup-state.tsx";
import { PageList, PostList } from "./routes/Entries.tsx";
import { ForgotPassword, Login } from "./routes/Login.tsx";
import { Overview } from "./routes/Overview.tsx";
import {
  SetupAccount,
  SetupBackup,
  SetupCode,
  SetupName,
  SetupStart,
  SetupWelcome,
} from "./routes/Setup.tsx";

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
              <Route path="/setup" component={SetupWelcome} />
              <Route path="/setup/code" component={SetupCode} />
              <Route path="/setup/name" component={SetupName} />
              <Route path="/setup/account" component={SetupAccount} />
              <Route path="/setup/start" component={SetupStart} />
              <Route path="/setup/backup" component={SetupBackup} />
              <Route path="/login" component={Login} />
              <Route path="/login/forgot" component={ForgotPassword} />
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
