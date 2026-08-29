import { createContext, useContext } from "react";

import type { Platform } from "./types";

/* No default. A tree without a shell around it is a wiring mistake, and a
   fallback platform would hide it behind a browser that cannot open anything. */
const PlatformContext = createContext<Platform | null>(null);

export const PlatformProvider = PlatformContext.Provider;

export function usePlatform(): Platform {
  const platform = useContext(PlatformContext);
  if (!platform) {
    throw new Error("usePlatform outside a shell — render ElectronShell or BrowserShell above this");
  }
  return platform;
}
