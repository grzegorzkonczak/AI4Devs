#!/usr/bin/env node
/**
 * Filesystem MCP Server — s01e03 exercise
 *
 * Implements the lesson's optimized 4-tool design:
 *   fs_search  — explore & search files/directories
 *   fs_read    — read text or binary files
 *   fs_write   — overwrite or surgically edit files
 *   fs_manage  — create directories, move/rename files
 *
 * Usage: node server.js /path/to/allowed/dir [/another/dir ...]
 *
 * Test with MCP Inspector:
 *   Transport Type: STDIO
 *   Command: node
 *   Arguments: Lesson 3/server.js /your/allowed/dir
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { fsSearch, fsRead, fsWrite, fsManage } from './fs-tools.js'

// Allowed directories come from CLI args; at least one is required
const allowedDirs = process.argv.slice(2)
if (allowedDirs.length === 0) {
  console.error('Usage: node server.js <allowed-dir> [<allowed-dir> ...]')
  process.exit(1)
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const ok = text => ({ content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }] })
const err = msg => ({ content: [{ type: 'text', text: msg }], isError: true })

const handle = fn => async args => {
  try {
    const result = await fn(args)
    return ok(result)
  } catch (e) {
    return err(e.message)
  }
}

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'fs-mcp-4tools', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// ─── Tool: fs_search ──────────────────────────────────────────────────────────

server.registerTool('fs_search', {
  title: 'Filesystem Search & Explore',
  description:
    'Search and explore the filesystem. ' +
    'action="files" finds files by glob pattern. ' +
    'action="tree" returns a recursive JSON directory tree. ' +
    'action="list" lists directory contents (set withSizes=true for file sizes). ' +
    'action="info" returns metadata for a file or directory. ' +
    'action="allowed" shows which root directories are accessible.',
  inputSchema: {
    action: z.enum(['files', 'tree', 'list', 'info', 'allowed'])
      .describe('files=glob search, tree=recursive tree, list=directory listing, info=file metadata, allowed=list sandboxed roots'),
    path: z.string().optional()
      .describe('Directory or file path. Required for all actions except "allowed"'),
    pattern: z.string().optional()
      .describe('Glob pattern for "files" action, e.g. "**/*.js"'),
    excludePatterns: z.array(z.string()).optional()
      .describe('Glob patterns to exclude, used with "files" and "tree" actions'),
    withSizes: z.boolean().optional()
      .describe('For "list": include file sizes and totals (default: false)'),
    sortBy: z.enum(['name', 'size']).optional()
      .describe('For "list" with withSizes=true: sort by name or size')
  }
}, handle(args => fsSearch(args, allowedDirs)))

// ─── Tool: fs_read ────────────────────────────────────────────────────────────

server.registerTool('fs_read', {
  title: 'Read File(s)',
  description:
    'Read file contents. Pass a single path to read one file, or an array of paths to read multiple files at once. ' +
    'Text files are returned as UTF-8 strings. ' +
    'Binary files (images, audio) are returned as base64 with MIME type. ' +
    'Use head/tail to limit output for large text files.',
  inputSchema: {
    path: z.union([z.string(), z.array(z.string())])
      .describe('Single file path or array of paths to read simultaneously'),
    head: z.number().optional()
      .describe('Return only the first N lines (text files, cannot combine with tail)'),
    tail: z.number().optional()
      .describe('Return only the last N lines (text files, cannot combine with head)')
  }
}, handle(args => fsRead(args, allowedDirs)))

// ─── Tool: fs_write ───────────────────────────────────────────────────────────

server.registerTool('fs_write', {
  title: 'Write or Edit File',
  description:
    'Write or edit file contents. ' +
    'mode="overwrite" creates or fully replaces a file — use with caution. ' +
    'mode="edit" applies surgical text replacements (like a patch). ' +
    'Always use dryRun=true first with mode="edit" to preview the diff before applying changes.',
  inputSchema: {
    path: z.string()
      .describe('Path to the file to write or edit'),
    mode: z.enum(['overwrite', 'edit'])
      .describe('overwrite=create/replace entire file, edit=apply selective text patches'),
    content: z.string().optional()
      .describe('Full file content — required for mode="overwrite"'),
    edits: z.array(z.object({
      oldText: z.string().describe('Exact text to find and replace'),
      newText: z.string().describe('Replacement text')
    })).optional()
      .describe('List of text patches — required for mode="edit"'),
    dryRun: z.boolean().optional()
      .describe('For mode="edit": preview the diff without applying changes (default: false). Always use true first.')
  }
}, handle(args => fsWrite(args, allowedDirs)))

// ─── Tool: fs_manage ──────────────────────────────────────────────────────────

server.registerTool('fs_manage', {
  title: 'Manage Files & Directories',
  description:
    'Manage filesystem structure. ' +
    'action="mkdir" creates a directory (creates parent dirs automatically, safe to call if it already exists). ' +
    'action="move" moves or renames a file or directory.',
  inputSchema: {
    action: z.enum(['mkdir', 'move'])
      .describe('mkdir=create directory, move=move or rename'),
    path: z.string()
      .describe('Target path for "mkdir", or source path for "move"'),
    destination: z.string().optional()
      .describe('Destination path — required for "move" action')
  }
}, handle(args => fsManage(args, allowedDirs)))

// ─── Start ────────────────────────────────────────────────────────────────────

const main = async () => {
  await server.connect(new StdioServerTransport())
  const exit = async () => { await server.close(); process.exit(0) }
  process.on('SIGINT', exit)
  process.on('SIGTERM', exit)
}

main().catch(e => { console.error('Server error:', e); process.exit(1) })
