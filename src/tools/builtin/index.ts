/**
 * @module tools/builtin
 * Ready-to-use tools - none of these are registered by default.
 * Opt in explicitly via `agent.addTool()` / `AgentConfig.tools`, or let
 * the standalone runtime (`svara start`) wire them up from `svara.config.json`.
 */

export { createTerminalTool } from './terminal.js';
export type { TerminalToolOptions } from './terminal.js';

export { createFilesystemTools } from './filesystem.js';
export type { FilesystemToolsOptions } from './filesystem.js';

export { createWebTools } from './web.js';
export type { WebToolsOptions } from './web.js';

export { createBrowserTools, closeBrowser } from './browser.js';
export type { BrowserToolsOptions } from './browser.js';

export { createSendFileTool, getRegisteredFile, drainPendingTokens } from './sendFile.js';
export type { SendFileToolOptions, RegisteredFile } from './sendFile.js';
