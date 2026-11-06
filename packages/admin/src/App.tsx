import { Redirect, Route, Router, Switch } from "wouter";
import { SetupProvider } from "./lib/setup-state.tsx";
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

export function App() {
  return (
    <Router base="/admin">
      <SetupProvider>
        <Switch>
          <Route path="/" component={Overview} />
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
      </SetupProvider>
    </Router>
  );
}
