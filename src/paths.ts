import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// paths.ts sits at the source/dist root, so resolving relative to this file is
// right however deep the importer is. The build copies src/templates and
// src/runtime (minus .ts) beside the compiled output.
const ROOT = dirname(fileURLToPath(import.meta.url));

/** Bundled template assets (identity polyfill, page bridge scripts). */
export const TEMPLATE_DIR = join(ROOT, "templates");
/** Bundled runtime JS read at conversion time (the compat shim, debug ring). */
export const RUNTIME_DIR = join(ROOT, "runtime");
/** Package root, where package.json lives. */
export const PACKAGE_ROOT = join(ROOT, "..");
