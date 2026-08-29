import { useMemo } from "react";

import { App } from "../App";
import { PlatformProvider } from "./context";
import { browserPlatform } from "./browserPlatform";

/** The app in a tab. No folder, no title bar, no files opened from outside. */
export function BrowserShell() {
  const platform = useMemo(() => browserPlatform(), []);
  return (
    <PlatformProvider value={platform}>
      <App />
    </PlatformProvider>
  );
}
