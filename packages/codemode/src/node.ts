/**
 * Node.js entry point.
 *
 * Kept separate from the root entry so Workers bundles never pull in
 * `node:child_process`.
 */
export {
  NodeExecutor,
  type NodeExecutorOptions
} from "./node-executor";
