import { Redirect } from "expo-router";

// Tab placeholder — the tab bar button itself links straight to /submit
// (options.href in the (tabs) layout renders the button as a <Link>), so
// this route only exists to satisfy the tab navigator and forward anyone
// who lands on it directly (e.g. a deep link to /contribute).
export default function ContributeTab() {
  return <Redirect href="/submit" />;
}
