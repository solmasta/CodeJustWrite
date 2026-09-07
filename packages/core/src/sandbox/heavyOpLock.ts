import { createMutex } from "./mutex.js";

/**
 * One memory-heavy operation at a time, server-wide: a headless Chromium launch (150-300MB, a
 * separate OS process Node's own memory accounting never sees — see browser_check) or a spawned
 * run_shell/run_tests command (its own V8 heap capped at 300MB by execSandboxed's
 * DEFAULT_NODE_OPTIONS, but still real RSS on top of everything else in this container). Each of
 * these is already serialized *within* one turn via isolatedResource — but that says nothing about
 * two different sessions each kicking one off around the same time. On a memory-constrained
 * container (see the Dockerfile's --max-old-space-size comment), those launches stacking is
 * exactly what has taken this app's Render deploy down before — first traced to browser_check,
 * then to a plain run_shell (an npm install) doing the same thing by a different route. Routing
 * every one of these through the same process-wide lock bounds the container's worst case to
 * "this server's own footprint plus one heavy op," regardless of how many sessions are
 * concurrently active or which kind of heavy op they each happen to be running.
 */
export const heavyOperationLock = createMutex();
