import { useMemo } from "react";

import { App } from "../App";
import type { Aoe2Bridge } from "../electron";
import { PlatformProvider } from "./context";
import { electronPlatform } from "./electronPlatform";

/**
 * The app in a window of its own.
 *
 * Built once from the bridge and never rebuilt: the preload object is the same
 * one for the life of the window, so a new platform every render would only
 * re-subscribe every effect that depends on it.
 */
export function ElectronShell({ bridge }: { bridge: Aoe2Bridge }) {
  const platform = useMemo(() => electronPlatform(bridge), [bridge]);
  return (
    <PlatformProvider value={platform}>
      <App />
    </PlatformProvider>
  );
}
