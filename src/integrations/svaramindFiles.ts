/**
 * @module integrations/svaramindFiles
 * `svaramind_save_file`: puts a file the agent made in its working directory or sandbox (a CSV, chart, PDF, script
 * output...) into the user's Svaramind workspace, so it is kept, searchable and shareable instead of disappearing
 * with the chat. The file bytes go straight from disk to Svaramind's `svaramind_upload_file` MCP tool: the model only
 * names the path, it never has to read or encode the file itself.
 */

import path from 'path';
import type { Tool } from '../types.js';
import type { McpManager } from '../mcp/manager.js';
import { readAgentFile, type SendFileToolOptions } from '../tools/builtin/sendFile.js';
import { SVARAMIND_SERVER_ID } from './svaramind.js';

const MAX_BYTES = 15_000_000;

export function createSvaramindSaveFileTool(
  mcp: McpManager,
  fileOpts: Pick<SendFileToolOptions, 'rootDir' | 'backend' | 'dockerContainer'>,
): Tool {
  return {
    name: 'svaramind_save_file',
    description:
      'Save a file you created on disk (with file_write or a script in terminal_exec: CSV, Excel, Word, PDF, images, ' +
      'Markdown, HTML, text) into a Svaramind workspace folder, so the user keeps it and can open, search and share it. ' +
      'Use this for every file worth keeping. Office files that Svaramind should design are better made directly with ' +
      'svaramind_create_office_file. Returns the document link to give the user.',
    parameters: {
      path: { type: 'string', required: true, description: "File path, relative to your working directory" },
      folder_id: { type: 'string', description: 'Folder UUID to save into (pass your own folder unless the user wants another place; omitted = workspace root)' },
      workspace_id: { type: 'string', description: 'Workspace UUID (defaults to your home workspace)' },
      file_name: { type: 'string', description: 'Name to show in Svaramind, with extension (defaults to the file name)' },
    },
    async run(args) {
      if (!mcp.isConnected(SVARAMIND_SERVER_ID)) return { error: 'Svaramind is not connected to this agent.' };
      const pinned = mcp.getPinned(SVARAMIND_SERVER_ID);
      const workspaceId = args.workspace_id ? String(args.workspace_id) : pinned.workspace_id ? String(pinned.workspace_id) : '';
      if (!workspaceId) return { error: 'Which workspace? Pass workspace_id (see svaramind_list_workspaces).' };
      let bytes: Buffer;
      try {
        bytes = await readAgentFile(fileOpts, String(args.path), MAX_BYTES);
      } catch (err) {
        return { error: (err as Error).message };
      }
      const fileName = args.file_name ? String(args.file_name) : path.posix.basename(String(args.path));
      try {
        return await mcp.callToolDirect(SVARAMIND_SERVER_ID, 'svaramind_upload_file', {
          workspace_id: workspaceId,
          folder_id: args.folder_id ? String(args.folder_id) : undefined,
          file_name: fileName,
          content_base64: bytes.toString('base64'),
        });
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  };
}
