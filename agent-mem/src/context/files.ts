// Extensions that mark a token as a file; without this list, prose like "Date.now" or "data.id" would be indexed
const FILE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sh", "bash", "zsh", "sql", "md", "mdx", "json", "jsonl", "yaml", "yml", "toml", "ini", "xml", "html", "css", "scss", "vue",
  "svelte", "lock", "txt", "ipynb", "template", "proto", "tf", "gradle", "dart", "lua", "ex", "exs",
]);

// A path-like token that is not the tail of a URL or of a longer word
const PATH_RE = /(?<![\w/:.@-])(~?\/?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?![\w/])/g;

const MAX_PATHS = 50;

/** File paths mentioned in free text or serialized tool arguments, in order of first appearance. */
export function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(PATH_RE)) {
    const path = match[1];
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (!FILE_EXTENSIONS.has(extension)) continue;
    paths.add(path);
    if (paths.size >= MAX_PATHS) break;
  }
  return [...paths];
}
