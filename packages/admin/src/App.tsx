import { Redirect, Route, Router, Switch } from "wouter";
import { SetupBackup, SetupName, SetupWelcome } from "./routes/Setup.tsx";

export function App() {
  return (
    <Router base="/admin">
      <Switch>
        <Route path="/setup" component={SetupWelcome} />
        <Route path="/setup/name" component={SetupName} />
        <Route path="/setup/backup" component={SetupBackup} />
        <Route>
          <Redirect to="/setup" replace />
        </Route>
      </Switch>
    </Router>
  );
}
