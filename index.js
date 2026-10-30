/**
 * Host half of the bundle.
 *
 * The one-click update entry lives entirely in the browser UI: it drives the
 * desktop product bridge (`window.dshDesktop.updates`) that the Electron
 * preload already exposes to the main window. The host contributes no service,
 * no route and no command, so this module stays deliberately empty.
 */
export function apply() {}
 