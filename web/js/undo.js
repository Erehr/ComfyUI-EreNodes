import { app } from "../../../scripts/app.js";

// Undo checkpoints for tag mutations. ComfyUI's change tracker snapshots by
// diffing serialized graph state at its own trigger points (window mouseup,
// canvas processMouseUp, ...) — all of which either fire BEFORE our click
// handlers mutate the data or not at all for DOM widget clicks. Calling
// captureCanvasState after each mutation gives every tag change its own undo
// step in both renderers.

let suppressed = false;
let pendingWhileSuppressed = false;

function getTracker() {
    return app.extensionManager?.workflow?.activeWorkflow?.changeTracker
        ?? app.workflowManager?.activeWorkflow?.changeTracker;
}

/** Record an undo checkpoint now (no-op while a transaction is open). */
export function captureUndoState() {
    if (suppressed) {
        pendingWhileSuppressed = true;
        return;
    }
    const tracker = getTracker();
    if (!tracker) return;
    // captureCanvasState is the current API; checkState the older name
    (tracker.captureCanvasState ?? tracker.checkState)?.call(tracker);
}

/**
 * Continuous interactions (e.g. dragging the strength control) wrap the
 * gesture in a transaction so it lands as ONE undo step instead of one per
 * tick. Discrete actions should not use this — each gets its own step.
 */
export function beginUndoTransaction() {
    suppressed = true;
    pendingWhileSuppressed = false;
}

export function endUndoTransaction() {
    suppressed = false;
    if (pendingWhileSuppressed) {
        pendingWhileSuppressed = false;
        captureUndoState();
    }
}
